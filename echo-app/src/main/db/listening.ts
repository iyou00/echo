import type { Track } from '../../types/ipc'
import { trackIdentity } from '../../shared/trackIdentity'
import type { CompanionResponseMode } from '../services/chat/companionTypes'
import type {
  ListeningDensity,
  ListeningDelivery,
  ListeningMove,
  ListeningSentenceForm,
  ListeningSegmentRecord,
  ListeningSessionRecord,
  ListeningTopicSource,
} from '../services/listeningTypes'
import { getDb } from './index'
import { parseJson } from './json'

const SESSION_IDLE_MINUTES = 45

interface SessionRow {
  id: number
  status: 'active' | 'ended'
  started_at: string
  last_active_at: string
  ended_at?: string | null
  segment_count: number
  companion_mode?: CompanionResponseMode | null
  consumed_event_keys_json?: string | null
}

interface SegmentRow {
  id: number
  session_id: number
  track_key: string
  track_json: string | null
  text: string
  delivery: ListeningDelivery
  density: ListeningDensity
  move: ListeningMove
  sentence_form: ListeningSentenceForm
  topic_source: ListeningTopicSource
  signature: string
  generated_at: string
}

function mapSession(row: SessionRow): ListeningSessionRecord {
  const consumedEventKeys = parseJson<unknown>(row.consumed_event_keys_json, [], 'listening_sessions.consumed_event_keys_json')
  return {
    id: row.id,
    status: row.status,
    startedAt: row.started_at,
    lastActiveAt: row.last_active_at,
    endedAt: row.ended_at,
    segmentCount: row.segment_count,
    companionMode: row.companion_mode ?? null,
    consumedEventKeys: Array.isArray(consumedEventKeys)
      ? consumedEventKeys.map(String).filter(Boolean).slice(-100)
      : [],
  }
}

function mapSegment(row: SegmentRow): ListeningSegmentRecord {
  return {
    id: row.id,
    sessionId: row.session_id,
    trackKey: row.track_key,
    track: parseJson<Track | null>(row.track_json, null, 'listening_segments.track_json'),
    text: row.text,
    delivery: row.delivery,
    density: row.density,
    move: row.move,
    sentenceForm: row.sentence_form,
    topicSource: row.topic_source,
    signature: row.signature,
    generatedAt: row.generated_at,
  }
}

export function startListeningSession(now = new Date()): ListeningSessionRecord {
  const timestamp = now.toISOString()
  const database = getDb()
  const create = database.transaction(() => {
    database.prepare(`
      UPDATE listening_sessions
      SET status = 'ended', ended_at = ?, last_active_at = ?
      WHERE user_id = current_user_id() AND status = 'active'
    `).run(timestamp, timestamp)
    const result = database.prepare(`
      INSERT INTO listening_sessions (user_id, status, started_at, last_active_at, segment_count)
      VALUES (current_user_id(), 'active', ?, ?, 0)
    `).run(timestamp, timestamp)
    return database.prepare('SELECT * FROM listening_sessions WHERE id = ?').get(result.lastInsertRowid) as SessionRow
  })
  return mapSession(create())
}

export function loadActiveListeningSession(now = new Date()): ListeningSessionRecord | null {
  const row = getDb().prepare(`
    SELECT *
    FROM listening_sessions
    WHERE user_id = current_user_id()
      AND status = 'active'
      AND datetime(last_active_at) >= datetime(?, '-' || ? || ' minutes')
    ORDER BY last_active_at DESC, id DESC
    LIMIT 1
  `).get(now.toISOString(), SESSION_IDLE_MINUTES) as SessionRow | undefined
  return row ? mapSession(row) : null
}

export function getOrCreateListeningSession(continuation: boolean, now = new Date()): ListeningSessionRecord {
  if (continuation) {
    const active = loadActiveListeningSession(now)
    if (active) return active
  }
  return startListeningSession(now)
}

export function loadListeningSegments(sessionId: number, limit = 12): ListeningSegmentRecord[] {
  const rows = getDb().prepare(`
    SELECT *
    FROM listening_segments
    WHERE user_id = current_user_id() AND session_id = ?
    ORDER BY generated_at DESC, id DESC
    LIMIT ?
  `).all(sessionId, Math.max(1, Math.min(50, limit))) as SegmentRow[]
  return rows.map(mapSegment)
}

export function appendListeningSegment(input: {
  sessionId: number
  track: Track | null
  text: string
  delivery: ListeningDelivery
  density: ListeningDensity
  move: ListeningMove
  sentenceForm: ListeningSentenceForm
  topicSource: ListeningTopicSource
  signature: string
  companionMode?: CompanionResponseMode | null
  consumedEventKeys?: string[]
  generatedAt?: string
}): ListeningSegmentRecord {
  const generatedAt = input.generatedAt ?? new Date().toISOString()
  const database = getDb()
  const append = database.transaction(() => {
    const session = database.prepare(`
      SELECT companion_mode, consumed_event_keys_json
      FROM listening_sessions
      WHERE id = ? AND user_id = current_user_id() AND status = 'active'
    `).get(input.sessionId) as Pick<SessionRow, 'companion_mode' | 'consumed_event_keys_json'> | undefined
    if (!session) throw new Error('连续回声会话已经结束')
    const storedEventKeys = parseJson<unknown>(session.consumed_event_keys_json, [], 'listening_sessions.consumed_event_keys_json')
    const consumedEventKeys = Array.from(new Set([
      ...(Array.isArray(storedEventKeys) ? storedEventKeys.map(String).filter(Boolean) : []),
      ...(input.consumedEventKeys ?? []).map(String).filter(Boolean),
    ])).slice(-100)
    const companionMode = input.companionMode === undefined
      ? session.companion_mode ?? null
      : input.companionMode
    const result = database.prepare(`
      INSERT INTO listening_segments (
        user_id, session_id, track_key, track_json, text, delivery, density,
        move, sentence_form, topic_source, signature, generated_at
      ) VALUES (
        current_user_id(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      )
    `).run(
      input.sessionId,
      trackIdentity(input.track),
      input.track ? JSON.stringify(input.track) : null,
      input.text,
      input.delivery,
      input.density,
      input.move,
      input.sentenceForm,
      input.topicSource,
      input.signature,
      generatedAt,
    )
    database.prepare(`
      UPDATE listening_sessions
      SET segment_count = segment_count + 1,
          last_active_at = ?,
          companion_mode = ?,
          consumed_event_keys_json = ?
      WHERE id = ? AND user_id = current_user_id()
    `).run(generatedAt, companionMode, JSON.stringify(consumedEventKeys), input.sessionId)
    return database.prepare('SELECT * FROM listening_segments WHERE id = ?').get(result.lastInsertRowid) as SegmentRow
  })
  return mapSegment(append())
}

export function endListeningSession(sessionId?: number, now = new Date()): void {
  const timestamp = now.toISOString()
  if (sessionId !== undefined) {
    getDb().prepare(`
      UPDATE listening_sessions
      SET status = 'ended', ended_at = ?, last_active_at = ?
      WHERE id = ? AND user_id = current_user_id()
    `).run(timestamp, timestamp, sessionId)
    return
  }
  getDb().prepare(`
    UPDATE listening_sessions
    SET status = 'ended', ended_at = ?, last_active_at = ?
    WHERE user_id = current_user_id() AND status = 'active'
  `).run(timestamp, timestamp)
}

export const listeningDbTestHelpers = {
  SESSION_IDLE_MINUTES,
}
