import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Track } from '../../types/ipc'

const mocked = vi.hoisted(() => ({
  loadRecentTracks: vi.fn<() => Track[]>(() => []),
  loadRecommendedTrackHistory: vi.fn(() => []),
  hideRecommendedTrackHistoryDates: vi.fn(),
  updateRecommendedTrackStatus: vi.fn(),
}))

vi.mock('../db/tracks', () => ({
  loadRecentTracks: mocked.loadRecentTracks,
  loadRecommendedTrackHistory: mocked.loadRecommendedTrackHistory,
  hideRecommendedTrackHistoryDates: mocked.hideRecommendedTrackHistoryDates,
  updateRecommendedTrackStatus: mocked.updateRecommendedTrackStatus,
}))

import { getQueue, markQueueStatus } from './queue'

describe('queue service', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('keeps the active queue free of completed and skipped tracks', () => {
    mocked.loadRecentTracks.mockReturnValue([
      { id: 'completed', title: '播完的歌', artist: 'A', queueStatus: 'completed' },
      { id: 'skipped', title: '跳过的歌', artist: 'B', queueStatus: 'skipped' },
      { id: 'pending', title: '待播的歌', artist: 'C', queueStatus: 'pending' },
      { id: 'pending', title: '待播的歌', artist: 'C', queueStatus: 'pending' },
      { id: 'playing', title: '播放中的歌', artist: 'D', queueStatus: 'playing' },
    ] as Track[])

    expect(getQueue().map((track) => track.title)).toEqual(['待播的歌', '播放中的歌'])
  })

  it('resets the previous playing item within the active queue', () => {
    const previous = { id: 'old', title: '旧播放', artist: 'A', queueStatus: 'playing' } as Track
    const next = { id: 'new', title: '新播放', artist: 'B', queueStatus: 'pending' } as Track
    mocked.loadRecentTracks.mockReturnValue([previous, next])

    markQueueStatus(next, 'playing', 'playback_started')

    expect(mocked.updateRecommendedTrackStatus).toHaveBeenCalledWith(expect.objectContaining({
      id: previous.id,
      title: previous.title,
      queueStatus: 'playing',
    }), 'pending')
    expect(mocked.updateRecommendedTrackStatus).toHaveBeenCalledWith(next, 'playing', 'playback_started')
  })
})
