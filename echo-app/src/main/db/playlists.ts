import type { Track } from '../../types/ipc'
import { trackIdentity } from '../../shared/trackIdentity'
import { getDb } from './index'
import { parseJson } from './json'

export interface PlaylistPayload {
  name: string
  tracks: Track[]
  source?: string
}

let importedTracksCache: { signature: string; tracks: Track[] } | null = null

function playlistSignature(): string {
  const row = getDb()
    .prepare(`
      SELECT COUNT(*) AS count, COALESCE(MAX(imported_at), '') AS latest
      FROM playlists_imported
      WHERE user_id = current_user_id()
    `)
    .get() as { count: number; latest: string }
  return `${row.count}:${row.latest}`
}

export function clearImportedTracksCache(): void {
  importedTracksCache = null
}

export function importPlaylist(payload: PlaylistPayload): void {
  const source = payload.source?.trim() || 'json'
  const hasStableSource = source.startsWith('netease:') || source.startsWith('file:')
  const database = getDb()
  database.transaction(() => {
    if (hasStableSource) {
      database
        .prepare('DELETE FROM playlists_imported WHERE user_id = current_user_id() AND source = ?')
        .run(source)
    } else {
      database
        .prepare('DELETE FROM playlists_imported WHERE user_id = current_user_id() AND source = ? AND name = ?')
        .run(source, payload.name)
    }
    database
      .prepare('INSERT INTO playlists_imported (user_id, source, name, raw_json) VALUES (current_user_id(), ?, ?, ?)')
      .run(source, payload.name, JSON.stringify({ ...payload, source }))
  })()
  clearImportedTracksCache()
}

export function getAllImportedTracks(): Track[] {
  const signature = playlistSignature()
  if (importedTracksCache?.signature === signature) return importedTracksCache.tracks.map((track) => ({ ...track }))
  const rows = getDb()
    .prepare('SELECT raw_json FROM playlists_imported WHERE user_id = current_user_id() ORDER BY imported_at DESC')
    .all() as { raw_json: string }[]
  const tracks = rows.flatMap((row) => {
    const parsed = parseJson<PlaylistPayload>(row.raw_json, { name: '', tracks: [] }, 'playlists.raw_json')
    return Array.isArray(parsed.tracks) ? parsed.tracks : []
  })
  const seen = new Set<string>()
  const uniqueTracks = tracks.filter((track) => {
    const key = trackIdentity(track)
    if (!key || seen.has(key)) return false
    seen.add(key)
    return true
  })
  importedTracksCache = { signature, tracks: uniqueTracks }
  return uniqueTracks.map((track) => ({ ...track }))
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
