import type { Track } from '../../types/ipc'
import type { ExplicitTrackFeedbackAction } from '../../types/ipc'
import { trackIdentity } from '../../shared/trackIdentity'
import { clearRecommendationCache } from './recommendationCache'
import { getDb } from './index'
import { parseJson } from './json'

export type TrackFeedbackAction = 'played' | 'skipped' | 'looped' | 'favorited' | 'unfavorited'

export interface TrackFeedback {
  trackKey: string
  track: Track
  playCount: number
  skipCount: number
  loopCount: number
  favoriteCount: number
  explicitLikeCount: number
  explicitMissCount: number
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
  return trackIdentity(track)
}

interface TrackFeedbackRow {
  track_key: string
  play_count: number
  skip_count: number
  loop_count: number
  favorite_count: number
  explicit_like_count?: number | null
  explicit_miss_count?: number | null
  last_completion?: number | null
  track_json: string
  updated_at?: string
}

const TRACK_FEEDBACK_SELECT = `
  tf.track_key,
  tf.play_count,
  tf.skip_count,
  tf.loop_count,
  tf.favorite_count,
  tf.last_completion,
  tf.track_json,
  tf.updated_at,
  COALESCE((
    SELECT COUNT(*)
    FROM track_feedback_events tfe
    WHERE tfe.user_id = tf.user_id
      AND tfe.track_key = tf.track_key
      AND tfe.action = 'more_like_this'
  ), 0) AS explicit_like_count,
  COALESCE((
    SELECT COUNT(*)
    FROM track_feedback_events tfe
    WHERE tfe.user_id = tf.user_id
      AND tfe.track_key = tf.track_key
      AND tfe.action = 'not_right'
  ), 0) AS explicit_miss_count
`

function explicitScore(likes?: number | null, misses?: number | null): number {
  return Number(likes ?? 0) * 3 - Number(misses ?? 0) * 4
}

function weightedScore(row: {
  play_count: number
  skip_count: number
  loop_count: number
  favorite_count: number
  explicit_like_count?: number | null
  explicit_miss_count?: number | null
  last_completion?: number | null
}): number {
  const completion = typeof row.last_completion === 'number' ? row.last_completion : 0
  return Number((
    row.play_count * 1.1 +
    row.loop_count * 2.2 +
    row.favorite_count * 2.5 +
    explicitScore(row.explicit_like_count, row.explicit_miss_count) +
    completion * 0.8 -
    row.skip_count * 1.6
  ).toFixed(2))
}

function trackFeedbackFromRow(row: TrackFeedbackRow): TrackFeedback {
  return {
    trackKey: row.track_key,
    track: parseJson<Track>(row.track_json, { title: '', artist: '' }, 'track_feedback.track_json'),
    playCount: row.play_count,
    skipCount: row.skip_count,
    loopCount: row.loop_count,
    favoriteCount: row.favorite_count,
    explicitLikeCount: Number(row.explicit_like_count ?? 0),
    explicitMissCount: Number(row.explicit_miss_count ?? 0),
    lastCompletion: typeof row.last_completion === 'number' ? row.last_completion : undefined,
    updatedAt: row.updated_at,
    score: weightedScore(row),
  }
}

function explicitFeedbackFromRow(row: { track_key: string; action: ExplicitTrackFeedbackAction; context?: string; track_json: string; created_at?: string }): ExplicitTrackFeedback {
  return {
    trackKey: row.track_key,
    action: row.action,
    context: row.context || undefined,
    track: parseJson<Track>(row.track_json, { title: '', artist: '' }, 'track_feedback_events.track_json'),
    createdAt: row.created_at,
  }
}

export function recordTrackFeedback(action: TrackFeedbackAction, track: Track, completionRate?: number): void {
  const db = getDb()
  const key = feedbackTrackKey(track)
  db.transaction(() => {
    db
      .prepare(`
        INSERT INTO track_feedback (user_id, track_key, title, artist, album, source, track_json)
        VALUES (current_user_id(), ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, track_key) DO UPDATE SET
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
    db
      .prepare(`
        UPDATE track_feedback
        SET ${fields[action]},
            last_completion = COALESCE(?, last_completion),
            updated_at = CURRENT_TIMESTAMP
        WHERE user_id = current_user_id() AND track_key = ?
      `)
      .run(typeof completionRate === 'number' ? Math.max(0, Math.min(1, completionRate)) : null, key)
  })()
  clearRecommendationCache()
}

export function recordExplicitTrackFeedback(action: ExplicitTrackFeedbackAction, track: Track, context?: string): void {
  const db = getDb()
  const key = feedbackTrackKey(track)
  db.transaction(() => {
    const eventResult = db
      .prepare(`
        INSERT INTO track_feedback_events (
          user_id, track_key, action, context, title, artist, album, source, track_json,
          agent_action_id, agent_action_item_id
        ) VALUES (current_user_id(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `)
      .run(key, action, context ?? '', track.title, track.artist, track.album ?? '', track.source ?? '', JSON.stringify(track),
        track.agentActionId ?? null, track.agentActionItemId ?? null)

    if (track.agentActionId) {
      db.prepare(`
        INSERT OR IGNORE INTO agent_action_outcomes (
          user_id, action_id, action_item_id, source_event_key, outcome_type, polarity, strength, occurred_at, metadata_json
        ) VALUES (current_user_id(), ?, ?, ?, ?, ?, 'strong', CURRENT_TIMESTAMP, ?)
      `).run(
        track.agentActionId,
        track.agentActionItemId ?? null,
        `explicit_feedback:${String(eventResult.lastInsertRowid)}`,
        action === 'more_like_this' ? 'explicit_like' : 'explicit_miss',
        action === 'more_like_this' ? 'positive' : 'negative',
        JSON.stringify({ userAgency: 'active' }),
      )
    }

    db
      .prepare(`
        INSERT INTO track_feedback (user_id, track_key, title, artist, album, source, track_json)
        VALUES (current_user_id(), ?, ?, ?, ?, ?, ?)
        ON CONFLICT(user_id, track_key) DO UPDATE SET
          title = excluded.title,
          artist = excluded.artist,
          album = excluded.album,
          source = excluded.source,
          track_json = excluded.track_json,
          updated_at = CURRENT_TIMESTAMP
      `)
      .run(key, track.title, track.artist, track.album ?? '', track.source ?? '', JSON.stringify(track))
  })()
  clearRecommendationCache()
}

export function listExplicitTrackFeedback(limit = 80): ExplicitTrackFeedback[] {
  const rows = getDb()
    .prepare(`
      SELECT track_key, action, context, track_json, created_at
      FROM track_feedback_events
      WHERE user_id = current_user_id()
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
      WHERE user_id = current_user_id()
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
      WHERE user_id = current_user_id() AND track_key = ?
    `)
    .get(feedbackTrackKey(track)) as { likes?: number | null; misses?: number | null } | undefined
  return explicitScore(row?.likes, row?.misses)
}

export function getTrackFeedback(track: Track): TrackFeedback | null {
  const row = getDb()
    .prepare(`
      SELECT ${TRACK_FEEDBACK_SELECT}
      FROM track_feedback tf
      WHERE tf.user_id = current_user_id() AND tf.track_key = ?
    `)
    .get(feedbackTrackKey(track)) as TrackFeedbackRow | undefined
  if (!row) return null
  return trackFeedbackFromRow(row)
}

export function getFeedbackScore(track: Track): number {
  return getTrackFeedback(track)?.score ?? getExplicitFeedbackScore(track)
}

export function listTrackFeedback(limit = 300): TrackFeedback[] {
  const rows = getDb()
    .prepare(`
      SELECT ${TRACK_FEEDBACK_SELECT}
      FROM track_feedback tf
      WHERE tf.user_id = current_user_id()
      ORDER BY tf.updated_at DESC, tf.id DESC
      LIMIT ?
    `)
    .all(limit) as TrackFeedbackRow[]

  return rows.map(trackFeedbackFromRow)
}

function uniqueFeedbackRows(rows: TrackFeedbackRow[]): TrackFeedbackRow[] {
  const seen = new Set<string>()
  return rows.filter((row) => {
    if (seen.has(row.track_key)) return false
    seen.add(row.track_key)
    return true
  })
}

export function listProfileTrackFeedback(recentLimit = 300, stableLimit = 300): TrackFeedback[] {
  const safeRecentLimit = Math.max(1, Math.min(2000, Math.floor(Number.isFinite(recentLimit) ? recentLimit : 300)))
  const safeStableLimit = Math.max(1, Math.min(2000, Math.floor(Number.isFinite(stableLimit) ? stableLimit : 300)))
  const db = getDb()
  const recentRows = db
    .prepare(`
      SELECT ${TRACK_FEEDBACK_SELECT}
      FROM track_feedback tf
      WHERE tf.user_id = current_user_id()
      ORDER BY tf.updated_at DESC, tf.id DESC
      LIMIT ?
    `)
    .all(safeRecentLimit) as TrackFeedbackRow[]
  const stableRows = db
    .prepare(`
      SELECT ${TRACK_FEEDBACK_SELECT}
      FROM track_feedback tf
      WHERE tf.user_id = current_user_id()
      ORDER BY
        tf.favorite_count DESC,
        explicit_like_count DESC,
        tf.loop_count DESC,
        tf.play_count DESC,
        tf.updated_at DESC,
        tf.id DESC
      LIMIT ?
    `)
    .all(safeStableLimit) as TrackFeedbackRow[]

  return uniqueFeedbackRows([...recentRows, ...stableRows]).map(trackFeedbackFromRow)
}

export function listTrackFeedbackUpdatedSince(days: number, limit = 300): TrackFeedback[] {
  const safeDays = Math.max(1, Math.min(365, Math.floor(Number.isFinite(days) ? days : 7)))
  const safeLimit = Math.max(1, Math.min(5000, Math.floor(Number.isFinite(limit) ? limit : 300)))
  const rows = getDb()
    .prepare(`
      SELECT ${TRACK_FEEDBACK_SELECT}
      FROM track_feedback tf
      WHERE tf.user_id = current_user_id()
        AND tf.updated_at >= datetime('now', ?)
      ORDER BY tf.updated_at DESC, tf.id DESC
      LIMIT ?
    `)
    .all(`-${safeDays} days`, safeLimit) as TrackFeedbackRow[]

  return rows.map(trackFeedbackFromRow)
}

export function getFeedbackSignalCount(): number {
  const row = getDb()
    .prepare(`
      SELECT
        (
          SELECT COALESCE(SUM(play_count + skip_count + loop_count + favorite_count), 0)
          FROM track_feedback
          WHERE user_id = current_user_id()
        ) + (
          SELECT COUNT(*)
          FROM track_feedback_events
          WHERE user_id = current_user_id()
        ) AS total
    `)
    .get() as { total: number } | undefined
  return Number(row?.total ?? 0)
}

export function getLatestFeedbackUpdatedAt(): string | null {
  const row = getDb()
    .prepare(`
      SELECT MAX(updated_at) AS updated_at
      FROM (
        SELECT updated_at
        FROM track_feedback
        WHERE user_id = current_user_id()
        UNION ALL
        SELECT created_at AS updated_at
        FROM track_feedback_events
        WHERE user_id = current_user_id()
      )
    `)
    .get() as { updated_at?: string | null } | undefined
  return row?.updated_at ?? null
}
