import type { Track } from '../../types/ipc'
import { getDb } from './index'

export function favoriteTrackKey(track: Track): string {
  const neteaseId = String(track.neteaseId ?? '').trim()
  if (neteaseId) return `netease:${neteaseId}`
  const id = String(track.id ?? '').trim()
  if (id) return `id:${id}`
  return `name:${track.title.trim().toLowerCase()}::${track.artist.trim().toLowerCase()}`
}

function toTrack(row: { track_json: string }): Track {
  return {
    ...(JSON.parse(row.track_json) as Track),
    favorited: true,
  }
}

export function listFavoriteTracks(): Track[] {
  const rows = getDb()
    .prepare(
      `SELECT track_json
       FROM favorite_tracks
       WHERE user_id = 1
       ORDER BY favorited_at DESC, id DESC`,
    )
    .all() as Array<{ track_json: string }>
  return rows.map(toTrack)
}

export function isFavoriteTrack(track: Track): boolean {
  const row = getDb()
    .prepare('SELECT 1 FROM favorite_tracks WHERE user_id = 1 AND track_key = ? LIMIT 1')
    .get(favoriteTrackKey(track)) as { 1: number } | undefined
  return Boolean(row)
}

export function toggleFavoriteTrack(track: Track): { favorited: boolean; favorites: Track[] } {
  const key = favoriteTrackKey(track)
  if (isFavoriteTrack(track)) {
    getDb().prepare('DELETE FROM favorite_tracks WHERE user_id = 1 AND track_key = ?').run(key)
    return { favorited: false, favorites: listFavoriteTracks() }
  }

  const saved: Track = { ...track, favorited: true }
  getDb()
    .prepare(
      `INSERT INTO favorite_tracks (user_id, track_key, title, artist, album, source, track_json)
       VALUES (1, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(track_key) DO UPDATE SET
         title = excluded.title,
         artist = excluded.artist,
         album = excluded.album,
         source = excluded.source,
         track_json = excluded.track_json,
         favorited_at = CURRENT_TIMESTAMP`,
    )
    .run(key, track.title, track.artist, track.album ?? '', track.source ?? '', JSON.stringify(saved))
  return { favorited: true, favorites: listFavoriteTracks() }
}
