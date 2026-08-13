import type { Track } from '../../types/ipc'
import { randomUUID } from 'node:crypto'
import type { FavoriteListOptions } from '../../types/ipc'
import { trackIdentity } from '../../shared/trackIdentity'
import { getDb } from './index'
import { parseJson } from './json'

export function favoriteTrackKey(track: Track): string {
  return trackIdentity(track)
}

function toTrack(row: { track_json: string }): Track {
  return {
    ...parseJson<Track>(row.track_json, { title: '', artist: '' }, 'favorite_tracks.track_json'),
    favorited: true,
  }
}

export function listFavoriteTracks(options: FavoriteListOptions = {}): Track[] {
  const limit = Math.max(1, Math.min(200, Math.floor(options.limit ?? 200)))
  const offset = Math.max(0, Math.floor(options.offset ?? 0))
  const query = options.query?.trim()
  const rows = query
    ? getDb()
      .prepare(
        `SELECT track_json
         FROM favorite_tracks
         WHERE user_id = current_user_id()
           AND (title LIKE ? OR artist LIKE ? OR album LIKE ?)
         ORDER BY favorited_at DESC, id DESC
         LIMIT ? OFFSET ?`,
      )
      .all(`%${query}%`, `%${query}%`, `%${query}%`, limit, offset) as Array<{ track_json: string }>
    : getDb()
      .prepare(
        `SELECT track_json
         FROM favorite_tracks
         WHERE user_id = current_user_id()
         ORDER BY favorited_at DESC, id DESC
         LIMIT ? OFFSET ?`,
      )
      .all(limit, offset) as Array<{ track_json: string }>
  return rows.map(toTrack)
}

export function countFavoriteTracks(query?: string): number {
  const normalized = query?.trim()
  const row = normalized
    ? getDb()
      .prepare(
        `SELECT COUNT(*) AS count
         FROM favorite_tracks
         WHERE user_id = current_user_id()
           AND (title LIKE ? OR artist LIKE ? OR album LIKE ?)`,
      )
      .get(`%${normalized}%`, `%${normalized}%`, `%${normalized}%`) as { count: number }
    : getDb()
      .prepare('SELECT COUNT(*) AS count FROM favorite_tracks WHERE user_id = current_user_id()')
      .get() as { count: number }
  return row.count
}

export function listFavoriteTrackKeys(): string[] {
  const rows = getDb()
    .prepare(
      `SELECT track_key
       FROM favorite_tracks
       WHERE user_id = current_user_id()
       ORDER BY favorited_at DESC, id DESC`,
    )
    .all() as Array<{ track_key: string }>
  return rows.map((row) => row.track_key)
}

export function isFavoriteTrack(track: Track): boolean {
  const row = getDb()
    .prepare('SELECT 1 FROM favorite_tracks WHERE user_id = current_user_id() AND track_key = ? LIMIT 1')
    .get(favoriteTrackKey(track)) as { 1: number } | undefined
  return Boolean(row)
}

export function toggleFavoriteTrack(track: Track): { favorited: boolean; favorites: Track[] } {
  const key = favoriteTrackKey(track)
  const saved: Track = { ...track, favorited: true }
  const write = getDb().transaction(() => {
    const existing = getDb()
      .prepare('SELECT 1 FROM favorite_tracks WHERE user_id = current_user_id() AND track_key = ? LIMIT 1')
      .get(key)
    if (existing) {
      getDb().prepare('DELETE FROM favorite_tracks WHERE user_id = current_user_id() AND track_key = ?').run(key)
      return false
    }

    getDb()
      .prepare(
        `INSERT INTO favorite_tracks (user_id, track_key, title, artist, album, source, track_json)
         VALUES (current_user_id(), ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, track_key) DO UPDATE SET
           title = excluded.title,
           artist = excluded.artist,
           album = excluded.album,
           source = excluded.source,
           track_json = excluded.track_json,
           favorited_at = CURRENT_TIMESTAMP`,
      )
      .run(key, track.title, track.artist, track.album ?? '', track.source ?? '', JSON.stringify(saved))
    if (track.agentActionId) {
      getDb().prepare(`
        INSERT INTO agent_action_outcomes (
          user_id, action_id, action_item_id, source_event_key, outcome_type, polarity, strength, occurred_at, metadata_json
        ) VALUES (current_user_id(), ?, ?, ?, 'favorite', 'positive', 'strong', CURRENT_TIMESTAMP, ?)
      `).run(track.agentActionId, track.agentActionItemId ?? null, `favorite:${randomUUID()}`, JSON.stringify({ userAgency: 'active' }))
    }
    return true
  })
  const favorited = write()
  return { favorited, favorites: listFavoriteTracks() }
}

export function saveFavoriteTrack(track: Track): { favorited: true; changed: boolean; favorites: Track[] } {
  const key = favoriteTrackKey(track)
  const saved: Track = { ...track, favorited: true }
  const write = getDb().transaction(() => {
    const existing = getDb()
      .prepare('SELECT 1 FROM favorite_tracks WHERE user_id = current_user_id() AND track_key = ? LIMIT 1')
      .get(key)
    getDb()
      .prepare(
        `INSERT INTO favorite_tracks (user_id, track_key, title, artist, album, source, track_json)
         VALUES (current_user_id(), ?, ?, ?, ?, ?, ?)
         ON CONFLICT(user_id, track_key) DO UPDATE SET
           title = excluded.title,
           artist = excluded.artist,
           album = excluded.album,
           source = excluded.source,
           track_json = excluded.track_json`,
      )
      .run(key, track.title, track.artist, track.album ?? '', track.source ?? '', JSON.stringify(saved))
    if (!existing && track.agentActionId) {
      getDb().prepare(`
        INSERT INTO agent_action_outcomes (
          user_id, action_id, action_item_id, source_event_key, outcome_type, polarity, strength, occurred_at, metadata_json
        ) VALUES (current_user_id(), ?, ?, ?, 'favorite', 'positive', 'strong', CURRENT_TIMESTAMP, ?)
      `).run(track.agentActionId, track.agentActionItemId ?? null, `favorite:${randomUUID()}`, JSON.stringify({ userAgency: 'active' }))
    }
    return !existing
  })
  const changed = write()
  return { favorited: true, changed, favorites: listFavoriteTracks() }
}
