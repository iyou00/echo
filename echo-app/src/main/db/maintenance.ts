import { getDb } from './index'
import { getSettings, updateSettingsSilent } from './settings'

const PRUNE_TABLES: Array<{ table: string; dateColumn: string; retentionDays: number; extraWhere?: string }> = [
  { table: 'tracks_listened', dateColumn: 'listened_at', retentionDays: 60 },
  { table: 'conversations', dateColumn: 'created_at', retentionDays: 60 },
  { table: 'track_feedback_events', dateColumn: 'created_at', retentionDays: 90 },
  { table: 'care_pings', dateColumn: 'triggered_at', retentionDays: 30 },
  { table: 'care_ping_schedule', dateColumn: 'created_at', retentionDays: 30 },
  { table: 'scheduled_jobs', dateColumn: 'ran_at', retentionDays: 30 },
  { table: 'events', dateColumn: 'created_at', retentionDays: 90, extraWhere: "AND (expected_end_at IS NOT NULL AND expected_end_at < datetime('now', 'localtime'))" },
  { table: 'scene_sessions', dateColumn: 'created_at', retentionDays: 7, extraWhere: "AND status = 'expired'" },
  { table: 'recommendation_cache', dateColumn: 'expires_at', retentionDays: 0 },
  { table: 'taste_questions', dateColumn: 'created_at', retentionDays: 30, extraWhere: "AND status != 'pending'" },
  { table: 'taste_question_prompts', dateColumn: 'asked_at', retentionDays: 90 },
  { table: 'queue_history_hidden_dates', dateColumn: 'hidden_at', retentionDays: 90 },
]

export function pruneOldData(): void {
  const settings = getSettings()
  const today = new Date().toISOString().slice(0, 10)
  if (settings.meta.lastPrunedAt === today) return

  const db = getDb()
  for (const { table, dateColumn, retentionDays, extraWhere } of PRUNE_TABLES) {
    const cutoff = retentionDays === 0
      ? "datetime('now', 'localtime')"
      : `datetime('now', '-${retentionDays} days', 'localtime')`
    const where = extraWhere ?? ''
    db.prepare(`DELETE FROM ${table} WHERE ${dateColumn} < ${cutoff} ${where}`).run()
  }

  if (new Date().getDate() === 1) {
    db.pragma('incremental_vacuum')
  }

  updateSettingsSilent({ ...settings, meta: { ...settings.meta, lastPrunedAt: today } })
}
