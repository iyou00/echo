import type { Track } from '../../types/ipc'
import type { FavoriteListOptions } from '../../types/ipc'
import { countFavoriteTracks, isFavoriteTrack, listFavoriteTrackKeys, listFavoriteTracks, saveFavoriteTrack, toggleFavoriteTrack } from '../db/favorites'
import { recordTrackFeedback } from '../db/feedback'
import { applyMemorySignal } from './memoryPolicy'

export function listFavorites(options?: FavoriteListOptions): Track[] {
  return listFavoriteTracks(options)
}

export function countFavorites(query?: string): number {
  return countFavoriteTracks(query)
}

export function listFavoriteKeys(): string[] {
  return listFavoriteTrackKeys()
}

export async function toggleFavorite(track: Track): Promise<{ favorited: boolean; favorites: Track[] }> {
  const result = toggleFavoriteTrack(track)
  recordTrackFeedback(result.favorited ? 'favorited' : 'unfavorited', track)
  await applyMemorySignal(
    result.favorited ? 'favorited' : 'unfavorited',
    { artist: track.artist, trackId: track.id ?? track.neteaseId, title: track.title },
    { source: 'favorite', track },
  )
  return result
}

export async function ensureFavorite(track: Track): Promise<{ favorited: true; changed: boolean; favorites: Track[] }> {
  const result = saveFavoriteTrack(track)
  if (result.changed) {
    recordTrackFeedback('favorited', track)
    await applyMemorySignal(
      'favorited',
      { artist: track.artist, trackId: track.id ?? track.neteaseId, title: track.title },
      { source: 'favorite', track },
    )
  }
  return result
}

export function isFavorite(track: Track): boolean {
  return isFavoriteTrack(track)
}
