import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TasteProfile } from '../../types/ipc'

const mocks = vi.hoisted(() => ({
  prepare: vi.fn(),
  updateRun: vi.fn(() => ({ changes: 1 })),
  insertRun: vi.fn(() => ({ changes: 1 })),
  endRun: vi.fn(() => ({ changes: 1 })),
  saveTasteProfile: vi.fn((profile: TasteProfile) => profile),
  clearRecommendationCache: vi.fn(),
}))

vi.mock('../db', () => ({
  getDb: vi.fn(() => ({
    prepare: mocks.prepare,
  })),
}))

vi.mock('../db/conversations', () => ({
  loadRecentConversations: vi.fn(() => []),
  loadTodayConversations: vi.fn(() => []),
}))

vi.mock('../db/feedback', () => ({
  getFeedbackSignalCount: vi.fn(() => 0),
  listProfileTrackFeedback: vi.fn(() => []),
  listTrackFeedback: vi.fn(() => []),
  listTrackFeedbackUpdatedSince: vi.fn(() => []),
}))

vi.mock('../db/playlists', () => ({
  getAllImportedTracks: vi.fn(() => []),
}))

vi.mock('../db/recommendationCache', () => ({
  clearRecommendationCache: mocks.clearRecommendationCache,
}))

vi.mock('../db/semantics', () => ({
  getTrackSemantic: vi.fn(() => null),
  listSemantics: vi.fn(() => []),
  semanticTrackKey: vi.fn((track) => `${track.title}::${track.artist}`),
}))

vi.mock('../db/tracks', () => ({
  isExternalListeningSource: vi.fn(() => false),
  loadProfileTrackEvents: vi.fn(() => []),
  loadProfileTrackEventsBetween: vi.fn(() => []),
}))

vi.mock('../db/taste', () => ({
  addTasteQuestion: vi.fn(),
  answerTasteQuestion: vi.fn(),
  getPendingQuestions: vi.fn(() => []),
  getTasteProfile: vi.fn(() => ({
    echo_portrait: '我还在观察你。',
    genres: [],
    artists: [],
    moods: [],
    discovery_appetite: 0.5,
    anti_patterns: [],
    signature_tracks: [],
    profile_meta: {},
  })),
  saveTasteProfile: mocks.saveTasteProfile,
}))

vi.mock('../db/settings', () => ({
  getSettings: vi.fn(() => ({ meta: { firstUsedAt: '2026-06-01T00:00:00.000Z' } })),
}))

vi.mock('../db/yinyi', () => ({
  getYinyiRange: vi.fn(() => []),
}))

vi.mock('../llm/client', () => ({
  completeChat: vi.fn(),
  LlmError: class LlmError extends Error {},
}))

vi.mock('../llm/promptData', () => ({
  escapePromptData: vi.fn((value: string) => value),
  safePromptJson: vi.fn((value: unknown) => JSON.stringify(value)),
}))

vi.mock('../utils/paths', () => ({
  readRootFile: vi.fn(() => '{}'),
}))

vi.mock('../skills/soul/policy', () => ({
  buildSoulPolicyPrompt: vi.fn(() => ''),
}))

vi.mock('./semantics', () => ({
  inferTrackSemanticFallback: vi.fn(() => ({ genres: [], moods: [], energy: 0.5, tempo: 'medium' })),
}))

vi.mock('./memoryEvidence', () => ({
  buildMemoryEvidencePrompt: vi.fn(() => ''),
  formatAvoidedPattern: vi.fn(() => null),
}))

vi.mock('./recommendation/intent', () => ({
  parseIntent: vi.fn(() => ({ moods: [], scenes: [] })),
}))

import { applySignal, tasteTestHelpers } from './taste'

describe('taste event signal lifecycle', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.updateRun.mockReturnValue({ changes: 1 })
    mocks.insertRun.mockReturnValue({ changes: 1 })
    mocks.endRun.mockReturnValue({ changes: 1 })
    mocks.prepare.mockImplementation((sql: string) => {
      if (sql.includes('UPDATE events') && sql.includes("kind = 'context'") && sql.includes('SET confidence')) {
        return { run: mocks.updateRun }
      }
      if (sql.includes('INSERT INTO events') && sql.includes("'context'")) {
        return { run: mocks.insertRun }
      }
      if (sql.includes('UPDATE events') && sql.includes('SET expected_end_at')) {
        return { run: mocks.endRun }
      }
      return { run: vi.fn(() => ({ changes: 1 })), get: vi.fn(), all: vi.fn(() => []) }
    })
  })

  it('refreshes an active context event instead of inserting duplicates', async () => {
    await applySignal('event_started', {
      target: '觉得有点冷',
      confidence: 0.64,
      weight: 0.32,
    })

    expect(mocks.updateRun).toHaveBeenCalledWith(0.64, 0.32, '觉得有点冷')
    expect(mocks.insertRun).not.toHaveBeenCalled()
    expect(mocks.saveTasteProfile).not.toHaveBeenCalled()
    const updateSql = mocks.prepare.mock.calls.map(([sql]) => String(sql)).find((sql) => sql.includes('SET confidence'))
    expect(updateSql).toContain(`+${tasteTestHelpers.CONTEXT_EVENT_TTL_HOURS} hours`)
  })

  it('inserts a new context event with a short expiry when no active row exists', async () => {
    mocks.updateRun.mockReturnValueOnce({ changes: 0 })

    await applySignal('event_started', {
      target: '觉得有点冷',
      confidence: 0.64,
      weight: 0.32,
    })

    expect(mocks.insertRun).toHaveBeenCalledWith('觉得有点冷', 0.64, 0.32)
    expect(mocks.saveTasteProfile).not.toHaveBeenCalled()
    const insertSql = mocks.prepare.mock.calls.map(([sql]) => String(sql)).find((sql) => sql.includes('INSERT INTO events'))
    expect(insertSql).toContain('expected_end_at')
    expect(insertSql).toContain(`+${tasteTestHelpers.CONTEXT_EVENT_TTL_HOURS} hours`)
  })

  it('can end future-expiring context events', async () => {
    await applySignal('event_ended', { target: '有点冷' })

    const endSql = mocks.prepare.mock.calls.map(([sql]) => String(sql)).find((sql) => sql.includes('SET expected_end_at'))
    expect(endSql).toContain("kind = 'context'")
    expect(endSql).toContain("expected_end_at IS NULL OR expected_end_at > datetime('now', 'localtime')")
    expect(mocks.endRun).toHaveBeenCalledWith('%有点冷%')
    expect(mocks.saveTasteProfile).not.toHaveBeenCalled()
  })
})
