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
  queueStatusReason?: Track['queueStatusReason']
  echoNote?: string
  recommendSource?: string
  reason?: string
  sourceContext?: Track['sourceContext']
  agentActionId?: string
  agentActionItemId?: string
  playbackInstanceId?: string
}

export interface ProfileTrackEvent {
  track: Track
  listenedAt: string
  source?: string
  queueStatus?: Track['queueStatus']
  queueStatusReason?: Track['queueStatusReason']
}

export interface ListenedTrackWindows {
  recent: Track[]
  history: Track[]
}

const PASSIVE_IMPORTED_TRACK_SOURCES = new Set([
  'manual_import',
  'playlist_import',
  'netease_playlist_import',
  'imported_playlist',
  'imported',
  'import',
])

const NON_EXTERNAL_LISTENING_SOURCES = ['', 'recommended_by_echo', ...PASSIVE_IMPORTED_TRACK_SOURCES] as const
const NON_EXTERNAL_LISTENING_SOURCE_SQL = NON_EXTERNAL_LISTENING_SOURCES.map((source) => `'${source}'`).join(', ')

const SAME_DAY_MEANINGFUL_TRACK_EVENT_SQL = `
  LOWER(COALESCE(source, '')) NOT IN (${NON_EXTERNAL_LISTENING_SOURCE_SQL})
  OR (
    json_valid(meta_json)
    AND (
      json_extract(meta_json, '$.queueStatus') IN ('playing', 'completed')
      OR (
        json_extract(meta_json, '$.queueStatus') = 'skipped'
        AND COALESCE(json_extract(meta_json, '$.queueStatusReason'), 'playback_skipped') IN ('playback_skipped', 'explicit_feedback')
      )
    )
  )
`

const PROFILE_TRACK_EVENT_SQL = `
  LOWER(COALESCE(source, '')) NOT IN (${NON_EXTERNAL_LISTENING_SOURCE_SQL})
  OR (
    json_valid(meta_json)
    AND (
      json_extract(meta_json, '$.queueStatus') = 'completed'
      OR (
        json_extract(meta_json, '$.queueStatus') = 'skipped'
        AND COALESCE(json_extract(meta_json, '$.queueStatusReason'), 'playback_skipped') IN ('playback_skipped', 'explicit_feedback')
      )
    )
  )
`

function queueTrackKey(track: Track): string {
  return trackIdentity(track)
}

function parseTrack(row: { title: string; artist: string; album?: string; source?: string; meta_json?: string }): Track {
  return row.meta_json ? parseJson<Track>(row.meta_json, { title: row.title, artist: row.artist, album: row.album, source: row.source }, 'tracks_listened.meta_json') : { title: row.title, artist: row.artist, album: row.album, source: row.source }
}

type TrackEventRow = {
  title: string
  artist: string
  album?: string
  source?: string
  listened_at: string
  meta_json?: string
}

function toTodayTrackEvent(typed: TrackEventRow): TodayTrackEvent {
  const parsed = typed.meta_json ? parseJson<Track | null>(typed.meta_json, null, 'tracks_listened.meta_json') : null
  return {
    title: typed.title,
    artist: typed.artist,
    album: typed.album,
    source: typed.source,
    listenedAt: typed.listened_at,
    queueStatus: parsed?.queueStatus,
    queueStatusReason: parsed?.queueStatusReason,
    echoNote: parsed?.echoNote ?? parsed?.reason,
    recommendSource: parsed?.recommendSource,
    reason: parsed?.reason,
    sourceContext: parsed?.sourceContext,
    agentActionId: parsed?.agentActionId,
    agentActionItemId: parsed?.agentActionItemId,
    playbackInstanceId: parsed?.playbackInstanceId,
  }
}

function parseSqliteTimestampMs(value: string): number {
  const parsed = Date.parse(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`)
  return Number.isFinite(parsed) ? parsed : 0
}

function boundedPositiveInteger(value: number, fallback: number, max: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.min(max, Math.max(1, Math.floor(value)))
}

function mergeRecommendedQueueStatus(
  existing?: Pick<Track, 'queueStatus' | 'queueStatusReason'>,
  incoming?: Pick<Track, 'queueStatus' | 'queueStatusReason'>,
): Pick<Track, 'queueStatus' | 'queueStatusReason'> {
  if (incoming?.queueStatus && incoming.queueStatus !== 'pending') {
    return {
      queueStatus: incoming.queueStatus,
      queueStatusReason: incoming.queueStatusReason,
    }
  }
  if (existing?.queueStatus === 'playing' || existing?.queueStatus === 'completed' || existing?.queueStatus === 'skipped') {
    return {
      queueStatus: existing.queueStatus,
      queueStatusReason: existing.queueStatusReason,
    }
  }
  return {
    queueStatus: incoming?.queueStatus ?? 'pending',
    queueStatusReason: incoming?.queueStatusReason,
  }
}

function shouldMarkRecommendedTrackSkippedOnReplace(track: Pick<Track, 'queueStatus'> | null): boolean {
  return Boolean(track && track.queueStatus !== 'completed' && track.queueStatus !== 'skipped')
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
      const queueStatus = mergeRecommendedQueueStatus(current?.track, track)
      const enriched: Track = {
        ...(current?.track ?? {}),
        ...track,
        recommendedAt,
        ...queueStatus,
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

export function skipTodayRecommendedTracks(reason: Track['queueStatusReason'] = 'scene_replaced'): void {
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
      if (!shouldMarkRecommendedTrackSkippedOnReplace(parsed)) continue
      update.run(JSON.stringify({
        ...parsed,
        queueStatus: 'skipped',
        queueStatusReason: reason,
        queueStatusAt: new Date().toISOString(),
      }), row.id)
    }
  })
  write(rows)
}

export function loadRecentTracks(limit = 20): Track[] {
  return loadTracksForDate(new Date().toLocaleDateString('sv-SE'), limit)
}

export function loadTracksForDate(date: string, limit = 20): Track[] {
  return getDb()
    .prepare(`
      SELECT title, artist, album, source, meta_json
      FROM tracks_listened
      WHERE user_id = current_user_id()
        AND source = 'recommended_by_echo'
        AND date(listened_at, 'localtime') = date(?)
      ORDER BY listened_at DESC, id DESC
      LIMIT ?
    `)
    .all(date, limit)
    .map((row) => {
      const typed = row as { title: string; artist: string; album?: string; source?: string; meta_json?: string }
      return parseTrack(typed)
    })
}

export function hasListeningEvidenceForDate(date: string): boolean {
  return loadMeaningfulTrackEventsForDate(date, 1).length > 0
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
  return loadTrackEventsForDate(new Date().toLocaleDateString('sv-SE'), limit)
}

export function loadTodayMeaningfulTrackEvents(limit = 60): TodayTrackEvent[] {
  return loadMeaningfulTrackEventsForDate(new Date().toLocaleDateString('sv-SE'), limit)
}

export function loadTrackEventsForDate(date: string, limit = 60): TodayTrackEvent[] {
  return getDb()
    .prepare(`
      SELECT title, artist, album, source, listened_at, meta_json
      FROM tracks_listened
      WHERE user_id = current_user_id()
        AND date(listened_at, 'localtime') = date(?)
      ORDER BY listened_at ASC, id ASC
      LIMIT ?
    `)
    .all(date, limit)
    .map((row) => toTodayTrackEvent(row as TrackEventRow))
}

export function isMeaningfulSkippedReason(reason?: Track['queueStatusReason']): boolean {
  return !reason || reason === 'playback_skipped' || reason === 'explicit_feedback'
}

export function isExternalListeningSource(source?: string): boolean {
  const clean = source?.trim().toLowerCase()
  return Boolean(clean && clean !== 'recommended_by_echo' && !PASSIVE_IMPORTED_TRACK_SOURCES.has(clean))
}

export function isMeaningfulTrackEvent(event: Pick<TodayTrackEvent, 'source' | 'queueStatus' | 'queueStatusReason'>): boolean {
  return isExternalListeningSource(event.source)
    || event.queueStatus === 'playing'
    || event.queueStatus === 'completed'
    || (event.queueStatus === 'skipped' && isMeaningfulSkippedReason(event.queueStatusReason))
}

export function isMeaningfulProfileTrackEvent(event: Pick<ProfileTrackEvent, 'source' | 'queueStatus' | 'queueStatusReason'>): boolean {
  return isExternalListeningSource(event.source)
    || event.queueStatus === 'completed'
    || (event.queueStatus === 'skipped' && isMeaningfulSkippedReason(event.queueStatusReason))
}

export function isLongTermRecommendationCooldownTrack(event: Pick<Track, 'source' | 'queueStatus' | 'queueStatusReason'>): boolean {
  return isExternalListeningSource(event.source)
    || event.queueStatus === 'playing'
    || event.queueStatus === 'completed'
    || (event.queueStatus === 'skipped' && isMeaningfulSkippedReason(event.queueStatusReason))
}

export function loadMeaningfulTrackEventsForDate(date: string, limit = 60): TodayTrackEvent[] {
  const safeLimit = Math.max(1, Math.min(500, Math.floor(limit)))
  const rows = getDb()
    .prepare(`
      SELECT title, artist, album, source, listened_at, meta_json
      FROM tracks_listened
      WHERE user_id = current_user_id()
        AND date(listened_at, 'localtime') = date(?)
        AND (${SAME_DAY_MEANINGFUL_TRACK_EVENT_SQL})
      ORDER BY listened_at DESC, id DESC
      LIMIT ?
    `)
    .all(date, safeLimit) as TrackEventRow[]
  return rows.reverse().map(toTodayTrackEvent)
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
        AND (${PROFILE_TRACK_EVENT_SQL})
      ORDER BY listened_at DESC, id DESC
      LIMIT ?
    `)
    .all(limit)
    .map((row) => toProfileTrackEvent(row as { title: string; artist: string; album?: string; source?: string; listened_at: string; meta_json?: string }))
}

function toProfileTrackEvent(row: { title: string; artist: string; album?: string; source?: string; listened_at: string; meta_json?: string }): ProfileTrackEvent {
  const parsed = row.meta_json ? parseJson<Track | null>(row.meta_json, null, 'tracks_listened.meta_json') : null
  return {
    track: parsed ?? { title: row.title, artist: row.artist, album: row.album, source: row.source },
    listenedAt: row.listened_at,
    source: row.source,
    queueStatus: parsed?.queueStatus,
    queueStatusReason: parsed?.queueStatusReason,
  }
}

export function loadProfileTrackEventsBetween(startDaysAgo: number, endDaysAgo = 0, limit = 5000): ProfileTrackEvent[] {
  const safeStart = boundedPositiveInteger(startDaysAgo, 30, 365)
  const safeEnd = Math.max(0, Math.min(safeStart, Math.floor(Number.isFinite(endDaysAgo) ? endDaysAgo : 0)))
  const safeLimit = boundedPositiveInteger(limit, 500, 20000)
  return getDb()
    .prepare(`
      SELECT title, artist, album, source, listened_at, meta_json
      FROM tracks_listened
      WHERE user_id = current_user_id()
        AND listened_at >= datetime('now', ?)
        AND listened_at < datetime('now', ?)
        AND (${PROFILE_TRACK_EVENT_SQL})
      ORDER BY listened_at DESC, id DESC
      LIMIT ?
    `)
    .all(`-${safeStart} days`, `-${safeEnd} days`, safeLimit)
    .map((row) => toProfileTrackEvent(row as { title: string; artist: string; album?: string; source?: string; listened_at: string; meta_json?: string }))
}

export function updateRecommendedTrackStatus(track: Track, status: NonNullable<Track['queueStatus']>, reason?: Track['queueStatusReason']): void {
  const rows = getDb()
    .prepare(`
      SELECT id, meta_json
      FROM tracks_listened
      WHERE user_id = current_user_id()
        AND source = 'recommended_by_echo'
      ORDER BY listened_at DESC, id DESC
      LIMIT 500
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
    agentActionId: track.agentActionId ?? parsed.agentActionId,
    agentActionItemId: track.agentActionItemId ?? parsed.agentActionItemId,
    stageContextId: track.stageContextId ?? parsed.stageContextId,
    playbackInstanceId: track.playbackInstanceId ?? parsed.playbackInstanceId,
    queueStatus: status,
    queueStatusReason: reason,
    queueStatusAt: new Date().toISOString(),
  }
  getDb().prepare('UPDATE tracks_listened SET meta_json = ? WHERE id = ?').run(JSON.stringify(next), target.id)
}

export const tracksTestHelpers = {
  mergeRecommendedQueueStatus,
  shouldMarkRecommendedTrackSkippedOnReplace,
  isLongTermRecommendationCooldownTrack,
  isExternalListeningSource,
}
