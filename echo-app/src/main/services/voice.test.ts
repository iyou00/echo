import { describe, expect, it } from 'vitest'
import { voiceTestHelpers } from './voice'

describe('voice line quality boundaries', () => {
  it('rejects internal memory and portrait phrasing', () => {
    expect(voiceTestHelpers.hasVoiceLineQuality('我根据你的画像和数据，判断你今天需要安静一点。')).toBe(false)
    expect(voiceTestHelpers.hasVoiceLineQuality('我看到记忆策略里纠正过这个方向，所以这次换一种说法。')).toBe(false)
    expect(voiceTestHelpers.hasVoiceLineQuality('我记得你说过不喜欢电子音墙，这次先避开。')).toBe(false)
    expect(voiceTestHelpers.hasVoiceLineQuality('你之前告诉过我少推悲伤的歌，我换个方向。')).toBe(false)
  })

  it('rejects banned companion cliches', () => {
    expect(voiceTestHelpers.hasVoiceLineQuality('我给你接上这首歌，让你稳稳的，把情绪接住。')).toBe(false)
    expect(voiceTestHelpers.hasVoiceLineQuality('我完全理解你的心情，音乐是治愈的力量。')).toBe(false)
  })

  it('accepts short direct spoken lines', () => {
    expect(voiceTestHelpers.hasVoiceLineQuality('我在。你先不用解释，听到这一段过去再说。')).toBe(true)
    expect(voiceTestHelpers.hasVoiceLineQuality('我在。你说不定可以先听完这一段，再决定要不要换。')).toBe(true)
  })

  it('cleans markdown wrappers before speaking', () => {
    expect(voiceTestHelpers.cleanVoiceLine('```md\n> “我在，先听完这一段。”\n```')).toBe('我在，先听完这一段。')
  })

  it('uses the latest positive track for the just-played fallback', () => {
    const latest = voiceTestHelpers.latestPositiveTrackEvent([
      {
        title: '早一点',
        artist: 'Echo',
        listenedAt: '2026-06-17 09:00:00',
        source: 'recommended_by_echo',
        queueStatus: 'completed',
      },
      {
        title: '刚才那首',
        artist: 'Echo',
        listenedAt: '2026-06-17 09:30:00',
        source: 'recommended_by_echo',
        queueStatus: 'completed',
      },
    ])

    expect(latest?.title).toBe('刚才那首')
  })

  it('does not treat skipped feedback as a positive fallback track', () => {
    const latest = voiceTestHelpers.latestPositiveTrackEvent([
      {
        title: '听完的歌',
        artist: 'Echo',
        listenedAt: '2026-06-17 09:00:00',
        source: 'recommended_by_echo',
        queueStatus: 'completed',
      },
      {
        title: '刚刚否定的歌',
        artist: 'Echo',
        listenedAt: '2026-06-17 09:30:00',
        source: 'recommended_by_echo',
        queueStatus: 'skipped',
        queueStatusReason: 'explicit_feedback',
      },
    ])

    expect(latest?.title).toBe('听完的歌')
    expect(voiceTestHelpers.hasDismissedTrackEvent([
      {
        title: '刚刚否定的歌',
        artist: 'Echo',
        listenedAt: '2026-06-17 09:30:00',
        source: 'recommended_by_echo',
        queueStatus: 'skipped',
        queueStatusReason: 'explicit_feedback',
      },
    ])).toBe(true)
  })

  it('splits voice prompt track evidence into positive and dismissed tracks', () => {
    const events = [
      {
        title: '旧脏记录',
        artist: 'Echo',
        listenedAt: '2026-06-17 08:30:00',
        queueStatus: undefined,
      },
      {
        title: '排队的歌',
        artist: 'Echo',
        listenedAt: '2026-06-17 09:00:00',
        source: 'recommended_by_echo',
        queueStatus: 'pending' as const,
      },
      {
        title: '听完的歌',
        artist: 'Echo',
        listenedAt: '2026-06-17 09:10:00',
        source: 'recommended_by_echo',
        queueStatus: 'completed' as const,
      },
      {
        title: '否定的歌',
        artist: 'Echo',
        listenedAt: '2026-06-17 09:30:00',
        source: 'recommended_by_echo',
        queueStatus: 'skipped' as const,
        queueStatusReason: 'explicit_feedback' as const,
      },
      {
        title: '场景替换的歌',
        artist: 'Echo',
        listenedAt: '2026-06-17 09:40:00',
        source: 'recommended_by_echo',
        queueStatus: 'skipped' as const,
        queueStatusReason: 'scene_replaced' as const,
      },
      {
        title: '播放失败的歌',
        artist: 'Echo',
        listenedAt: '2026-06-17 09:50:00',
        source: 'recommended_by_echo',
        queueStatus: 'skipped' as const,
        queueStatusReason: 'playback_failed' as const,
      },
    ]

    expect(voiceTestHelpers.pickPositiveVoiceTrackEvents(events).map((event) => event.title)).toEqual(['听完的歌'])
    expect(voiceTestHelpers.pickDismissedVoiceTrackEvents(events).map((event) => event.title)).toEqual(['否定的歌'])
  })
})
