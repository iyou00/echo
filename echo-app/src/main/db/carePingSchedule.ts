import { getDb } from './index'

export type CarePingScheduleStatus = 'planned' | 'completed' | 'failed' | 'skipped'

export interface CarePingScheduleRecord {
  id: number
  date: string
  windowKey: string
  label: string
  plannedAt: string
  status: CarePingScheduleStatus
  ranAt?: string | null
  message?: string | null
  error?: string | null
}

function toRecord(row: Record<string, unknown>): CarePingScheduleRecord {
  return {
    id: Number(row.id),
    date: String(row.date),
    windowKey: String(row.window_key),
    label: String(row.label),
    plannedAt: String(row.planned_at),
    status: String(row.status) as CarePingScheduleStatus,
    ranAt: typeof row.ran_at === 'string' ? row.ran_at : null,
    message: typeof row.message === 'string' ? row.message : null,
    error: typeof row.error === 'string' ? row.error : null,
  }
}

export function listCarePingSchedule(date: string): CarePingScheduleRecord[] {
  return getDb()
    .prepare('SELECT * FROM care_ping_schedule WHERE date = ? ORDER BY planned_at ASC')
    .all(date)
    .map((row) => toRecord(row as Record<string, unknown>))
}

export function upsertCarePingPlan(date: string, windowKey: string, label: string, plannedAt: string): CarePingScheduleRecord {
  getDb()
    .prepare(`
      INSERT INTO care_ping_schedule (date, window_key, label, planned_at, status)
      VALUES (?, ?, ?, ?, 'planned')
      ON CONFLICT(date, window_key) DO UPDATE SET
        label = excluded.label,
        planned_at = excluded.planned_at
    `)
    .run(date, windowKey, label, plannedAt)
  const row = getDb()
    .prepare('SELECT * FROM care_ping_schedule WHERE date = ? AND window_key = ?')
    .get(date, windowKey) as Record<string, unknown>
  return toRecord(row)
}

export function updateCarePingPlanStatus(
  id: number,
  status: CarePingScheduleStatus,
  message: string,
  error = '',
): void {
  getDb()
    .prepare(`
      UPDATE care_ping_schedule
      SET status = ?, message = ?, error = ?, ran_at = ?
      WHERE id = ?
    `)
    .run(status, message, error, new Date().toLocaleString('sv-SE', { hour12: false }), id)
}

export function restoreCarePingPlan(id: number): void {
  getDb()
    .prepare(`
      UPDATE care_ping_schedule
      SET status = 'planned', message = '', error = '', ran_at = NULL
      WHERE id = ?
    `)
    .run(id)
}
