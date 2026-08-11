import { describe, expect, it, vi } from 'vitest'
import type { SendChatResult, Settings, Track } from '../../../types/ipc'
import { parseRequestedTrackCount } from '../recommendation'
import { classifyFallbackChatIntent } from './intent'
import { runRecommendationResponseStage } from './responseStage'
import { streamChatReply } from './responseStream'

vi.mock('./responseStream', () => ({
  fallbackRecommendationContent: vi.fn((tracks: Track[]) => `先放${tracks[0]?.title ?? '这首'}`),
  friendlyError: vi.fn(() => '这次没接上。'),
  recordChatStreamError: vi.fn(),
  sanitizeAssistantOutput: vi.fn((content: string) => content),
  streamChatReply: vi.fn(async () => '这首《沉溺》前奏轻，先听，不合适再换。'),
}))

vi.mock('../tasteQuestionScheduler', () => ({
  generateDynamicTasteQuestions: vi.fn(),
  pickTasteFollowUpQuestion: vi.fn(() => null),
  recordFollowUpQuestionAsked: vi.fn(),
}))

vi.mock('./pendingIntents', () => ({
  clearPendingDirectSongState: vi.fn(),
}))

vi.mock('./sessionContext', () => ({
  armChatMusicSessionAffirmation: vi.fn(),
  clearChatMusicSession: vi.fn(),
  inferSessionAffirmationAction: vi.fn(() => undefined),
  rememberChatMusicSession: vi.fn(),
}))

const settings = {
  llm: { provider: 'openai', baseUrl: '', apiKey: '', model: '' },
} as unknown as Settings

function reply(content: string, tracks: Track[] = []): SendChatResult {
  return {
    message: {
      id: 1,
      role: 'assistant',
      content,
      createdAt: '2026-06-22T00:00:00.000Z',
      tracks,
    },
    tracks,
  }
}

describe('chat recommendation response stage', () => {
  it('preserves companion copy while binding the real candidate card', async () => {
    vi.mocked(streamChatReply).mockResolvedValueOnce('这首前奏一出来就挺适合现在，先听听看。')
    const candidate: Track = {
      id: 'real-candidate',
      title: '热烈一点',
      artist: '新歌手',
      source: 'netease',
      playUrl: 'https://example.com/real.mp3',
    }
    const recommendationIntent = classifyFallbackChatIntent('你帮我挑一首歌')
    const result = await runRecommendationResponseStage({
      trimmed: '你帮我挑一首歌',
      settings,
      active: { signal: new AbortController().signal, canceled: false },
      signal: new AbortController().signal,
      pendingReply: { action: 'none' },
      candidate: {
        recommendationIntent,
        requested: parseRequestedTrackCount('你帮我挑一首歌'),
        targetCount: 1,
        countExplicit: false,
        guardedCandidates: [candidate],
        authRequired: false,
        excludeCurrentTrack: false,
      },
      currentPlaybackTrack: null,
      emitChunk: vi.fn(),
      reply,
      attachSceneToTracks: (tracks) => tracks,
    })

    expect(result.tracks).toEqual([candidate])
    expect(result.message.content).toBe('这首前奏一出来就挺适合现在，先听听看。')
  })

  it('falls back to real candidates when the assistant text names a track outside the candidate pool', async () => {
    const candidate: Track = {
      id: 'real-candidate',
      title: '真正候选',
      artist: '候选歌手',
      source: 'netease',
      playUrl: 'https://example.com/real.mp3',
    }
    const recommendationIntent = classifyFallbackChatIntent('你帮我挑一首歌')
    const result = await runRecommendationResponseStage({
      trimmed: '你帮我挑一首歌',
      settings,
      active: { signal: new AbortController().signal, canceled: false },
      signal: new AbortController().signal,
      pendingReply: { action: 'none' },
      candidate: {
        recommendationIntent,
        requested: parseRequestedTrackCount('你帮我挑一首歌'),
        targetCount: 1,
        countExplicit: false,
        guardedCandidates: [candidate],
        authRequired: false,
        excludeCurrentTrack: false,
      },
      currentPlaybackTrack: null,
      emitChunk: vi.fn(),
      reply,
      attachSceneToTracks: (tracks) => tracks,
    })

    expect(result.tracks).toEqual([candidate])
    expect(result.message.content).toBe('行，先放候选歌手的《真正候选》。先听开头。')
  })

  it('keeps natural copy when a contextual music search has candidates but the inherited intent is weak', async () => {
    vi.mocked(streamChatReply).mockResolvedValueOnce('这首前奏轻，先听，不合适再换。')
    const candidate: Track = {
      id: 'chen-moni',
      title: '沉溺',
      artist: '陈默之',
      source: 'netease',
      playUrl: 'https://example.com/chen.mp3',
    }
    const recommendationIntent = classifyFallbackChatIntent('你帮我挑一首')
    const result = await runRecommendationResponseStage({
      trimmed: '你帮我挑一首',
      settings,
      active: { signal: new AbortController().signal, canceled: false },
      signal: new AbortController().signal,
      pendingReply: { action: 'none' },
      candidate: {
        recommendationIntent,
        requested: parseRequestedTrackCount('你帮我挑一首'),
        targetCount: 1,
        countExplicit: false,
        guardedCandidates: [candidate],
        authRequired: false,
        excludeCurrentTrack: false,
      },
      currentPlaybackTrack: null,
      emitChunk: vi.fn(),
      reply,
      attachSceneToTracks: (tracks) => tracks,
    })

    expect(result.tracks).toEqual([candidate])
    expect(result.message.content).toBe('这首前奏轻，先听，不合适再换。')
  })

  it('attaches a card when the assistant accepts a contextual pick without naming the song', async () => {
    vi.mocked(streamChatReply).mockResolvedValueOnce('这首前奏轻，先听，不合适再换。')
    const candidate: Track = {
      id: 'chen-moni',
      title: '沉溺',
      artist: '陈默之',
      source: 'netease',
      playUrl: 'https://example.com/chen.mp3',
    }
    const recommendationIntent = {
      ...classifyFallbackChatIntent('你帮我找一首'),
      kind: 'artist_request' as const,
      wantsMusic: true,
      artistQuery: '陈默之',
      targetCount: 1,
    }
    const result = await runRecommendationResponseStage({
      trimmed: '你帮我找一首',
      settings,
      active: { signal: new AbortController().signal, canceled: false },
      signal: new AbortController().signal,
      pendingReply: { action: 'none' },
      candidate: {
        recommendationIntent,
        requested: parseRequestedTrackCount('你帮我找一首'),
        targetCount: 1,
        countExplicit: false,
        guardedCandidates: [candidate],
        authRequired: false,
        excludeCurrentTrack: false,
      },
      currentPlaybackTrack: null,
      emitChunk: vi.fn(),
      reply,
      attachSceneToTracks: (tracks) => tracks,
    })

    expect(result.tracks).toEqual([candidate])
    expect(result.message.tracks).toEqual([candidate])
    expect(result.message.content).toBe('这首前奏轻，先听，不合适再换。')
  })

  it('returns the requested cards without replacing a human response with a track roll call', async () => {
    const companionCopy = '最近心情一直不太好，就别逼自己一直绷着，适当摸会儿鱼也可以。先歇一下，我给你找了 3 首偏轻松的，听着缓一缓。'
    vi.mocked(streamChatReply).mockResolvedValueOnce(companionCopy)
    const candidates: Track[] = [
      { id: 'first', title: '第一首', artist: '候选歌手', source: 'netease', playUrl: 'https://example.com/first.mp3' },
      { id: 'second', title: '第二首', artist: '另一位', source: 'netease', playUrl: 'https://example.com/second.mp3' },
      { id: 'third', title: '第三首', artist: '第三位', source: 'netease', playUrl: 'https://example.com/third.mp3' },
    ]
    const text = '最近心情不好，你推荐3首歌给我听。'
    const recommendationIntent = classifyFallbackChatIntent(text)
    const result = await runRecommendationResponseStage({
      trimmed: text,
      settings,
      active: { signal: new AbortController().signal, canceled: false },
      signal: new AbortController().signal,
      pendingReply: { action: 'none' },
      candidate: {
        recommendationIntent,
        requested: parseRequestedTrackCount(text),
        targetCount: 3,
        countExplicit: true,
        guardedCandidates: candidates,
        authRequired: false,
        excludeCurrentTrack: false,
      },
      currentPlaybackTrack: null,
      emitChunk: vi.fn(),
      reply,
      attachSceneToTracks: (tracks) => tracks,
    })

    expect(result.tracks).toEqual(candidates)
    expect(result.message.content).toBe(companionCopy)
  })

  it('uses the requested count and current mood when both model attempts return empty', async () => {
    vi.mocked(streamChatReply).mockResolvedValueOnce('')
    const candidates: Track[] = [
      { id: 'first', title: '第一首', artist: '候选歌手', source: 'netease', playUrl: 'https://example.com/first.mp3' },
      { id: 'second', title: '第二首', artist: '另一位', source: 'netease', playUrl: 'https://example.com/second.mp3' },
      { id: 'third', title: '第三首', artist: '第三位', source: 'netease', playUrl: 'https://example.com/third.mp3' },
    ]
    const text = '最近心情不好，你推荐3首歌给我听。'
    const recommendationIntent = classifyFallbackChatIntent(text)
    const result = await runRecommendationResponseStage({
      trimmed: text,
      settings,
      active: { signal: new AbortController().signal, canceled: false },
      signal: new AbortController().signal,
      pendingReply: { action: 'none' },
      candidate: {
        recommendationIntent,
        requested: parseRequestedTrackCount(text),
        targetCount: 3,
        countExplicit: true,
        guardedCandidates: candidates,
        authRequired: false,
        excludeCurrentTrack: false,
      },
      currentPlaybackTrack: null,
      emitChunk: vi.fn(),
      reply,
      attachSceneToTracks: (tracks) => tracks,
    })

    expect(result.tracks).toEqual(candidates)
    expect(result.message.content).toContain('心情不好')
    expect(result.message.content).toContain('3首')
    expect(result.message.content).not.toBe('我先给你挑这首。')
  })

  it('keeps the rejected current track out of card fallback candidates', async () => {
    vi.mocked(streamChatReply).mockResolvedValueOnce('那就先放旧歌手的《旧歌》。')
    const current: Track = { id: 'current', title: '旧歌', artist: '旧歌手', source: 'netease', playUrl: 'https://example.com/current.mp3' }
    const fresh: Track = { id: 'fresh', title: '新歌', artist: '新歌手', source: 'netease', playUrl: 'https://example.com/fresh.mp3' }
    const recommendationIntent = {
      ...classifyFallbackChatIntent('这首不好听，换一首', { currentTrack: current }),
      kind: 'feedback_current_track' as const,
      feedbackAction: 'not_right' as const,
      wantsMusic: true,
    }

    const result = await runRecommendationResponseStage({
      trimmed: '这首不好听，换一首',
      settings,
      active: { signal: new AbortController().signal, canceled: false },
      signal: new AbortController().signal,
      pendingReply: { action: 'none' },
      candidate: {
        recommendationIntent,
        requested: parseRequestedTrackCount('这首不好听，换一首'),
        targetCount: 1,
        countExplicit: false,
        guardedCandidates: [current, fresh],
        authRequired: false,
        excludeCurrentTrack: true,
      },
      currentPlaybackTrack: current,
      emitChunk: vi.fn(),
      reply,
      attachSceneToTracks: (tracks) => tracks,
    })

    expect(result.tracks).toEqual([fresh])
    expect(result.message.content).toContain('新歌手的《新歌》')
    expect(result.message.content).not.toContain('旧歌手的《旧歌》')
  })

  it('does not attach an unplayable candidate to a playback commitment', async () => {
    vi.mocked(streamChatReply).mockResolvedValueOnce('这首前奏很贴，现在先听听看。')
    const candidate: Track = {
      id: 'preview-only',
      title: '只有信息的歌',
      artist: '信息歌手',
      source: 'netease',
    }
    const recommendationIntent = classifyFallbackChatIntent('推荐一首歌')
    const result = await runRecommendationResponseStage({
      trimmed: '推荐一首歌',
      settings,
      active: { signal: new AbortController().signal, canceled: false },
      signal: new AbortController().signal,
      pendingReply: { action: 'none' },
      candidate: {
        recommendationIntent,
        requested: parseRequestedTrackCount('推荐一首歌'),
        targetCount: 1,
        countExplicit: false,
        guardedCandidates: [candidate],
        authRequired: false,
        excludeCurrentTrack: false,
      },
      currentPlaybackTrack: null,
      emitChunk: vi.fn(),
      reply,
      attachSceneToTracks: (tracks) => tracks,
    })

    expect(result.tracks).toEqual([])
    expect(result.message.tracks).toEqual([])
    expect(result.message.content).toBe('我刚才没拿到能播放的版本，这次先不乱报歌名。你再让我挑一次，我直接把歌放出来。')
  })
})
