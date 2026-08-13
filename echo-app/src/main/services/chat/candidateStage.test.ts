import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { SendChatResult, Track } from '../../../types/ipc'
import type { MusicEntityResolution } from '../../skills/music/entityResolver'
import { effectiveMusicSearchQuery, prepareCandidateStage } from './candidateStage'
import { classifyChatIntent } from './intent'
import { fetchRecommendationCandidates } from './recommendationCandidates'

vi.mock('./recommendationCandidates', async (importOriginal) => {
  const actual = await importOriginal<typeof import('./recommendationCandidates')>()
  return {
    ...actual,
    fetchRecommendationCandidates: vi.fn(),
  }
})

function reply(content: string, tracks: Track[] = []): SendChatResult {
  return {
    ok: true,
    message: {
      id: 1,
      role: 'assistant',
      content,
      createdAt: new Date().toISOString(),
      tracks,
    },
    tracks,
    hints: {},
  } as SendChatResult
}

describe('chat candidate stage', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('rewrites contextual artist selection into an explicit music search query', () => {
    const intent = {
      ...classifyChatIntent('你帮我挑一首'),
      kind: 'artist_request' as const,
      wantsMusic: true,
      artistQuery: '陈默之',
      targetCount: 1,
    }

    expect(effectiveMusicSearchQuery('你帮我挑一首', intent)).toBe('推荐一首陈默之的歌')
  })

  it('keeps ranking semantics when completing a contextual artist query', () => {
    const popular = classifyChatIntent('那你随便推荐几首热度高的')
    const intent = {
      ...popular,
      kind: 'artist_request' as const,
      wantsMusic: true,
      artistQuery: '陈默之',
      targetCount: 3,
      recommendationIntent: {
        ...popular.recommendationIntent,
        artistQuery: '陈默之',
      },
    }

    expect(effectiveMusicSearchQuery('那你随便推荐几首热度高的', intent))
      .toBe('推荐3首陈默之的热门歌')
  })

  it('uses the rewritten contextual artist query for candidate recall', async () => {
    vi.mocked(fetchRecommendationCandidates).mockResolvedValueOnce({
      candidates: [{
        id: 'chen-1',
        title: '沉溺',
        artist: '陈默之',
        source: 'netease',
        playUrl: 'https://example.com/chen.mp3',
      }],
      authRequired: false,
      entityResolution: {
        artistQuery: '陈默之',
        targetCount: 1,
        requestedCount: 1,
        explicitCount: false,
        entities: [],
        ambiguity: 'none',
        confidence: 0.96,
        source: 'llm',
        verificationStatus: 'verified',
      },
    })
    const intent = {
      ...classifyChatIntent('你帮我挑一首'),
      kind: 'artist_request' as const,
      wantsMusic: true,
      artistQuery: '陈默之',
      targetCount: 1,
      llmIntentOverride: {
        wantsMusic: true,
        artistQuery: '陈默之',
        targetCount: 1,
      },
    }

    const result = await prepareCandidateStage({
      trimmed: '你帮我挑一首',
      effectiveText: '你帮我挑一首',
      initialChatIntent: intent,
      pendingReply: { action: 'none' },
      pendingDirectSongReply: null,
      pendingMusicEntityReply: null,
      sessionFollowUp: { kind: 'none' },
      currentPlaybackTrack: null,
      active: {
        canceled: false,
        signal: new AbortController().signal,
      },
      signal: new AbortController().signal,
      reply,
      attachSceneToTracks: (tracks) => tracks,
    })

    expect(fetchRecommendationCandidates).toHaveBeenCalledWith(
      '推荐一首陈默之的歌',
      expect.anything(),
      expect.any(Function),
      expect.objectContaining({ artistQuery: '陈默之', wantsMusic: true }),
      expect.anything(),
    )
    expect(result.ready?.guardedCandidates).toHaveLength(1)
  })

  it('keeps llm-routed skip requests executable when playback state has no current track', async () => {
    const fresh: Track = {
      id: 'fresh',
      title: '更有劲',
      artist: '新歌手',
      source: 'netease',
      playUrl: 'https://example.com/fresh.mp3',
    }
    vi.mocked(fetchRecommendationCandidates).mockResolvedValueOnce({
      candidates: [fresh],
      authRequired: false,
    })
    const base = classifyChatIntent('换一首激情一点的')
    const intent = {
      ...base,
      kind: 'feedback_current_track' as const,
      wantsMusic: true,
      feedbackAction: 'skip' as const,
      llmIntentOverride: {
        wantsMusic: true,
        energy: 'high' as const,
        tempo: 'fast' as const,
        moods: ['清醒', '热烈'],
        targetCount: 1,
      },
    }

    const result = await prepareCandidateStage({
      trimmed: '换一首激情一点的',
      effectiveText: '换一首激情一点的',
      initialChatIntent: intent,
      pendingReply: { action: 'none' },
      pendingDirectSongReply: null,
      pendingMusicEntityReply: null,
      sessionFollowUp: { kind: 'none' },
      currentPlaybackTrack: null,
      active: {
        canceled: false,
        signal: new AbortController().signal,
      },
      signal: new AbortController().signal,
      reply,
      attachSceneToTracks: (tracks) => tracks,
    })

    expect(fetchRecommendationCandidates).toHaveBeenCalledOnce()
    expect(fetchRecommendationCandidates).toHaveBeenCalledWith(
      '换一首激情一点的',
      expect.anything(),
      expect.any(Function),
      expect.objectContaining({ kind: 'feedback_current_track', feedbackAction: 'skip', wantsMusic: true }),
      expect.anything(),
    )
    expect(result.ready?.guardedCandidates).toEqual([fresh])
  })

  it('marks rejected current-track feedback candidates for current-track exclusion', async () => {
    const current: Track = {
      id: 'current',
      title: '旧歌',
      artist: '旧歌手',
      source: 'netease',
    }
    const fresh: Track = {
      id: 'fresh',
      title: '新歌',
      artist: '新歌手',
      source: 'netease',
      playUrl: 'https://example.com/fresh.mp3',
    }
    vi.mocked(fetchRecommendationCandidates).mockResolvedValueOnce({
      candidates: [current, fresh],
      authRequired: false,
    })
    const intent = {
      ...classifyChatIntent('这首不好听，换一首', { currentTrack: current }),
      kind: 'feedback_current_track' as const,
      wantsMusic: true,
      feedbackAction: 'not_right' as const,
    }

    const result = await prepareCandidateStage({
      trimmed: '这首不好听，换一首',
      effectiveText: '这首不好听，换一首',
      initialChatIntent: intent,
      pendingReply: { action: 'none' },
      pendingDirectSongReply: null,
      pendingMusicEntityReply: null,
      sessionFollowUp: { kind: 'none' },
      currentPlaybackTrack: current,
      active: {
        canceled: false,
        signal: new AbortController().signal,
      },
      signal: new AbortController().signal,
      reply,
      attachSceneToTracks: (tracks) => tracks,
    })

    expect(result.ready?.excludeCurrentTrack).toBe(true)
    expect(result.ready?.guardedCandidates).toEqual([fresh])
  })

  it('blocks mismatched candidates for an LLM-routed direct song title', async () => {
    const wrongTrack: Track = {
      id: 'wrong',
      title: 'Sonata No. 8 in C Minor, Op. 13, "Pathetique": II. Adagio cantabile',
      artist: 'Arthur Rubinstein',
      source: 'netease',
      playUrl: 'https://example.com/wrong.mp3',
    }
    const entityResolution: MusicEntityResolution = {
      seedTitle: '枪火',
      targetCount: 1,
      requestedCount: 1,
      explicitCount: false,
      entities: [],
      ambiguity: 'missing_artist',
      confidence: 0.96,
      source: 'llm',
      verificationStatus: 'unverified',
    }
    vi.mocked(fetchRecommendationCandidates).mockResolvedValueOnce({
      candidates: [wrongTrack],
      authRequired: false,
      directSong: { seedTitle: '枪火' },
      entityResolution,
    })

    const result = await prepareCandidateStage({
      trimmed: '最近枪火这首歌蛮火的，听听看',
      effectiveText: '最近枪火这首歌蛮火的，听听看',
      initialChatIntent: classifyChatIntent('最近枪火这首歌蛮火的，听听看'),
      pendingReply: { action: 'none' },
      pendingDirectSongReply: null,
      pendingMusicEntityReply: null,
      sessionFollowUp: { kind: 'none' },
      currentPlaybackTrack: {
        id: 'current',
        title: 'Sonata No. 8 in C Minor',
        artist: 'Arthur Rubinstein',
        source: 'netease',
      },
      active: {
        canceled: false,
        signal: new AbortController().signal,
      },
      signal: new AbortController().signal,
      reply,
      attachSceneToTracks: (tracks) => tracks,
    })

    expect(result.ready).toBeUndefined()
    expect(result.reply?.tracks).toEqual([])
    expect(result.reply?.message.content).toContain('都对不上《枪火》')
  })
})
