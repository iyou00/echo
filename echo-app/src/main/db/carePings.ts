import type { PingType, Track } from '../../types/ipc'
import { getDb } from './index'
import { parseJson } from './json'

export interface CarePingPayload {
  type: PingType
  track?: Track
}

export interface CarePingRecord {
  id: number
  type: PingType
  title: string
  body: string
  payload: CarePingPayload
  triggeredAt: string
  clickedAt?: string | null
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
  clicked_at?: string | null
}): CarePingRecord {
  return {
    id: row.id,
    type: row.type,
    title: row.title,
    body: row.body,
    payload: parseJson<CarePingPayload>(row.payload_json, { type: row.type }, 'care_pings.payload_json'),
    triggeredAt: row.triggered_at,
    clickedAt: row.clicked_at,
  }
}

export function insertCarePing(type: PingType, title: string, body: string, payload: CarePingPayload): CarePingRecord {
  const result = getDb()
    .prepare('INSERT INTO care_pings (type, title, body, payload_json, triggered_at) VALUES (?, ?, ?, ?, ?)')
    .run(type, title, body, JSON.stringify(payload), localTimestamp())
  const row = getDb().prepare('SELECT * FROM care_pings WHERE id = ?').get(result.lastInsertRowid) as Parameters<typeof toRecord>[0]
  return toRecord(row)
}

export function markCarePingClicked(id: number): void {
  getDb().prepare('UPDATE care_pings SET clicked_at = ? WHERE id = ?').run(localTimestamp(), id)
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

export function isCarePingsMutedToday(): boolean {
  const row = getDb().prepare('SELECT date FROM care_pings_mute WHERE date = ?').get(todayIso())
  return Boolean(row)
}
