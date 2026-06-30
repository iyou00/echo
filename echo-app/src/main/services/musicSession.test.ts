import { describe, expect, it, vi } from 'vitest'

const mocked = vi.hoisted(() => ({
  listTodayExplicitTrackFeedback: vi.fn(() => []),
  loadTodayMeaningfulTrackEvents: vi.fn(() => [
    {
      title: '真正听过的歌',
      artist: '某歌手',
      listenedAt: '2026-06-18T20:00:00.000Z',
      source: 'recommended_by_echo',
      queueStatus: 'completed',
    },
  ]),
  loadTodayTrackEvents: vi.fn(() => {
    throw new Error('raw track events should not feed music session summary')
  }),
}))

vi.mock('../db/feedback', () => ({
  listTodayExplicitTrackFeedback: mocked.listTodayExplicitTrackFeedback,
}))

vi.mock('../db/tracks', () => ({
  loadTodayMeaningfulTrackEvents: mocked.loadTodayMeaningfulTrackEvents,
  loadTodayTrackEvents: mocked.loadTodayTrackEvents,
}))

import { buildTodayMusicSessionSummary } from './musicSession'

describe('music session summary boundaries', () => {
  it('uses meaningful listening events instead of raw recommendation records', () => {
    const summary = buildTodayMusicSessionSummary()

    expect(mocked.loadTodayMeaningfulTrackEvents).toHaveBeenCalledWith(80)
    expect(mocked.loadTodayTrackEvents).not.toHaveBeenCalled()
    expect(summary).toContain('真正听过的歌')
    expect(summary).toContain('<session_snapshot>')
    expect(summary).toContain('刚才完整听过:某歌手 / 真正听过的歌')
    expect(summary).not.toContain('今日推荐')
    expect(summary).not.toContain('今日听完')
    expect(summary).not.toContain('今日切歌')
  })
})
