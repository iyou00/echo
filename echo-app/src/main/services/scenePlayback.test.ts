import { describe, expect, it, vi } from 'vitest'
import type { ActiveScene, TasteProfile, Track } from '../../types/ipc'

vi.mock('./memoryEvidence', () => ({
  buildMemoryEvidencePrompt: vi.fn(() => '<profile_memory>\n{"kind":"profile_digest"}\n</profile_memory>'),
}))

import { scenePlaybackTestHelpers } from './scenePlayback'

describe('scene playback continuation boundaries', () => {
  it('preserves an active scene when continuation search temporarily finds no playable track', () => {
    expect(scenePlaybackTestHelpers.shouldPreserveSceneOnPlaybackFailure(
      { continueSession: true },
      scenePlaybackTestHelpers.createNoPlayableTrackError(),
    )).toBe(true)
  })

  it('surfaces the initial scene start failure so the user gets feedback', () => {
    expect(scenePlaybackTestHelpers.shouldPreserveSceneOnPlaybackFailure(
      {},
      scenePlaybackTestHelpers.createNoPlayableTrackError(),
    )).toBe(false)
  })

  it('surfaces non-search failures during scene continuation', () => {
    expect(scenePlaybackTestHelpers.shouldPreserveSceneOnPlaybackFailure(
      { continueSession: true },
      new Error('network failed'),
    )).toBe(false)
  })

  it('keeps exact recently played tracks excluded when scene fallback relaxes artist diversity', () => {
    const repeated: Track = { id: 'same-song', title: '同一首', artist: '同一个人' }
    const sameArtistFresh: Track = { id: 'fresh-song', title: '另一首', artist: '同一个人' }

    const picked = scenePlaybackTestHelpers.pickSceneTracksFromPool(
      [repeated, sameArtistFresh],
      1,
      [repeated],
      [sameArtistFresh],
    )

    expect(picked).toEqual([sameArtistFresh])
  })

  it('keeps searching when the raw scene pool is full of recently used tracks', () => {
    const recent: Track[] = [
      { id: 'recent-1', title: '刚听过一', artist: '甲' },
      { id: 'recent-2', title: '刚听过二', artist: '乙' },
      { id: 'recent-3', title: '刚听过三', artist: '丙' },
    ]
    const fresh: Track[] = [
      { id: 'fresh-1', title: '新歌一', artist: '丁' },
      { id: 'fresh-2', title: '新歌二', artist: '戊' },
    ]

    expect(scenePlaybackTestHelpers.hasEnoughSceneTracksFromPool(recent, 2, recent, recent)).toBe(false)
    expect(scenePlaybackTestHelpers.hasEnoughSceneTracksFromPool([...recent, ...fresh], 2, recent, recent)).toBe(true)
  })

  it('accepts only scene lines that mention the actual first track without leaking memory internals', () => {
    const first: Track = { title: 'Wake Up', artist: 'Arcade Fire', source: 'netease' }

    expect(scenePlaybackTestHelpers.isSceneLineUsable('先从《Wake Up》开始，声音别开太大。', first)).toBe(true)
    expect(scenePlaybackTestHelpers.isSceneLineUsable('《Wake Up》你说不定会喜欢，先开小声。', first)).toBe(true)
    expect(scenePlaybackTestHelpers.isSceneLineUsable('先从这首开始，声音别开太大。', first)).toBe(false)
    expect(scenePlaybackTestHelpers.isSceneLineUsable('根据你的画像，先听《Wake Up》。', first)).toBe(false)
    expect(scenePlaybackTestHelpers.isSceneLineUsable('我记得你说过少推悲伤的歌，先听《Wake Up》。', first)).toBe(false)
    expect(scenePlaybackTestHelpers.isSceneLineUsable('我记得你喜欢这类歌，先听《Wake Up》。', first)).toBe(false)
    expect(scenePlaybackTestHelpers.isSceneLineUsable('先听《沉溺》，再接《Wake Up》。', first)).toBe(false)
  })

  it('keeps user-facing portrait copy out of scene prompt context', () => {
    const scene: ActiveScene = {
      id: 1,
      key: 'focus',
      label: '专注',
      shortLabel: '专注',
      line: '安静一点',
      prompt: '专注音乐',
      targetCount: 3,
      moods: ['安静'],
      scenes: ['工作'],
      energy: 'low',
      tempo: 'slow',
      familiarity: 'balanced',
      startedAt: '2026-06-21T09:00:00.000Z',
      expiresAt: '2026-06-21T10:00:00.000Z',
      status: 'active',
    }
    const profile: TasteProfile = {
      echo_portrait: '这是一段给用户看的画像文案，不应该直接进入场景提示。',
      work_summary: '执行摘要可以在共享记忆中被压缩使用。',
      artists: [],
      genres: [],
      moods: [],
      signature_tracks: [],
      anti_patterns: [],
      discovery_appetite: 0.5,
      profile_meta: {},
    }

    const context = scenePlaybackTestHelpers.buildSceneLineContext(
      scene,
      { title: 'Wake Up', artist: 'Arcade Fire', source: 'netease' },
      profile,
      {
        timeLabel: '上午',
        lastTrackContext: '无',
        sceneTransition: '无 → focus',
        activeEvents: [{
          kind: 'context',
          content: '有点烦',
          confidence: 0.64,
          weight: 0.32,
        }],
      },
    )

    expect(context).toContain('<profile_memory>')
    expect(context).toContain('"content": "有点烦"')
    expect(context).toContain('"scope": "today_context"')
    expect(context).toContain('只表示今天仍在发生的短期状态')
    expect(context).not.toContain('用户画像')
    expect(context).not.toContain(profile.echo_portrait)
  })
})
