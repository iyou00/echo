import type { PingType, Track } from '../../types/ipc'
import type Database from 'better-sqlite3'
import { getDb } from './index'
import { parseJson } from './json'

export interface CarePingPayload {
  type: PingType
  track?: Track
  agentActionId?: string
  agentActionItemId?: string
}

export interface CarePingRecord {
  id: number
  type: PingType
  title: string
  body: string
  payload: CarePingPayload
  triggeredAt: string
  shownAt?: string | null
  observationDueAt?: string | null
  clickedAt?: string | null
  dismissedAt?: string | null
}

function todayIso(): string {
  const date = new Date()
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function localTimestamp(): string {
  return new Date().toLocaleString('sv-SE', { hour12: false })
}

function toRecord(row: {
  id: number
  type: PingType
  title: string
  body: string
  payload_json?: string | null
  triggered_at: string
  shown_at?: string | null
  observation_due_at?: string | null
  clicked_at?: string | null
  dismissed_at?: string | null
}): CarePingRecord {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    body: row.body,
    payload: parseJson<CarePingPayload>(row.payload_json, { type: row.type }, 'care_pings.payload_json'),
    triggeredAt: row.triggered_at,
    shownAt: row.shown_at,
    observationDueAt: row.observation_due_at,
    clickedAt: row.clicked_at,
    dismissedAt: row.dismissed_at,
  }
}

export function insertCarePing(type: PingType, title: string, body: string, payload: CarePingPayload): CarePingRecord {
  const result = getDb()
    .prepare('INSERT INTO care_pings (type, title, body, payload_json, triggered_at) VALUES (?, ?, ?, ?, ?)')
    .run(type, title, body, JSON.stringify(payload), localTimestamp())
  const row = getDb().prepare('SELECT * FROM care_pings WHERE id = ?').get(result.lastInsertRowid) as Parameters<typeof toRecord>[0]
  return toRecord(row)
}

export function getCarePingById(id: number, database: Database.Database = getDb()): CarePingRecord | null {
  const row = database.prepare('SELECT * FROM care_pings WHERE id = ?').get(id) as Parameters<typeof toRecord>[0] | undefined
  return row ? toRecord(row) : null
}

export function markCarePingShown(
  id: number,
  shownAt = new Date(),
  database: Database.Database = getDb(),
): void {
  const observationDueAt = new Date(shownAt.getTime() + 4 * 60 * 60 * 1000)
  database.prepare(`
    UPDATE care_pings
    SET shown_at = ?, observation_due_at = ?
    WHERE id = ? AND shown_at IS NULL
  `).run(shownAt.toISOString(), observationDueAt.toISOString(), id)
}

export function markCarePingClicked(
  id: number,
  at = new Date(),
  database: Database.Database = getDb(),
): void {
  database.prepare('UPDATE care_pings SET clicked_at = ? WHERE id = ?').run(at.toISOString(), id)
}

export function markCarePingDismissed(
  id: number,
  at = new Date(),
  database: Database.Database = getDb(),
): void {
  database.prepare('UPDATE care_pings SET dismissed_at = ? WHERE id = ?').run(at.toISOString(), id)
}

export function markCarePingDeliveryFailed(id: number, database: Database.Database = getDb()): void {
  database.prepare(`
    UPDATE care_pings
    SET shown_at = NULL, observation_due_at = NULL
    WHERE id = ? AND clicked_at IS NULL AND dismissed_at IS NULL
  `).run(id)
}

export function listDueCarePingObservations(
  now = new Date(),
  database: Database.Database = getDb(),
): CarePingRecord[] {
  const rows = database.prepare(`
    SELECT *
    FROM care_pings
    WHERE shown_at IS NOT NULL
      AND observation_due_at IS NOT NULL
      AND observation_due_at <= ?
      AND clicked_at IS NULL
      AND dismissed_at IS NULL
    ORDER BY observation_due_at ASC, id ASC
  `).all(now.toISOString()) as Array<Parameters<typeof toRecord>[0]>
  return rows.map(toRecord).filter((record) => Boolean(record.payload.agentActionId))
}

export function getLastCarePingAt(): string | null {
  const row = getDb()
    .prepare('SELECT triggered_at FROM care_pings ORDER BY triggered_at DESC LIMIT 1')
    .get() as { triggered_at: string } | undefined
  return row?.triggered_at ?? null
}

export function getRecentCarePingBodies(limit = 7): string[] {
  return getDb()
    .prepare('SELECT body FROM care_pings ORDER BY triggered_at DESC LIMIT ?')
    .all(limit)
    .map((row) => (row as { body: string }).body)
}

export function getRecentCarePingTracks(limit = 20): Track[] {
  return getDb()
    .prepare("SELECT payload_json FROM care_pings WHERE type = 'recommend_track' ORDER BY triggered_at DESC LIMIT ?")
    .all(limit)
    .map((row) => {
      const payload = parseJson<CarePingPayload | null>((row as { payload_json?: string | null }).payload_json, null, 'care_pings.payload_json')
      return payload?.track ?? null
    })
    .filter((track): track is Track => Boolean(track))
}

export function muteCarePingsToday(): void {
  getDb().prepare('INSERT OR IGNORE INTO care_pings_mute (date) VALUES (?)').run(todayIso())
}

export function unmuteCarePingsToday(): void {
  getDb().prepare('DELETE FROM care_pings_mute WHERE date = ?').run(todayIso())
}

export function isCarePingsMutedToday(): boolean {
  const row = getDb().prepare('SELECT date FROM care_pings_mute WHERE date = ?').get(todayIso())
  return Boolean(row)
}
