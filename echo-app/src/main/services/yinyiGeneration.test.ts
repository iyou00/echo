import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  completeChat: vi.fn(),
  upsertYinyi: vi.fn((entry) => entry),
  recordHealth: vi.fn(),
}))

vi.mock('../llm/client', () => ({
  completeChat: mocks.completeChat,
  LlmError: class LlmError extends Error {
    constructor(message: string, public kind: string) {
      super(message)
    }
  },
}))

vi.mock('../db/conversations', () => ({
  loadConversationsForDate: vi.fn(() => [{
    id: 1,
    role: 'user',
    content: '你觉得人要如何爱人？',
    createdAt: '2026-08-10T08:17:00+08:00',
  }]),
  loadUserConversationsForDate: vi.fn(() => [{
    id: 1,
    role: 'user',
    content: '你觉得人要如何爱人？',
    createdAt: '2026-08-10T08:17:00+08:00',
  }]),
}))

vi.mock('../db/tracks', () => ({
  isExternalListeningSource: vi.fn(() => false),
  loadMeaningfulTrackEventsForDate: vi.fn(() => []),
}))

vi.mock('../db/agentActions', () => ({
  listExecutedActionItemIdsForDate: vi.fn(() => new Set()),
}))

vi.mock('../db/yinyi', () => ({
  getRandomYinyi: vi.fn(() => null),
  getYinyiByDate: vi.fn(() => null),
  getYinyiRange: vi.fn(() => []),
  upsertYinyi: mocks.upsertYinyi,
}))

vi.mock('../db/settings', () => ({
  getSettings: vi.fn(() => ({
    user: { city: '长沙' },
    llm: { baseUrl: 'https://example.com/v1', apiKey: 'key', model: 'test-model' },
  })),
}))

vi.mock('../weather/client', () => ({
  getWeather: vi.fn(async () => ({ summary: '小雨 23°C' })),
}))

vi.mock('./health', () => ({
  recordHealth: mocks.recordHealth,
}))

vi.mock('./memorySourceGuard', () => ({
  hasMemorySourceLeak: vi.fn(() => false),
}))

import { generateYinyi } from './yinyi'

const directorBrief = JSON.stringify({
  anchorEvidenceIds: ['conversation:1'],
  supportingEvidenceIds: [],
  emotionalThread: '一个没有答完的问题',
  echoStance: 'curious',
  narrativeShape: 'unfinished_question',
  openingMode: '从问题切入',
  endingMode: '留一点空白',
  allowedInference: [],
  forbiddenClaims: ['不要替用户回答'],
  timeRelationPairs: [],
})

describe('yinyi generation orchestration', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('runs director, writer and critic before persisting an accepted letter', async () => {
    mocks.completeChat
      .mockResolvedValueOnce(directorBrief)
      .mockResolvedValueOnce('你问我人要如何爱人。\n\n我没有急着替你回答，只把这个问题留在今天。')
      .mockResolvedValueOnce('{"passed":true,"issues":[]}')

    const entry = await generateYinyi('2026-08-10')

    expect(mocks.completeChat).toHaveBeenCalledTimes(3)
    expect(entry.meta?.status).toBe('ok')
    expect(entry.meta?.evidence_ids).toEqual(['conversation:1'])
    expect(entry.meta?.style_signature?.narrativeShape).toBe('unfinished_question')
    expect(mocks.upsertYinyi).toHaveBeenCalledTimes(1)
  })

  it('fails closed to the factual fallback when the critic cannot be parsed twice', async () => {
    mocks.completeChat
      .mockResolvedValueOnce(directorBrief)
      .mockResolvedValueOnce('你问我人要如何爱人。\n\n我把这个问题留在今天。')
      .mockResolvedValueOnce('not-json')
      .mockResolvedValueOnce('你问我人要如何爱人。\n\n我还是把这个问题留在今天。')
      .mockResolvedValueOnce('still-not-json')

    const entry = await generateYinyi('2026-08-10')

    expect(mocks.completeChat).toHaveBeenCalledTimes(5)
    expect(entry.meta?.status).toBe('ok')
    expect(entry.meta?.fallback).toBe(true)
    expect(entry.content).toContain('我不替你解释')
    expect(mocks.recordHealth).toHaveBeenCalledWith('llm', 'degraded', expect.stringContaining('质检结果无法解析'))
  })

  it('retries an empty writer response instead of persisting a failed entry', async () => {
    mocks.completeChat
      .mockResolvedValueOnce(directorBrief)
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('你问我人要如何爱人。\n\n我没有急着回答，只把这个问题认真留在今天。')
      .mockResolvedValueOnce('{"passed":true,"issues":[]}')

    const entry = await generateYinyi('2026-08-10')

    expect(mocks.completeChat).toHaveBeenCalledTimes(4)
    expect(entry.meta?.status).toBe('ok')
    expect(entry.meta?.fallback).not.toBe(true)
    expect(entry.content).toContain('认真留在今天')
  })

  it('uses a factual fallback when the writer returns empty twice', async () => {
    mocks.completeChat
      .mockResolvedValueOnce(directorBrief)
      .mockResolvedValueOnce('')
      .mockResolvedValueOnce('')

    const entry = await generateYinyi('2026-08-10')

    expect(mocks.completeChat).toHaveBeenCalledTimes(3)
    expect(entry.meta?.status).toBe('ok')
    expect(entry.meta?.fallback).toBe(true)
    expect(entry.meta?.fallback_error).toBe('LLM 连续返回空内容')
    expect(mocks.recordHealth).toHaveBeenCalledWith('llm', 'degraded', expect.stringContaining('连续返回空正文'), 'LLM 连续返回空内容')
  })
})
