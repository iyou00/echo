import { describe, expect, it } from 'vitest'
import { yinyiTestHelpers } from './yinyi'

describe('yinyi quality boundaries', () => {
  it('rejects report-like and internal-memory phrasing', () => {
    expect(yinyiTestHelpers.hasYinyiQuality('我根据你的画像和数据看，你今天总共听了 3 首歌。')).toBe(false)
    expect(yinyiTestHelpers.hasYinyiQuality('我从你这段时间的轨迹看，你其实一直在回避某种情绪。')).toBe(false)
    expect(yinyiTestHelpers.hasYinyiQuality('我看到 memory 里的用户纠正过这个方向，所以今天这样写。')).toBe(false)
    expect(yinyiTestHelpers.hasYinyiQuality('我记得你说过不喜欢电子音墙，所以今晚我避开了那一类。')).toBe(false)
    expect(yinyiTestHelpers.hasYinyiQuality('你之前告诉过我少推悲伤的歌，我今天就不往那个方向写。')).toBe(false)
  })

  it('rejects banned soul-policy cliches', () => {
    expect(yinyiTestHelpers.hasYinyiQuality('我给你接上这段夜色，让你稳稳的，也把情绪接住。')).toBe(false)
    expect(yinyiTestHelpers.hasYinyiQuality('我完全理解你的心情，音乐是治愈的力量，你会好起来。')).toBe(false)
  })

  it('accepts compact companion-style writing with uncertainty', () => {
    expect(yinyiTestHelpers.hasYinyiQuality(
      '我猜你今天只是想让声音在旁边待一会儿。你没把话说满，歌也没有急着往前冲，这样的空白反倒挺像今天。',
    )).toBe(true)
    expect(yinyiTestHelpers.hasYinyiQuality(
      '我猜你今天只是想让声音在旁边待一会儿。你说不定也需要一点空白，先让这首歌慢慢走完。',
    )).toBe(true)
  })

  it('cleans markdown fences and quotes without keeping wrapper syntax', () => {
    expect(yinyiTestHelpers.cleanYinyiContent('```md\n> “我猜你今天有点累。”\n```')).toBe('我猜你今天有点累。')
  })

  it('does not describe skipped explicit-feedback tracks as still playing in fallback', () => {
    const entry = yinyiTestHelpers.fallbackYinyiEntry('2026-06-17', [], [
      {
        title: '不合适的歌',
        artist: 'Echo',
        listenedAt: '2026-06-17 09:30:00',
        source: 'recommended_by_echo',
        queueStatus: 'skipped',
        queueStatusReason: 'explicit_feedback',
      },
    ], 'LLM timeout')

    expect(entry.content).not.toContain('耳边还放着')
    expect(entry.content).not.toContain('不合适的歌')
    expect(entry.content).toContain('被你放下')
    expect(entry.meta?.tracks).toEqual([])
    expect(entry.meta?.dismissed_tracks?.map((track) => track.title)).toEqual(['不合适的歌'])
  })

  it('keeps completed tracks as positive fallback evidence', () => {
    const tracks = yinyiTestHelpers.pickPositiveYinyiTracks([
      {
        title: '旧脏记录',
        artist: 'Echo',
        listenedAt: '2026-06-17 08:30:00',
        queueStatus: undefined,
      },
      {
        title: '听完的歌',
        artist: 'Echo',
        listenedAt: '2026-06-17 09:00:00',
        source: 'recommended_by_echo',
        queueStatus: 'completed',
      },
      {
        title: '跳过的歌',
        artist: 'Echo',
        listenedAt: '2026-06-17 09:30:00',
        source: 'recommended_by_echo',
        queueStatus: 'skipped',
        queueStatusReason: 'explicit_feedback',
      },
    ])

    expect(tracks.map((track) => track.title)).toEqual(['听完的歌'])
  })

  it('keeps dismissed tracks out of positive fallback metadata', () => {
    const entry = yinyiTestHelpers.fallbackYinyiEntry('2026-06-17', [], [
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
    ], 'LLM timeout')

    expect(entry.meta?.tracks?.map((track) => track.title)).toEqual(['听完的歌'])
    expect(entry.meta?.dismissed_tracks?.map((track) => track.title)).toEqual(['刚刚否定的歌'])
  })
})
