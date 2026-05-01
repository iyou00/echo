import type { Track } from '../../types/ipc'
import type { ExplicitTrackFeedbackAction } from '../../types/ipc'
import { clearRecommendationCache } from './recommendationCache'
import { getDb } from './index'

export type TrackFeedbackAction = 'played' | 'skipped' | 'looped' | 'favorited' | 'unfavorited'

export interface TrackFeedback {
  trackKey: string
  track: Track
  playCount: number
  skipCount: number
  loopCount: number
  favoriteCount: number
  lastCompletion?: number
  updatedAt?: string
  score: number
}

export interface ExplicitTrackFeedback {
  trackKey: string
  action: ExplicitTrackFeedbackAction
  context?: string
  track: Track
  createdAt?: string
}

export function feedbackTrackKey(track: Track): string {
  const neteaseId = String(track.neteaseId ?? '').trim()
  if (neteaseId) return `netease:${neteaseId}`
  const id = String(track.id ?? '').trim()
  if (id) return `id:${id}`
  return `name:${track.title.trim().toLowerCase()}::${track.artist.trim().toLowerCase()}`
}

function weightedScore(row: { play_count: number; skip_count: number; loop_count: number; favorite_count: number; last_completion?: number | null }): number {
  const completion = typeof row.last_completion === 'number' ? row.last_completion : 0
  return Number((
    row.play_count * 1.1 +
    row.loop_count * 2.2 +
    row.favorite_count * 2.5 +
    completion * 0.8 -
    row.skip_count * 1.6
  ).toFixed(2))
}

function explicitFeedbackFromRow(row: { track_key: string; action: ExplicitTrackFeedbackAction; context?: string; track_json: string; created_at?: string }): ExplicitTrackFeedback {
  return {
    trackKey: row.track_key,
    action: row.action,
    context: row.context || undefined,
    track: JSON.parse(row.track_json) as Track,
    createdAt: row.created_at,
  }
}

export function recordTrackFeedback(action: TrackFeedbackAction, track: Track, completionRate?: number): void {
  const key = feedbackTrackKey(track)
  getDb()
    .prepare(`
      INSERT INTO track_feedback (user_id, track_key, title, artist, album, source, track_json)
      VALUES (1, ?, ?, ?, ?, ?, ?)
      ON CONFLICT(track_key) DO UPDATE SET
        title = excluded.title,
        artist = excluded.artist,
        album = excluded.album,
        source = excluded.source,
        track_json = excluded.track_json
    `)
    .run(key, track.title, track.artist, track.album ?? '', track.source ?? '', JSON.stringify(track))

  const fields: Record<TrackFeedbackAction, string> = {
    played: 'play_count = play_count + 1',
    skipped: 'skip_count = skip_count + 1',
    looped: 'loop_count = loop_count + 1',
    favorited: 'favorite_count = 1',
    unfavorited: 'favorite_count = 0',
  }
  getDb()
    .prepare(`
      UPDATE track_feedback
      SET ${fields[action]},
          last_completion = COALESCE(?, last_completion),
          updated_at = CURRENT_TIMESTAMP
      WHERE user_id = 1 AND track_key = ?
    `)
    .run(typeof completionRate === 'number' ? Math.max(0, Math.min(1, completionRate)) : null, key)
  clearRecommendationCache()
}

export function recordExplicitTrackFeedback(action: ExplicitTrackFeedbackAction, track: Track, context?: string): void {
  const key = feedbackTrackKey(track)
  getDb()
    .prepare(`
      INSERT INTO track_feedback_events (user_id, track_key, action, context, title, artist, album, source, track_json)
      VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?)
    `)
    .run(key, action, context ?? '', track.title, track.artist, track.album ?? '', track.source ?? '', JSON.stringify(track))

  recordTrackFeedback(action === 'more_like_this' ? 'played' : 'skipped', track, action === 'more_like_this' ? 1 : 0)
}

export function listExplicitTrackFeedback(limit = 80): ExplicitTrackFeedback[] {
  const rows = getDb()
    .prepare(`
      SELECT track_key, action, context, track_json, created_at
      FROM track_feedback_events
      WHERE user_id = 1
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `)
    .all(limit) as Array<{ track_key: string; action: ExplicitTrackFeedbackAction; context?: string; track_json: string; created_at?: string }>
  return rows.map(explicitFeedbackFromRow)
}

export function listTodayExplicitTrackFeedback(limit = 80): ExplicitTrackFeedback[] {
  const rows = getDb()
    .prepare(`
      SELECT track_key, action, context, track_json, created_at
      FROM track_feedback_events
      WHERE user_id = 1
        AND date(created_at, 'localtime') = date('now', 'localtime')
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `)
    .all(limit) as Array<{ track_key: string; action: ExplicitTrackFeedbackAction; context?: string; track_json: string; created_at?: string }>
  return rows.map(explicitFeedbackFromRow)
}

export function getExplicitFeedbackScore(track: Track): number {
  const row = getDb()
    .prepare(`
      SELECT
        SUM(CASE WHEN action = 'more_like_this' THEN 1 ELSE 0 END) AS likes,
        SUM(CASE WHEN action = 'not_right' THEN 1 ELSE 0 END) AS misses
      FROM track_feedback_events
      WHERE user_id = 1 AND track_key = ?
    `)
    .get(feedbackTrackKey(track)) as { likes?: number | null; misses?: number | null } | undefined
  return Number(row?.likes ?? 0) * 3 - Number(row?.misses ?? 0) * 4
}

export function getTrackFeedback(track: Track): TrackFeedback | null {
  const row = getDb()
    .prepare(`
      SELECT track_key, play_count, skip_count, loop_count, favorite_count, last_completion, track_json, updated_at
      FROM track_feedback
      WHERE user_id = 1 AND track_key = ?
    `)
    .get(feedbackTrackKey(track)) as {
      track_key: string
      play_count: number
      skip_count: number
      loop_count: number
      favorite_count: number
      last_completion?: number | null
      track_json: string
      updated_at?: string
    } | undefined
  if (!row) return null
  return {
    trackKey: row.track_key,
    track: JSON.parse(row.track_json) as Track,
    playCount: row.play_count,
    skipCount: row.skip_count,
    loopCount: row.loop_count,
    favoriteCount: row.favorite_count,
    lastCompletion: typeof row.last_completion === 'number' ? row.last_completion : undefined,
    updatedAt: row.updated_at,
    score: weightedScore(row),
  }
}

export function getFeedbackScore(track: Track): number {
  return (getTrackFeedback(track)?.score ?? 0) + getExplicitFeedbackScore(track)
}

export function listTrackFeedback(limit = 300): TrackFeedback[] {
  const rows = getDb()
    .prepare(`
      SELECT track_key, play_count, skip_count, loop_count, favorite_count, last_completion, track_json, updated_at
      FROM track_feedback
      WHERE user_id = 1
      ORDER BY updated_at DESC, id DESC
      LIMIT ?
    `)
    .all(limit) as Array<{
      track_key: string
      play_count: number
      skip_count: number
      loop_count: number
      favorite_count: number
      last_completion?: number | null
      track_json: string
      updated_at?: string
    }>

  return rows.map((row) => ({
    trackKey: row.track_key,
    track: JSON.parse(row.track_json) as Track,
    playCount: row.play_count,
    skipCount: row.skip_count,
    loopCount: row.loop_count,
    favoriteCount: row.favorite_count,
    lastCompletion: typeof row.last_completion === 'number' ? row.last_completion : undefined,
    updatedAt: row.updated_at,
    score: weightedScore(row),
  }))
}

export function getFeedbackSignalCount(): number {
  const row = getDb()
    .prepare(`
      SELECT COALESCE(SUM(play_count + skip_count + loop_count + favorite_count), 0) AS total
      FROM track_feedback
      WHERE user_id = 1
    `)
    .get() as { total: number } | undefined
  return Number(row?.total ?? 0)
}
