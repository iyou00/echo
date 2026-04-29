import type { Track } from '../../types/ipc'
import { getDb } from './index'

export interface PlaylistPayload {
  name: string
  tracks: Track[]
  source?: string
}

export function importPlaylist(payload: PlaylistPayload): void {
  getDb()
    .prepare('INSERT INTO playlists_imported (user_id, source, name, raw_json) VALUES (1, ?, ?, ?)')
    .run(payload.source ?? 'json', payload.name, JSON.stringify(payload))
}

export function getAllImportedTracks(): Track[] {
  const rows = getDb()
    .prepare('SELECT raw_json FROM playlists_imported WHERE user_id = 1 ORDER BY imported_at DESC')
    .all() as { raw_json: string }[]
  return rows.flatMap((row) => {
    const parsed = JSON.parse(row.raw_json) as PlaylistPayload
    return Array.isArray(parsed.tracks) ? parsed.tracks : []
  })
}

export function searchImportedTracks(query: string, limit = 5): Track[] {
  const terms = query.toLowerCase().split(/\s+/).filter(Boolean)
  const tracks = getAllImportedTracks()
  const scored = tracks.map((track) => {
    const haystack = `${track.title} ${track.artist} ${track.album ?? ''} ${track.year ?? ''}`.toLowerCase()
    const score = terms.reduce((sum, term) => sum + (haystack.includes(term) ? 2 : 0), 0)
    return { track, score }
  })
  return scored
    .sort((a, b) => b.score - a.score)
    .filter((item, index) => item.score > 0 || index < limit)
    .slice(0, limit)
    .map((item) => item.track)
}
