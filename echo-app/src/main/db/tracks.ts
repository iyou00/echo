import type { Track } from '../../types/ipc'
import type { QueueHistoryDay } from '../../types/ipc'
import { trackIdentity } from '../../shared/trackIdentity'
import { getDb } from './index'
import { parseJson } from './json'

export interface TodayTrackEvent {
  title: string
  artist: string
  album?: string
  source?: string
  listenedAt: string
  queueStatus?: Track['queueStatus']
  echoNote?: string
  recommendSource?: string
  reason?: string
}

export interface ProfileTrackEvent {
  track: Track
  listenedAt: string
  source?: string
  queueStatus?: Track['queueStatus']
}

export interface ListenedTrackWindows {
  recent: Track[]
  history: Track[]
}

function queueTrackKey(track: Track): string {
  return trackIdentity(track)
}

function parseTrack(row: { title: string; artist: string; album?: string; source?: string; meta_json?: string }): Track {
  return row.meta_json ? parseJson<Track>(row.meta_json, { title: row.title, artist: row.artist, album: row.album, source: row.source }, 'tracks_listened.meta_json') : { title: row.title, artist: row.artist, album: row.album, source: row.source }
}

function parseSqliteTimestampMs(value: string): number {
  const parsed = Date.parse(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`)
  return Number.isFinite(parsed) ? parsed : 0
}

function boundedPositiveInteger(value: number, fallback: number, max: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(1, Math.floor(value)))
}

export function appendListenedTrack(track: Track, source = 'recommended_by_echo'): void {
  getDb()
    .prepare('INSERT INTO tracks_listened (user_id, title, artist, album, source, meta_json) VALUES (current_user_id(), ?, ?, ?, ?, ?)')
    .run(track.title, track.artist, track.album ?? '', source, JSON.stringify(track))
}

export function appendRecommendedTracks(tracks: Track[]): void {
  const insert = getDb().prepare('INSERT INTO tracks_listened (user_id, title, artist, album, source, meta_json) VALUES (current_user_id(), ?, ?, ?, ?, ?)')
  const update = getDb().prepare(`
    UPDATE tracks_listened
    SET title = ?, artist = ?, album = ?, source = ?, meta_json = ?, listened_at = CURRENT_TIMESTAMP
    WHERE id = ?
  `)
  const write = getDb().transaction((items: Track[]) => {
    const recommendedAt = new Date().toISOString()
    const existingRows = getDb()
      .prepare(`
        SELECT id, title, artist, album, source, meta_json
        FROM tracks_listened
        WHERE user_id = current_user_id()
          AND source = 'recommended_by_echo'
          AND date(listened_at, 'localtime') = date('now', 'localtime')
        ORDER BY listened_at DESC, id DESC
        LIMIT 500
      `)
      .all() as Array<{ id: number; title: string; artist: string; album?: string; source?: string; meta_json?: string }>
    const existing = new Map<string, { id: number; track: Track }>()
    for (const row of existingRows) existing.set(queueTrackKey(parseTrack(row)), { id: row.id, track: parseTrack(row) })

    for (const track of [...items].reverse()) {
      const current = existing.get(queueTrackKey(track))
      const enriched: Track = {
        ...(current?.track ?? {}),
        ...track,
        recommendedAt,
        queueStatus: current?.track.queueStatus === 'playing' ? 'playing' : 'pending',
        echoNote: track.reason ?? current?.track.echoNote,
      }
      if (current) {
        update.run(enriched.title, enriched.artist, enriched.album ?? '', 'recommended_by_echo', JSON.stringify(enriched), current.id)
        existing.set(queueTrackKey(enriched), { id: current.id, track: enriched })
      } else {
        const result = insert.run(enriched.title, enriched.artist, enriched.album ?? '', 'recommended_by_echo', JSON.stringify(enriched))
        existing.set(queueTrackKey(enriched), { id: Number(result.lastInsertRowid), track: enriched })
      }
    }
  })
  write(tracks)
}

export function skipTodayRecommendedTracks(): void {
  const rows = getDb()
    .prepare(`
      SELECT id, meta_json
      FROM tracks_listened
      WHERE user_id = current_user_id()
        AND source = 'recommended_by_echo'
        AND date(listened_at, 'localtime') = date('now', 'localtime')
    `)
    .all() as Array<{ id: number; meta_json?: string }>
  const update = getDb().prepare('UPDATE tracks_listened SET meta_json = ? WHERE id = ?')
  const write = getDb().transaction((items: Array<{ id: number; meta_json?: string }>) => {
    for (const row of items) {
      if (!row.meta_json) continue
      const parsed = parseJson<Track | null>(row.meta_json, null, 'tracks_listened.meta_json')
      if (!parsed || parsed.queueStatus === 'completed') continue
      update.run(JSON.stringify({ ...parsed, queueStatus: 'skipped' }), row.id)
    }
  })
  write(rows)
}

export function loadRecentTracks(limit = 20): Track[] {
  return getDb()
    .prepare(`
      SELECT title, artist, album, source, meta_json
      FROM tracks_listened
      WHERE user_id = current_user_id()
        AND source = 'recommended_by_echo'
        AND date(listened_at, 'localtime') = date('now', 'localtime')
      ORDER BY listened_at DESC, id DESC
      LIMIT ?
    `)
    .all(limit)
    .map((row) => {
      const typed = row as { title: string; artist: string; album?: string; source?: string; meta_json?: string }
      return parseTrack(typed)
    })
}

export function loadRecentRecommendedTracks(limit = 80): Track[] {
  return getDb()
    .prepare(`
      SELECT title, artist, album, source, meta_json
      FROM tracks_listened
      WHERE user_id = current_user_id()
        AND source = 'recommended_by_echo'
      ORDER BY listened_at DESC, id DESC
      LIMIT ?
    `)
    .all(limit)
    .map((row) => {
      const typed = row as { title: string; artist: string; album?: string; source?: string; meta_json?: string }
      return parseTrack(typed)
    })
}

export function loadListenedTracksSince(hours: number, limit = 300): Track[] {
  const safeHours = Math.max(1, Math.floor(hours))
  return getDb()
    .prepare(`
      SELECT title, artist, album, source, meta_json
      FROM tracks_listened
      WHERE user_id = current_user_id()
        AND listened_at >= datetime('now', ?)
      ORDER BY listened_at DESC, id DESC
      LIMIT ?
    `)
    .all(`-${safeHours} hours`, limit)
    .map((row) => {
      const typed = row as { title: string; artist: string; album?: string; source?: string; meta_json?: string }
      return parseTrack(typed)
    })
}

export function loadListenedTrackWindows(historyHours: number, historyLimit = 300, recentHours = 24, recentLimit = 300): ListenedTrackWindows {
  const safeHistoryHours = boundedPositiveInteger(historyHours, 24, 24 * 30)
  const safeRecentHours = Math.min(safeHistoryHours, boundedPositiveInteger(recentHours, 24, safeHistoryHours))
  const safeHistoryLimit = boundedPositiveInteger(historyLimit, 300, 5000)
  const safeRecentLimit = boundedPositiveInteger(recentLimit, 300, 5000)
  const rows = getDb()
    .prepare(`
      SELECT title, artist, album, source, meta_json, listened_at
      FROM tracks_listened
      WHERE user_id = current_user_id()
        AND listened_at >= datetime('now', ?)
      ORDER BY listened_at DESC, id DESC
      LIMIT ?
    `)
    .all(`-${safeHistoryHours} hours`, safeHistoryLimit) as Array<{ title: string; artist: string; album?: string; source?: string; meta_json?: string; listened_at: string }>
  const recentCutoff = Date.now() - safeRecentHours * 60 * 60 * 1000
  return {
    history: rows.map(parseTrack),
    recent: rows.filter((row) => parseSqliteTimestampMs(row.listened_at) >= recentCutoff).slice(0, safeRecentLimit).map(parseTrack),
  }
}

export function loadTodayTrackEvents(limit = 60): TodayTrackEvent[] {
  return getDb()
    .prepare(`
      SELECT title, artist, album, source, listened_at, meta_json
      FROM tracks_listened
      WHERE user_id = current_user_id()
        AND date(listened_at, 'localtime') = date('now', 'localtime')
      ORDER BY listened_at ASC, id ASC
      LIMIT ?
    `)
    .all(limit)
    .map((row) => {
      const typed = row as { title: string; artist: string; album?: string; source?: string; listened_at: string; meta_json?: string }
      const parsed = typed.meta_json ? parseJson<Track | null>(typed.meta_json, null, 'tracks_listened.meta_json') : null
      return {
        title: typed.title,
        artist: typed.artist,
        album: typed.album,
        source: typed.source,
        listenedAt: typed.listened_at,
        queueStatus: parsed?.queueStatus,
        echoNote: parsed?.echoNote ?? parsed?.reason,
        recommendSource: parsed?.recommendSource,
        reason: parsed?.reason,
      }
    })
}

export function loadRecommendedTrackHistory(limitDays = 7): QueueHistoryDay[] {
  const safeLimitDays = Math.max(1, Math.min(30, Math.floor(limitDays)))
  const dayRows = getDb()
    .prepare(`
      SELECT DISTINCT date(listened_at, 'localtime') AS day
      FROM tracks_listened
      WHERE user_id = current_user_id()
        AND source = 'recommended_by_echo'
        AND date(listened_at, 'localtime') < date('now', 'localtime')
        AND date(listened_at, 'localtime') NOT IN (
          SELECT date FROM queue_history_hidden_dates WHERE user_id = current_user_id()
        )
      ORDER BY day DESC
      LIMIT ?
    `)
    .all(safeLimitDays) as Array<{ day: string }>

  const selectTracks = getDb().prepare(`
    SELECT title, artist, album, source, meta_json
    FROM tracks_listened
    WHERE user_id = current_user_id()
      AND source = 'recommended_by_echo'
      AND date(listened_at, 'localtime') = ?
    ORDER BY listened_at DESC, id DESC
    LIMIT 80
  `)

  const groups: QueueHistoryDay[] = []
  for (const { day } of dayRows) {
    const rows = selectTracks.all(day) as Array<{ title: string; artist: string; album?: string; source?: string; meta_json?: string }>
    const tracks: Track[] = []
    const seen = new Set<string>()
    for (const row of rows) {
      const track = parseTrack(row)
      const key = queueTrackKey(track)
      if (seen.has(key)) continue
      seen.add(key)
      tracks.push(track)
    }
    groups.push({ date: day, tracks })
  }

  return groups
}

export function hideRecommendedTrackHistoryDates(dates: string[]): void {
  const uniqueDates = Array.from(new Set(dates.map((date) => date.trim()).filter(Boolean)))
  if (uniqueDates.length === 0) return
  const insert = getDb().prepare(`
    INSERT INTO queue_history_hidden_dates (user_id, date, hidden_at)
    VALUES (current_user_id(), ?, ?)
    ON CONFLICT(user_id, date) DO UPDATE SET hidden_at = excluded.hidden_at
  `)
  const hiddenAt = new Date().toLocaleString('sv-SE', { hour12: false })
  const write = getDb().transaction((items: string[]) => {
    for (const date of items) insert.run(date, hiddenAt)
  })
  write(uniqueDates)
}

export function loadProfileTrackEvents(limit = 500): ProfileTrackEvent[] {
  return getDb()
    .prepare(`
      SELECT title, artist, album, source, listened_at, meta_json
      FROM tracks_listened
      WHERE user_id = current_user_id()
      ORDER BY listened_at DESC, id DESC
      LIMIT ?
    `)
    .all(limit)
    .map((row) => {
      const typed = row as { title: string; artist: string; album?: string; source?: string; listened_at: string; meta_json?: string }
      const parsed = typed.meta_json ? parseJson<Track | null>(typed.meta_json, null, 'tracks_listened.meta_json') : null
      return {
        track: parsed ?? { title: typed.title, artist: typed.artist, album: typed.album, source: typed.source },
        listenedAt: typed.listened_at,
        source: typed.source,
        queueStatus: parsed?.queueStatus,
      }
    })
}

export function updateRecommendedTrackStatus(track: Track, status: NonNullable<Track['queueStatus']>): void {
  const rows = getDb()
    .prepare(`
      SELECT id, meta_json
      FROM tracks_listened
      WHERE user_id = current_user_id()
        AND source = 'recommended_by_echo'
        AND date(listened_at, 'localtime') = date('now', 'localtime')
      ORDER BY listened_at DESC, id DESC
    `)
    .all() as Array<{ id: number; meta_json?: string }>

  const targetKey = queueTrackKey(track)
  const target = rows.find((row) => {
    const parsed = row.meta_json ? parseJson<Track | null>(row.meta_json, null, 'tracks_listened.meta_json') : null
    return parsed ? queueTrackKey(parsed) === targetKey : false
  })
  if (!target?.meta_json) return

  const parsed = parseJson<Track>(target.meta_json, track, 'tracks_listened.meta_json')
  const next: Track = {
    ...parsed,
    queueStatus: status,
  }
  getDb().prepare('UPDATE tracks_listened SET meta_json = ? WHERE id = ?').run(JSON.stringify(next), target.id)
}
