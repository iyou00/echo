import { describe, expect, it, vi } from 'vitest'
import type { ActiveScene, TasteProfile, Track } from '../../types/ipc'
import { shouldResetSceneDirection } from './sceneJourney'

vi.mock('./memoryEvidence', () => ({
  buildMemoryEvidencePrompt: vi.fn(() => '<profile_memory>\n{"kind":"profile_digest"}\n</profile_memory>'),
}))

import { scenePlaybackTestHelpers } from './scenePlayback'

describe('scene playback continuation boundaries', () => {
  it('speaks on scene entry but keeps ordinary continuation and refill quiet', () => {
    expect(scenePlaybackTestHelpers.shouldAppendSceneChatMessage({ appendChatMessage: true })).toBe(true)
    expect(scenePlaybackTestHelpers.shouldAppendSceneChatMessage({ appendChatMessage: true, continueSession: true })).toBe(false)
    expect(scenePlaybackTestHelpers.shouldAppendSceneChatMessage({ appendChatMessage: true, enqueueOnly: true })).toBe(false)
  })

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

  it('widens scene recall only on the final retry', () => {
    expect(scenePlaybackTestHelpers.shouldRespectSceneSearchCooldown(0)).toBe(true)
    expect(scenePlaybackTestHelpers.shouldRespectSceneSearchCooldown(1)).toBe(true)
    expect(scenePlaybackTestHelpers.shouldRespectSceneSearchCooldown(2)).toBe(false)
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

  it('allows teasing only for repeated sleepy scenes outside serious context', () => {
    const sleepy: ActiveScene = {
      id: 2, key: 'sleepy', label: '有点困', shortLabel: '有点困', line: '提神', prompt: '提神', targetCount: 3,
      moods: ['清醒'], scenes: ['下午工作'], energy: 'high', tempo: 'medium', familiarity: 'balanced',
      startedAt: '2026-08-11T07:00:00.000Z', expiresAt: '2026-08-11T09:00:00.000Z', status: 'active',
    }
    const first: Track = { title: 'Wake Up', artist: 'Arcade Fire', sceneJourneyRole: 'transition' }

    expect(scenePlaybackTestHelpers.sceneLineBrief(sleepy, first, 2, [])).toMatchObject({ stance: 'playful', mayTease: true })
    expect(scenePlaybackTestHelpers.sceneLineBrief(sleepy, first, 2, [{ kind: 'context', content: '今天真的撑不住了' }])).toMatchObject({ stance: 'warm', mayTease: false })
    expect(scenePlaybackTestHelpers.sceneLineBrief(sleepy, first, 2, [{ kind: 'context', content: '家里有些事情要处理' }])).toMatchObject({ stance: 'warm', mayTease: false })
  })

  it('orders scene outcomes by their actual event time before judging recent misses', () => {
    const outcomes: Track[] = [
      { id: 'old-miss-1', title: '旧跳过一', artist: '甲', queueStatus: 'skipped', queueStatusAt: '2026-08-09T08:00:00.000Z' },
      { id: 'new-complete', title: '刚听完', artist: '乙', queueStatus: 'completed', queueStatusAt: '2026-08-11T08:00:00.000Z' },
      { id: 'old-miss-2', title: '旧跳过二', artist: '丙', queueStatus: 'skipped', queueStatusAt: '2026-08-09T07:00:00.000Z' },
      { id: 'new-complete-2', title: '刚听完二', artist: '丁', queueStatus: 'completed', queueStatusAt: '2026-08-11T07:00:00.000Z' },
    ]

    const ordered = scenePlaybackTestHelpers.orderedUniqueSceneOutcomes(outcomes)
    expect(ordered.map((track) => track.id)).toEqual([
      'new-complete', 'new-complete-2', 'old-miss-1', 'old-miss-2',
    ])
    expect(shouldResetSceneDirection(ordered)).toBe(false)
  })

  it('reports no playable continuation when every enqueue fails', async () => {
    const tracks: Track[] = [
      { id: '1', title: '一', artist: '甲' },
      { id: '2', title: '二', artist: '乙' },
    ]
    const failed: Track[] = []
    const enqueued = await scenePlaybackTestHelpers.enqueueSceneTrackBatch(
      tracks,
      vi.fn(async () => { throw new Error('unplayable') }),
      (track) => failed.push(track),
    )

    expect(enqueued).toEqual([])
    expect(failed).toEqual(tracks)
  })

  it('returns only playable tracks when a refill partly succeeds', async () => {
    const tracks: Track[] = [
      { id: 'bad', title: '坏链接', artist: '甲' },
      { id: 'good', title: '能播放', artist: '乙' },
    ]
    const enqueueTrack = vi.fn(async (track: Track) => {
      if (track.id === 'bad') throw new Error('unplayable')
      return {} as never
    })

    await expect(scenePlaybackTestHelpers.enqueueSceneTrackBatch(tracks, enqueueTrack, vi.fn())).resolves.toEqual([tracks[1]])
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
        occurrenceCount: 1,
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
