import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  completeChat: vi.fn(),
  insertLearnedCase: vi.fn(),
  corroborateLearnedCase: vi.fn(),
  setLearnedCaseStatus: vi.fn(),
  listLearnedCases: vi.fn((): Array<Record<string, unknown>> => []),
  pruneDecayedLearnedCases: vi.fn(() => 0),
  enforceLearnedCasesLimit: vi.fn(() => 0),
}))

vi.mock('../../llm/client', () => ({
  completeChat: mocks.completeChat,
}))

vi.mock('../../db/learnedCases', () => ({
  insertLearnedCase: mocks.insertLearnedCase,
  corroborateLearnedCase: mocks.corroborateLearnedCase,
  setLearnedCaseStatus: mocks.setLearnedCaseStatus,
  listLearnedCases: mocks.listLearnedCases,
  pruneDecayedLearnedCases: mocks.pruneDecayedLearnedCases,
  enforceLearnedCasesLimit: mocks.enforceLearnedCasesLimit,
  learnedCaseFingerprint: (record: { kind: string; learned: Record<string, unknown> }) =>
    `${record.kind}::${Object.keys(record.learned).sort().map((key) => `${key}=${record.learned[key]}`).join('|')}`,
  LEARNED_CASES_ACTIVE_LIMIT: 50,
}))

vi.mock('../../db/conversations', () => ({
  loadConversationsForDate: vi.fn(() => [
    { id: 1, role: 'user', content: '不是这首，我要陈默之的原唱版本', createdAt: '' },
    { id: 2, role: 'assistant', content: '好的，我重新找原唱。', createdAt: '' },
  ]),
}))

vi.mock('../../db/settings', () => ({
  getSettings: vi.fn(() => ({
    llm: { baseUrl: 'https://x', apiKey: 'k', model: 'm' },
  })),
}))

import { runDreamReview } from './review'

const GOOD_EVENTS = JSON.stringify({
  events: [{
    kind: 'entity_correction',
    trigger_text: '不是这首，我要原唱',
    learned: { expectArtistQuery: '陈默之', expectSeedTitle: null, note: '用户要原唱版本' },
    evidence_quotes: ['不是这首', '原唱版本'],
    confidence: 0.92,
  }],
})

beforeEach(() => {
  mocks.completeChat.mockReset()
  mocks.insertLearnedCase.mockClear()
  mocks.corroborateLearnedCase.mockClear()
  mocks.setLearnedCaseStatus.mockClear()
  mocks.listLearnedCases.mockReset().mockReturnValue([])
})

describe('dream review pipeline', () => {
  it('inserts an active case for a grounded explicit correction', async () => {
    mocks.completeChat.mockResolvedValue(GOOD_EVENTS)
    const result = await runDreamReview('2026-08-16')
    expect(result.status).toBe('completed')
    expect(result.inserted).toBe(1)
    expect(mocks.insertLearnedCase).toHaveBeenCalledTimes(1)
    const call = mocks.insertLearnedCase.mock.calls[0][0]
    expect(call.status).toBe('active')
    expect(call.kind).toBe('entity_correction')
    expect(call.evidence.quotes).toEqual(['不是这首', '原唱版本'])
  })

  it('writes nothing when the LLM fails or returns junk', async () => {
    mocks.completeChat.mockRejectedValue(new Error('timeout'))
    expect((await runDreamReview('2026-08-16')).status).toBe('failed')
    expect(mocks.insertLearnedCase).not.toHaveBeenCalled()

    mocks.completeChat.mockResolvedValue('完全不是 JSON')
    expect((await runDreamReview('2026-08-16')).status).toBe('completed')
    expect(mocks.insertLearnedCase).not.toHaveBeenCalled()
  })

  it('drops events whose evidence quotes are fabricated', async () => {
    mocks.completeChat.mockResolvedValue(JSON.stringify({
      events: [{
        kind: 'entity_correction',
        trigger_text: '换个歌手',
        learned: { expectArtistQuery: '周深' },
        evidence_quotes: ['用户明确要求更换歌手'],   // 不在对话原文中
        confidence: 0.95,
      }],
    }))
    const result = await runDreamReview('2026-08-16')
    expect(result.inserted).toBe(0)
    expect(mocks.insertLearnedCase).not.toHaveBeenCalled()
  })

  it('corroborates instead of duplicating an existing identical case', async () => {
    mocks.completeChat.mockResolvedValue(GOOD_EVENTS)
    mocks.listLearnedCases.mockReturnValue([{
      id: 'case-1',
      kind: 'entity_correction',
      triggerText: '不是这首，我要原唱',
      learned: { expectArtistQuery: '陈默之', expectSeedTitle: null, note: '用户要原唱版本' },
      evidence: { conversationIds: [1], quotes: ['不是这首'], sourceDate: '2026-08-15' },
      confidence: 0.92,
      status: 'active',
      corroborations: 1,
      sourceDate: '2026-08-15',
      createdAt: '', updatedAt: '',
    }])
    const result = await runDreamReview('2026-08-16')
    expect(result.corroborated).toBe(1)
    expect(mocks.corroborateLearnedCase).toHaveBeenCalledWith('case-1')
    expect(mocks.insertLearnedCase).not.toHaveBeenCalled()
  })

  it('keeps low-confidence extractions pending instead of active', async () => {
    mocks.completeChat.mockResolvedValue(JSON.stringify({
      events: [{
        kind: 'phrasing_precedent',
        trigger_text: '随便来一首',
        learned: { expectedKind: 'artist_request' },
        evidence_quotes: ['不是这首'],
        confidence: 0.7,
      }],
    }))
    await runDreamReview('2026-08-16')
    expect(mocks.insertLearnedCase.mock.calls[0][0].status).toBe('pending')
  })
})
