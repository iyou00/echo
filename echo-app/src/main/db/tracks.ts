import type { Track } from '../../types/ipc'
import type { QueueHistoryDay } from '../../types/ipc'
import { getDb } from './index'

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

function queueTrackKey(track: Track): string {
  const neteaseId = String(track.neteaseId ?? '').trim()
  if (neteaseId) return `netease:${neteaseId}`
  const id = String(track.id ?? '').trim()
  if (id) return `id:${id}`
  return `name:${track.title.trim().toLowerCase()}::${track.artist.trim().toLowerCase()}`
}

function parseTrack(row: { title: string; artist: string; album?: string; source?: string; meta_json?: string }): Track {
  return row.meta_json ? (JSON.parse(row.meta_json) as Track) : { title: row.title, artist: row.artist, album: row.album, source: row.source }
}

export function appendListenedTrack(track: Track, source = 'recommended_by_echo'): void {
  getDb()
    .prepare('INSERT INTO tracks_listened (user_id, title, artist, album, source, meta_json) VALUES (1, ?, ?, ?, ?, ?)')
    .run(track.title, track.artist, track.album ?? '', source, JSON.stringify(track))
}

export function appendRecommendedTracks(tracks: Track[]): void {
  const insert = getDb().prepare('INSERT INTO tracks_listened (user_id, title, artist, album, source, meta_json) VALUES (1, ?, ?, ?, ?, ?)')
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
        WHERE user_id = 1
          AND source = 'recommended_by_echo'
          AND date(listened_at, 'localtime') = date('now', 'localtime')
        ORDER BY listened_at DESC, id DESC
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
      WHERE user_id = 1
        AND source = 'recommended_by_echo'
        AND date(listened_at, 'localtime') = date('now', 'localtime')
    `)
    .all() as Array<{ id: number; meta_json?: string }>
  const update = getDb().prepare('UPDATE tracks_listened SET meta_json = ? WHERE id = ?')
  const write = getDb().transaction((items: Array<{ id: number; meta_json?: string }>) => {
    for (const row of items) {
      if (!row.meta_json) continue
      try {
        const parsed = JSON.parse(row.meta_json) as Track
        update.run(JSON.stringify({ ...parsed, queueStatus: 'skipped' }), row.id)
      } catch {
        continue
      }
    }
  })
  write(rows)
}

export function loadRecentTracks(limit = 20): Track[] {
  return getDb()
    .prepare(`
      SELECT title, artist, album, source, meta_json
      FROM tracks_listened
      WHERE user_id = 1
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
      WHERE user_id = 1
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
      WHERE user_id = 1
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

export function loadTodayTrackEvents(limit = 60): TodayTrackEvent[] {
  return getDb()
    .prepare(`
      SELECT title, artist, album, source, listened_at, meta_json
      FROM tracks_listened
      WHERE user_id = 1
        AND date(listened_at, 'localtime') = date('now', 'localtime')
      ORDER BY listened_at ASC, id ASC
      LIMIT ?
    `)
    .all(limit)
    .map((row) => {
      const typed = row as { title: string; artist: string; album?: string; source?: string; listened_at: string; meta_json?: string }
      const parsed = typed.meta_json ? (JSON.parse(typed.meta_json) as Track) : null
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
  const rows = getDb()
    .prepare(`
      SELECT date(listened_at, 'localtime') AS day, title, artist, album, source, meta_json
      FROM tracks_listened
      WHERE user_id = 1
        AND source = 'recommended_by_echo'
        AND date(listened_at, 'localtime') < date('now', 'localtime')
        AND date(listened_at, 'localtime') NOT IN (
          SELECT date FROM queue_history_hidden_dates WHERE user_id = 1
        )
      ORDER BY listened_at DESC, id DESC
      LIMIT 300
    `)
    .all() as Array<{ day: string; title: string; artist: string; album?: string; source?: string; meta_json?: string }>

  const groups = new Map<string, Track[]>()
  const seenByDay = new Map<string, Set<string>>()
  for (const row of rows) {
    if (!groups.has(row.day) && groups.size >= limitDays) continue
    const track = parseTrack(row)
    const seen = seenByDay.get(row.day) ?? new Set<string>()
    const key = queueTrackKey(track)
    if (seen.has(key)) continue
    seen.add(key)
    seenByDay.set(row.day, seen)
    groups.set(row.day, [...(groups.get(row.day) ?? []), track])
  }

  return Array.from(groups.entries()).map(([date, tracks]) => ({ date, tracks }))
}

export function hideRecommendedTrackHistoryDates(dates: string[]): void {
  const uniqueDates = Array.from(new Set(dates.map((date) => date.trim()).filter(Boolean)))
  if (uniqueDates.length === 0) return
  const insert = getDb().prepare(`
    INSERT INTO queue_history_hidden_dates (user_id, date, hidden_at)
    VALUES (1, ?, ?)
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
      WHERE user_id = 1
      ORDER BY listened_at DESC, id DESC
      LIMIT ?
    `)
    .all(limit)
    .map((row) => {
      const typed = row as { title: string; artist: string; album?: string; source?: string; listened_at: string; meta_json?: string }
      const parsed = typed.meta_json ? (JSON.parse(typed.meta_json) as Track) : null
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
      WHERE user_id = 1
        AND source = 'recommended_by_echo'
        AND date(listened_at, 'localtime') = date('now', 'localtime')
      ORDER BY listened_at DESC, id DESC
    `)
    .all() as Array<{ id: number; meta_json?: string }>

  const targetKey = queueTrackKey(track)
  const target = rows.find((row) => {
    const parsed = row.meta_json ? JSON.parse(row.meta_json) as Track : null
    return parsed ? queueTrackKey(parsed) === targetKey : false
  })
  if (!target?.meta_json) return

  const parsed = JSON.parse(target.meta_json) as Track
  const next: Track = {
    ...parsed,
    queueStatus: status,
  }
  getDb().prepare('UPDATE tracks_listened SET meta_json = ? WHERE id = ?').run(JSON.stringify(next), target.id)
}
