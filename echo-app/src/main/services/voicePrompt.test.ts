import { describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  completeChat: vi.fn(async () => '我在。你先听完这一段，再决定要不要换。'),
}))

vi.mock('../llm/client', () => ({
  completeChat: mocks.completeChat,
  LlmError: class LlmError extends Error {
    constructor(message: string, public kind: string) {
      super(message)
    }
  },
}))

vi.mock('../db/settings', () => ({
  getSettings: vi.fn(() => ({
    llm: { baseUrl: 'https://example.com/v1', apiKey: 'key', model: 'model' },
  })),
}))

vi.mock('../db/conversations', () => ({
  loadRecentConversations: vi.fn(() => [
    { role: 'user', content: '今天别太吵。' },
  ]),
}))

vi.mock('../db/tracks', () => ({
  isExternalListeningSource: vi.fn((source) => Boolean(source && source !== 'recommended_by_echo')),
  isMeaningfulSkippedReason: vi.fn((reason) => !reason || reason === 'playback_skipped' || reason === 'explicit_feedback'),
  loadMeaningfulTrackEventsForDate: vi.fn(() => [
    {
      title: '听完的歌',
      artist: 'Echo',
      listenedAt: '2026-06-17 09:00:00',
      source: 'recommended_by_echo',
      queueStatus: 'completed',
    },
    {
      title: '放下的歌',
      artist: 'Echo',
      listenedAt: '2026-06-17 09:20:00',
      source: 'recommended_by_echo',
      queueStatus: 'skipped',
      queueStatusReason: 'explicit_feedback',
    },
  ]),
}))

vi.mock('../db/taste', () => ({
  getTasteProfile: vi.fn(() => ({
    echo_portrait: '我还在观察你。',
    genres: [],
    artists: [],
    moods: [],
    anti_patterns: [],
    signature_tracks: [],
    discovery_appetite: 0.5,
  })),
}))

vi.mock('./memoryEvidence', () => ({
  buildMemoryEvidencePrompt: vi.fn(() => '<memory_evidence_contract>\n用户明确纠正是最高优先级证据\n</memory_evidence_contract>\n<user_corrections>\n{"content":"我不喜欢电子音墙，少推一点"}\n</user_corrections>\n<profile_memory>\n{"kind":"profile_digest"}\n</profile_memory>'),
}))

vi.mock('./health', () => ({
  recordHealth: vi.fn(),
}))

vi.mock('../skills/soul/policy', () => ({
  buildSoulPolicyPrompt: vi.fn(() => '<soul_policy>Echo 是 AI 音乐伴侣。</soul_policy>'),
}))

import { completeChat } from '../llm/client'
import { generateVoiceLine } from './voice'

describe('voice prompt memory evidence', () => {
  it('passes user corrections and separates dismissed tracks in the voice prompt', async () => {
    await generateVoiceLine()

    const messages = vi.mocked(completeChat).mock.calls[0]?.[1] ?? []
    const userContent = messages.find((message) => message.role === 'user')?.content ?? ''

    expect(userContent).toContain('<user_corrections>')
    expect(userContent).toContain('<profile_memory>')
    expect(userContent).toContain('我不喜欢电子音墙，少推一点')
    expect(userContent).toContain('"positiveTracks"')
    expect(userContent).toContain('听完的歌 - Echo · completed')
    expect(userContent).toContain('"dismissedTracks"')
    expect(userContent).toContain('放下的歌 - Echo · explicit_feedback')
  })
})
