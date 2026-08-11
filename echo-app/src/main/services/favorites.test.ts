import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Track } from '../../types/ipc'

const mocked = vi.hoisted(() => ({
  toggleFavoriteTrack: vi.fn(),
  saveFavoriteTrack: vi.fn(),
  listFavoriteTracks: vi.fn(() => [] as Track[]),
  countFavoriteTracks: vi.fn(() => 0),
  isFavoriteTrack: vi.fn(() => false),
  listFavoriteTrackKeys: vi.fn(() => [] as string[]),
  recordTrackFeedback: vi.fn(),
  applyMemorySignal: vi.fn(),
}))

vi.mock('../db/favorites', () => ({
  toggleFavoriteTrack: mocked.toggleFavoriteTrack,
  saveFavoriteTrack: mocked.saveFavoriteTrack,
  listFavoriteTracks: mocked.listFavoriteTracks,
  countFavoriteTracks: mocked.countFavoriteTracks,
  isFavoriteTrack: mocked.isFavoriteTrack,
  listFavoriteTrackKeys: mocked.listFavoriteTrackKeys,
}))

vi.mock('../db/feedback', () => ({
  recordTrackFeedback: mocked.recordTrackFeedback,
}))

vi.mock('./memoryPolicy', () => ({
  applyMemorySignal: mocked.applyMemorySignal,
}))

import { ensureFavorite, toggleFavorite } from './favorites'

const track: Track = {
  id: 'track-1',
  neteaseId: '1888',
  title: '主角',
  artist: '王菲',
  source: 'netease',
}

describe('favorites service memory boundaries', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('writes a strong memory signal when a user favorites a track', async () => {
    mocked.toggleFavoriteTrack.mockReturnValueOnce({ favorited: true, favorites: [track] })

    await toggleFavorite(track)

    expect(mocked.recordTrackFeedback).toHaveBeenCalledWith('favorited', track)
    expect(mocked.applyMemorySignal).toHaveBeenCalledWith('favorited', {
      artist: '王菲',
      trackId: 'track-1',
      title: '主角',
    }, {
      source: 'favorite',
      track,
    })
  })

  it('writes an unfavorite signal when a user removes a favorite', async () => {
    mocked.toggleFavoriteTrack.mockReturnValueOnce({ favorited: false, favorites: [] })

    await toggleFavorite(track)

    expect(mocked.recordTrackFeedback).toHaveBeenCalledWith('unfavorited', track)
    expect(mocked.applyMemorySignal).toHaveBeenCalledWith('unfavorited', {
      artist: '王菲',
      trackId: 'track-1',
      title: '主角',
    }, {
      source: 'favorite',
      track,
    })
  })

  it('does not duplicate memory when ensureFavorite keeps an existing favorite unchanged', async () => {
    mocked.saveFavoriteTrack.mockReturnValueOnce({ favorited: true, changed: false, favorites: [track] })

    await ensureFavorite(track)

    expect(mocked.recordTrackFeedback).not.toHaveBeenCalled()
    expect(mocked.applyMemorySignal).not.toHaveBeenCalled()
  })
})
