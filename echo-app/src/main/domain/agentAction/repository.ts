import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { AgentActionStatus } from '../../../types/ipc'
import { getDb } from '../../db'
import type { AgentActionOutcomeInput, AgentActionPlan, AgentActionRecord } from './contracts'

const VALID_TRANSITIONS: Record<AgentActionStatus, readonly AgentActionStatus[]> = {
  planned: ['started', 'failed', 'canceled'],
  started: ['succeeded', 'failed', 'canceled'],
  succeeded: [],
  failed: [],
  canceled: [],
}

export function createAgentAction(plan: AgentActionPlan, database: Database.Database = getDb()): AgentActionRecord {
  const id = plan.id ?? randomUUID()
  const plannedAt = plan.plannedAt ?? new Date().toISOString()
  const items = (plan.items ?? []).map((item) => ({ ...item, id: item.id ?? randomUUID(), status: 'planned' as const }))
  database.transaction(() => {
    database.prepare(`
      INSERT INTO agent_actions (
        id, user_id, stage_context_id, stage_context_revision, runtime_task_id, origin, action_type,
        reason_code, goal_code, status, recovers_action_id, decision_json, planned_at
      ) VALUES (?, current_user_id(), ?, ?, ?, ?, ?, ?, ?, 'planned', ?, ?, ?)
    `).run(id, plan.stageContextId ?? null, plan.stageContextRevision ?? null, plan.runtimeTaskId ?? null,
      plan.origin, plan.actionType, plan.reasonCode, plan.goalCode, plan.recoversActionId ?? null,
      JSON.stringify(plan.decision ?? {}), plannedAt)
    const insertItem = database.prepare(`
      INSERT INTO agent_action_items (id, action_id, item_type, ordinal, entity_key, payload_json, status)
      VALUES (?, ?, ?, ?, ?, ?, 'planned')
    `)
    for (const item of items) insertItem.run(item.id, id, item.itemType, item.ordinal, item.entityKey ?? null, JSON.stringify(item.payload ?? {}))
  })()
  return { ...plan, id, status: 'planned', plannedAt, items }
}

export function transitionAgentAction(
  id: string,
  nextStatus: AgentActionStatus,
  options: { failureKind?: string; at?: string } = {},
  database: Database.Database = getDb(),
): void {
  const row = database.prepare('SELECT status FROM agent_actions WHERE id = ? AND user_id = current_user_id()').get(id) as { status: AgentActionStatus } | undefined
  if (!row) throw new Error(`Agent action not found: ${id}`)
  if (!VALID_TRANSITIONS[row.status].includes(nextStatus)) throw new Error(`Invalid agent action transition: ${row.status} -> ${nextStatus}`)
  const at = options.at ?? new Date().toISOString()
  database.prepare(`
    UPDATE agent_actions
    SET status = ?, started_at = CASE WHEN ? = 'started' THEN ? ELSE started_at END,
        finished_at = CASE WHEN ? IN ('succeeded', 'failed', 'canceled') THEN ? ELSE finished_at END,
        failure_kind = ?
    WHERE id = ? AND user_id = current_user_id()
  `).run(nextStatus, nextStatus, at, nextStatus, at, options.failureKind ?? null, id)
}

export function loadAgentActionStatus(id: string, database: Database.Database = getDb()): AgentActionStatus | null {
  const row = database.prepare('SELECT status FROM agent_actions WHERE id = ? AND user_id = current_user_id()').get(id) as { status: AgentActionStatus } | undefined
  return row?.status ?? null
}

export function loadAgentActionItemStatus(id: string, database: Database.Database = getDb()): AgentActionStatus | null {
  const row = database.prepare(`
    SELECT items.status
    FROM agent_action_items items
    JOIN agent_actions actions ON actions.id = items.action_id
    WHERE items.id = ? AND actions.user_id = current_user_id()
  `).get(id) as { status: AgentActionStatus } | undefined
  return row?.status ?? null
}

export function transitionAgentActionItem(
  id: string,
  nextStatus: AgentActionStatus,
  at = new Date().toISOString(),
  database: Database.Database = getDb(),
): void {
  const row = database.prepare(`
    SELECT items.status
    FROM agent_action_items items
    JOIN agent_actions actions ON actions.id = items.action_id
    WHERE items.id = ? AND actions.user_id = current_user_id()
  `).get(id) as { status: AgentActionStatus } | undefined
  if (!row) throw new Error(`Agent action item not found: ${id}`)
  if (!VALID_TRANSITIONS[row.status].includes(nextStatus)) throw new Error(`Invalid agent action item transition: ${row.status} -> ${nextStatus}`)
  database.prepare(`
    UPDATE agent_action_items
    SET status = ?, started_at = CASE WHEN ? = 'started' THEN ? ELSE started_at END,
        finished_at = CASE WHEN ? IN ('succeeded', 'failed', 'canceled') THEN ? ELSE finished_at END
    WHERE id = ?
  `).run(nextStatus, nextStatus, at, nextStatus, at, id)
}

export function recordAgentActionOutcome(
  input: AgentActionOutcomeInput,
  database: Database.Database = getDb(),
): { inserted: boolean; id?: number } {
  const result = database.prepare(`
    INSERT OR IGNORE INTO agent_action_outcomes (
      user_id, action_id, action_item_id, source_event_key, outcome_type, polarity, strength, occurred_at, metadata_json
    ) VALUES (current_user_id(), ?, ?, ?, ?, ?, ?, ?, ?)
  `).run(input.actionId, input.actionItemId ?? null, input.sourceEventKey, input.outcomeType,
    input.polarity, input.strength, input.occurredAt ?? new Date().toISOString(), JSON.stringify(input.metadata ?? {}))
  return result.changes === 1 ? { inserted: true, id: Number(result.lastInsertRowid) } : { inserted: false }
}

export function recoverInterruptedAgentActions(now = new Date(), database: Database.Database = getDb()): number {
  const cutoff = new Date(now.getTime() - 10 * 60 * 1000).toISOString()
  return database.transaction(() => {
    database.prepare(`
      UPDATE agent_action_items
      SET status = CASE
            WHEN status = 'planned' THEN 'canceled'
            WHEN EXISTS (
              SELECT 1 FROM agent_action_outcomes outcomes
              WHERE outcomes.action_item_id = agent_action_items.id
                AND outcomes.outcome_type = 'playback_started'
            ) THEN 'succeeded'
            ELSE 'failed'
          END,
          finished_at = ?
      WHERE status IN ('planned', 'started') AND action_id IN (
        SELECT id FROM agent_actions
        WHERE user_id = current_user_id() AND status IN ('planned', 'started') AND datetime(planned_at) < datetime(?)
      )
    `).run(now.toISOString(), cutoff)
    const result = database.prepare(`
      UPDATE agent_actions
      SET status = CASE
            WHEN status = 'planned' THEN 'canceled'
            WHEN EXISTS (
              SELECT 1 FROM agent_action_outcomes outcomes
              WHERE outcomes.action_id = agent_actions.id
                AND outcomes.outcome_type = 'playback_started'
            ) THEN 'succeeded'
            ELSE 'failed'
          END,
          failure_kind = CASE
            WHEN NOT EXISTS (
              SELECT 1 FROM agent_action_outcomes outcomes
              WHERE outcomes.action_id = agent_actions.id
                AND outcomes.outcome_type = 'playback_started'
            ) THEN 'interrupted'
            ELSE NULL
          END,
          finished_at = ?
      WHERE user_id = current_user_id() AND status IN ('planned', 'started') AND datetime(planned_at) < datetime(?)
    `).run(now.toISOString(), cutoff)
    return result.changes
  })()
}

export const agentActionRepositoryTestHelpers = { VALID_TRANSITIONS }
