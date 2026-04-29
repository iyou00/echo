import type { Track } from '../../types/ipc'
import { isFavoriteTrack, listFavoriteTracks, toggleFavoriteTrack } from '../db/favorites'
import { recordTrackFeedback } from '../db/feedback'
import { applySignal, maybeRefreshStructuredProfile } from './taste'

export function listFavorites(): Track[] {
  return listFavoriteTracks()
}

export async function toggleFavorite(track: Track): Promise<{ favorited: boolean; favorites: Track[] }> {
  const result = toggleFavoriteTrack(track)
  recordTrackFeedback(result.favorited ? 'favorited' : 'unfavorited', track)
  if (result.favorited) {
    await applySignal('favorited', { artist: track.artist, trackId: track.id ?? track.neteaseId, title: track.title, strength: 0.08 })
    maybeRefreshStructuredProfile('favorited')
  } else {
    maybeRefreshStructuredProfile('unfavorited')
  }
  return result
}

export function isFavorite(track: Track): boolean {
  return isFavoriteTrack(track)
}
