import type { SchedulerCatchupResult } from '../../types/ipc'
import { getDb } from './index'

export type ScheduledJobStatus = SchedulerCatchupResult['status']

export interface ScheduledJobRecord {
  id: number
  jobName: string
  scheduledFor: string
  status: ScheduledJobStatus
  message?: string
  error?: string
  ranAt: string
}

function toRecord(row: Record<string, unknown>): ScheduledJobRecord {
  return {
    id: Number(row.id),
    jobName: String(row.job_name),
    scheduledFor: String(row.scheduled_for),
    status: String(row.status) as ScheduledJobStatus,
    message: typeof row.message === 'string' ? row.message : undefined,
    error: typeof row.error === 'string' ? row.error : undefined,
    ranAt: String(row.ran_at),
  }
}

export function insertScheduledJob(
  jobName: string,
  scheduledFor: string,
  status: ScheduledJobStatus,
  message?: string,
  error?: string,
): ScheduledJobRecord {
  const result = getDb()
    .prepare('INSERT INTO scheduled_jobs (job_name, scheduled_for, status, message, error, ran_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(jobName, scheduledFor, status, message ?? '', error ?? '', new Date().toLocaleString('sv-SE', { hour12: false }))
  const row = getDb().prepare('SELECT * FROM scheduled_jobs WHERE id = ?').get(result.lastInsertRowid) as Record<string, unknown>
  return toRecord(row)
}

export function getLatestScheduledJob(jobName: string, scheduledFor: string): ScheduledJobRecord | null {
  const row = getDb()
    .prepare('SELECT * FROM scheduled_jobs WHERE job_name = ? AND scheduled_for = ? ORDER BY ran_at DESC LIMIT 1')
    .get(jobName, scheduledFor) as Record<string, unknown> | undefined
  return row ? toRecord(row) : null
}
