import { getDb } from './index'
import { getStoredSettingsRaw, updateSettingsSilent } from './settings'
import { removeLegacyAbsentYinyi } from './yinyi'

const PRUNE_TABLES: Array<{ table: string; dateColumn: string; retentionDays: number; extraWhere?: string }> = [
  { table: 'listening_segments', dateColumn: 'generated_at', retentionDays: 60 },
  { table: 'listening_sessions', dateColumn: 'last_active_at', retentionDays: 60 },
  { table: 'tracks_listened', dateColumn: 'listened_at', retentionDays: 60 },
  { table: 'taste_question_prompts', dateColumn: 'asked_at', retentionDays: 30 },
  { table: 'conversations', dateColumn: 'created_at', retentionDays: 60 },
  { table: 'track_feedback_events', dateColumn: 'created_at', retentionDays: 90 },
  { table: 'companion_signal_events', dateColumn: 'created_at', retentionDays: 365 },
  { table: 'care_pings', dateColumn: 'triggered_at', retentionDays: 30 },
  { table: 'care_ping_schedule', dateColumn: 'created_at', retentionDays: 30 },
  { table: 'scheduled_jobs', dateColumn: 'ran_at', retentionDays: 30 },
  { table: 'events', dateColumn: 'created_at', retentionDays: 90, extraWhere: "AND ((expected_end_at IS NOT NULL AND expected_end_at < datetime('now', 'localtime')) OR (kind = 'context' AND expected_end_at IS NULL))" },
  { table: 'scene_sessions', dateColumn: 'created_at', retentionDays: 7, extraWhere: "AND status = 'expired'" },
  { table: 'recommendation_cache', dateColumn: 'expires_at', retentionDays: 0 },
  { table: 'taste_questions', dateColumn: 'created_at', retentionDays: 30, extraWhere: "AND status != 'pending'" },
  { table: 'queue_history_hidden_dates', dateColumn: 'hidden_at', retentionDays: 90 },
]

export function pruneOldData(): void {
  removeLegacyAbsentYinyi()
  const raw = getStoredSettingsRaw()
  const today = new Date().toISOString().slice(0, 10)
  if (raw.meta.lastPrunedAt === today) return

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

  updateSettingsSilent({ ...raw, meta: { ...raw.meta, lastPrunedAt: today } })
}
