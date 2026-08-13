import type Database from 'better-sqlite3'
import type { StageContext, StageContextEndReason, StageContextEvidenceStrength } from '../../../types/ipc'
import { getDb } from '../../db'

interface StageContextRow {
  id: string
  kind: StageContext['kind']
  status: StageContext['status']
  summary: string
  state_json: string
  goal: StageContext['goal']
  confidence: number
  revision: number
  started_at: string
  last_active_at: string
  expires_at: string
  ended_at: string | null
  end_reason: StageContextEndReason | null
}

function toContext(row: StageContextRow): StageContext {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    summary: row.summary,
    state: JSON.parse(row.state_json) as StageContext['state'],
    goal: row.goal,
    confidence: row.confidence,
    revision: row.revision,
    startedAt: row.started_at,
    lastActiveAt: row.last_active_at,
    expiresAt: row.expires_at,
    endedAt: row.ended_at ?? undefined,
    endReason: row.end_reason ?? undefined,
  }
}

export function loadActiveStageContext(now = new Date(), database: Database.Database = getDb()): StageContext | null {
  const nowIso = now.toISOString()
  database.prepare(`
    UPDATE stage_contexts
    SET status = 'expired', ended_at = ?, end_reason = 'expired', updated_at = ?
    WHERE user_id = current_user_id() AND status = 'active' AND datetime(expires_at) <= datetime(?)
  `).run(nowIso, nowIso, nowIso)
  const row = database.prepare(`
    SELECT id, kind, status, summary, state_json, goal, confidence, revision,
           started_at, last_active_at, expires_at, ended_at, end_reason
    FROM stage_contexts
    WHERE user_id = current_user_id() AND status = 'active'
    LIMIT 1
  `).get() as StageContextRow | undefined
  return row ? toContext(row) : null
}

export function insertStageContext(context: StageContext, database: Database.Database = getDb()): void {
  database.prepare(`
    INSERT INTO stage_contexts (
      id, user_id, kind, status, summary, state_json, goal, confidence, revision,
      started_at, last_active_at, expires_at, ended_at, end_reason
    ) VALUES (?, current_user_id(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(context.id, context.kind, context.status, context.summary, JSON.stringify(context.state), context.goal,
    context.confidence, context.revision, context.startedAt, context.lastActiveAt, context.expiresAt,
    context.endedAt ?? null, context.endReason ?? null)
}

export function updateStageContext(context: StageContext, database: Database.Database = getDb()): void {
  database.prepare(`
    UPDATE stage_contexts
    SET kind = ?, status = ?, summary = ?, state_json = ?, goal = ?, confidence = ?, revision = ?,
        last_active_at = ?, expires_at = ?, ended_at = ?, end_reason = ?, updated_at = CURRENT_TIMESTAMP
    WHERE id = ? AND user_id = current_user_id()
  `).run(context.kind, context.status, context.summary, JSON.stringify(context.state), context.goal,
    context.confidence, context.revision, context.lastActiveAt, context.expiresAt,
    context.endedAt ?? null, context.endReason ?? null, context.id)
}

export function endStageContext(id: string, reason: StageContextEndReason, endedAt: string, database: Database.Database = getDb()): void {
  database.prepare(`
    UPDATE stage_contexts
    SET status = ?, ended_at = ?, end_reason = ?, updated_at = ?
    WHERE id = ? AND user_id = current_user_id() AND status = 'active'
  `).run(reason === 'expired' ? 'expired' : 'ended', endedAt, reason, endedAt, id)
}

export function insertStageContextEvidence(input: {
  contextId: string
  sourceType: 'conversation' | 'event' | 'scene_session' | 'listening_session' | 'user_correction' | 'system'
  sourceId: string
  strength: StageContextEvidenceStrength
  fact: string
}, database: Database.Database = getDb()): void {
  database.prepare(`
    INSERT OR IGNORE INTO stage_context_evidence (context_id, source_type, source_id, strength, fact)
    VALUES (?, ?, ?, ?, ?)
  `).run(input.contextId, input.sourceType, input.sourceId, input.strength, input.fact.slice(0, 120))
}

export function deleteStageContext(id: string, database: Database.Database = getDb()): void {
  database.prepare('DELETE FROM stage_contexts WHERE id = ? AND user_id = current_user_id()').run(id)
}
