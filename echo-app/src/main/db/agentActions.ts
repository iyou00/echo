import { getDb } from './index'
import { parseJson } from './json'
import type { AgentActionSummary } from '../../types/ipc'
import type { ProactiveOutcomeSummary } from '../domain/proactiveBudget/contracts'

export interface AgentActionFact {
  actionId: string
  actionType: string
  origin: string
  reasonCode: string
  goalCode: string
  status: string
  plannedAt: string
  itemType?: string
  itemPayload?: Record<string, unknown>
  outcomeType?: string
  polarity?: string
  strength?: string
  occurredAt?: string
}

export function listAgentActionFactsForDate(date: string, limit = 80): AgentActionFact[] {
  const rows = getDb().prepare(`
    SELECT actions.id action_id, actions.action_type, actions.origin, actions.reason_code, actions.goal_code,
           actions.status, actions.planned_at, items.item_type, items.payload_json,
           outcomes.outcome_type, outcomes.polarity, outcomes.strength, outcomes.occurred_at
    FROM agent_actions actions
    LEFT JOIN agent_action_items items ON items.action_id = actions.id
    LEFT JOIN agent_action_outcomes outcomes ON outcomes.action_id = actions.id
      AND (outcomes.action_item_id = items.id OR outcomes.action_item_id IS NULL)
    WHERE actions.user_id = current_user_id()
      AND actions.status = 'succeeded'
      AND date(actions.planned_at, 'localtime') = date(?)
    ORDER BY actions.planned_at ASC, items.ordinal ASC, outcomes.occurred_at ASC
    LIMIT ?
  `).all(date, Math.max(1, Math.min(300, limit))) as Array<Record<string, unknown>>
  return rows.map((row) => ({
    actionId: String(row.action_id),
    actionType: String(row.action_type),
    origin: String(row.origin),
    reasonCode: String(row.reason_code),
    goalCode: String(row.goal_code),
    status: String(row.status),
    plannedAt: String(row.planned_at),
    itemType: row.item_type ? String(row.item_type) : undefined,
    itemPayload: typeof row.payload_json === 'string' ? parseJson<Record<string, unknown>>(row.payload_json, {}, 'agent_action_items.payload_json') : undefined,
    outcomeType: row.outcome_type ? String(row.outcome_type) : undefined,
    polarity: row.polarity ? String(row.polarity) : undefined,
    strength: row.strength ? String(row.strength) : undefined,
    occurredAt: row.occurred_at ? String(row.occurred_at) : undefined,
  }))
}

export function listQualifiedActionItemIdsForDate(date: string): Set<string> {
  const rows = getDb().prepare(`
    SELECT DISTINCT action_item_id
    FROM agent_action_outcomes
    WHERE user_id = current_user_id()
      AND action_item_id IS NOT NULL
      AND date(occurred_at, 'localtime') = date(?)
      AND outcome_type IN ('quick_skip', 'effective_listen', 'completed', 'favorite', 'explicit_like', 'explicit_miss', 'replay')
  `).all(date) as Array<{ action_item_id: string }>
  return new Set(rows.map((row) => row.action_item_id))
}

export function listQualifiedActionItemIds(limit = 5000): Set<string> {
  const rows = getDb().prepare(`
    SELECT DISTINCT action_item_id
    FROM agent_action_outcomes
    WHERE user_id = current_user_id()
      AND action_item_id IS NOT NULL
      AND outcome_type IN ('quick_skip', 'effective_listen', 'completed', 'favorite', 'explicit_like', 'explicit_miss', 'replay')
    ORDER BY occurred_at DESC
    LIMIT ?
  `).all(Math.max(1, Math.min(20_000, limit))) as Array<{ action_item_id: string }>
  return new Set(rows.map((row) => row.action_item_id))
}

export function listExecutedActionItemIdsForDate(date: string): Set<string> {
  const rows = getDb().prepare(`
    SELECT DISTINCT action_item_id
    FROM agent_action_outcomes
    WHERE user_id = current_user_id()
      AND action_item_id IS NOT NULL
      AND date(occurred_at, 'localtime') = date(?)
      AND outcome_type IN (
        'playback_started', 'quick_skip', 'effective_listen', 'completed', 'favorite',
        'explicit_like', 'explicit_miss', 'replay', 'user_stop', 'app_closed'
      )
  `).all(date) as Array<{ action_item_id: string }>
  return new Set(rows.map((row) => row.action_item_id))
}

export function listRecentAgentActions(limit = 30, origin?: AgentActionSummary['origin']): AgentActionSummary[] {
  const actions = getDb().prepare(`
    SELECT id, origin, action_type, reason_code, goal_code, status, stage_context_id,
           stage_context_revision, decision_json, planned_at, finished_at
    FROM agent_actions
    WHERE user_id = current_user_id()
      AND (? IS NULL OR origin = ?)
    ORDER BY planned_at DESC
    LIMIT ?
  `).all(origin ?? null, origin ?? null, Math.max(1, Math.min(100, limit))) as Array<Record<string, unknown>>
  const outcomes = getDb().prepare(`
    SELECT outcome_type, polarity, strength, occurred_at
    FROM agent_action_outcomes
    WHERE action_id = ? AND user_id = current_user_id()
    ORDER BY occurred_at DESC, id DESC
  `)
  return actions.map((row) => {
    const decision = parseJson<Record<string, unknown>>(typeof row.decision_json === 'string' ? row.decision_json : null, {}, 'agent_actions.decision_json')
    return ({
    id: String(row.id),
    origin: row.origin as AgentActionSummary['origin'],
    actionType: row.action_type as AgentActionSummary['actionType'],
    reasonCode: row.reason_code as AgentActionSummary['reasonCode'],
    goalCode: row.goal_code as AgentActionSummary['goalCode'],
    status: row.status as AgentActionSummary['status'],
    stageContextId: row.stage_context_id ? String(row.stage_context_id) : undefined,
    stageContextRevision: typeof row.stage_context_revision === 'number' ? row.stage_context_revision : undefined,
    plannedAt: String(row.planned_at),
    finishedAt: row.finished_at ? String(row.finished_at) : undefined,
    decisionCode: typeof decision.code === 'string' ? decision.code : undefined,
    eligibleAt: typeof decision.eligibleAt === 'string' ? decision.eligibleAt : undefined,
    outcomes: (outcomes.all(row.id) as Array<Record<string, unknown>>).map((outcome) => ({
      type: outcome.outcome_type as AgentActionSummary['outcomes'][number]['type'],
      polarity: outcome.polarity as AgentActionSummary['outcomes'][number]['polarity'],
      strength: outcome.strength as AgentActionSummary['outcomes'][number]['strength'],
      occurredAt: String(outcome.occurred_at),
    })),
    })
  })
}

export interface ProactiveActionSnapshot {
  sentToday: number
  lastSentAt?: string
  recentOutcomes: ProactiveOutcomeSummary[]
}

export function loadProactiveActionSnapshot(
  date: string,
  outcomeLimit = 10,
  database = getDb(),
): ProactiveActionSnapshot {
  const sent = database.prepare(`
    SELECT COUNT(*) count, MAX(finished_at) last_sent_at
    FROM agent_actions
    WHERE user_id = current_user_id()
      AND origin = 'care'
      AND action_type = 'reply'
      AND status = 'succeeded'
      AND date(finished_at, 'localtime') = date(?)
      AND NOT EXISTS (
        SELECT 1 FROM agent_action_outcomes outcomes
        WHERE outcomes.action_id = agent_actions.id
          AND outcomes.outcome_type = 'system_failure'
      )
  `).get(date) as { count?: number; last_sent_at?: string | null }
  const recentOutcomes = database.prepare(`
    WITH ranked AS (
      SELECT outcomes.action_id, outcomes.outcome_type, outcomes.occurred_at,
             ROW_NUMBER() OVER (
               PARTITION BY outcomes.action_id
               ORDER BY CASE outcomes.outcome_type
                 WHEN 'dismissed' THEN 3
                 WHEN 'ignored' THEN 2
                 ELSE 1
               END DESC, outcomes.occurred_at DESC, outcomes.id DESC
             ) AS outcome_rank
      FROM agent_action_outcomes outcomes
      JOIN agent_actions actions ON actions.id = outcomes.action_id
      WHERE outcomes.user_id = current_user_id()
        AND actions.origin = 'care'
        AND outcomes.outcome_type IN ('opened', 'ignored', 'dismissed')
    )
    SELECT outcome_type, occurred_at
    FROM ranked
    WHERE outcome_rank = 1
    ORDER BY occurred_at DESC
    LIMIT ?
  `).all(Math.max(1, Math.min(50, outcomeLimit))) as Array<{ outcome_type: ProactiveOutcomeSummary['type']; occurred_at: string }>
  return {
    sentToday: Number(sent.count ?? 0),
    lastSentAt: sent.last_sent_at ?? undefined,
    recentOutcomes: recentOutcomes.map((row) => ({ type: row.outcome_type, occurredAt: row.occurred_at })),
  }
}
