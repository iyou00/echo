import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { initializeDatabase } from '../../db'
import { applyStageContextProposal } from '../stageContext/service'
import { deleteStageContext, loadActiveStageContext } from '../stageContext/repository'
import {
  createAgentAction,
  recordAgentActionOutcome,
  transitionAgentAction,
  transitionAgentActionItem,
  recoverInterruptedAgentActions,
} from './repository'

describe('agent phase one persistence', () => {
  let database: Database.Database

  beforeEach(() => {
    database = new Database(':memory:')
    database.pragma('foreign_keys = ON')
    initializeDatabase(database)
  })

  afterEach(() => database.close())

  it('keeps one active context and preserves evidence while updating it', () => {
    const first = applyStageContextProposal({
      proposal: { operation: 'create', kind: 'work', goal: 'focus', confidence: 0.9, summary: '今晚加班', evidenceConversationIds: [10] },
      now: new Date('2026-08-12T10:00:00.000Z'),
    }, database)
    const updated = applyStageContextProposal({
      proposal: { operation: 'update', goal: 'energize', confidence: 0.88, evidenceConversationIds: [11] },
      now: new Date('2026-08-12T11:00:00.000Z'),
    }, database)

    expect(updated).toMatchObject({ id: first?.id, revision: 2, goal: 'energize' })
    expect(database.prepare("SELECT COUNT(*) count FROM stage_contexts WHERE status = 'active'").get()).toEqual({ count: 1 })
    expect(database.prepare('SELECT COUNT(*) count FROM stage_context_evidence').get()).toEqual({ count: 2 })
  })

  it('expires stale state on read instead of leaking it into another surface', () => {
    applyStageContextProposal({
      proposal: { operation: 'create', kind: 'commute', confidence: 0.9, evidenceConversationIds: [10] },
      now: new Date('2026-08-12T08:00:00.000Z'),
    }, database)
    expect(loadActiveStageContext(new Date('2026-08-12T12:00:00.000Z'), database)).toBeNull()
    expect(database.prepare('SELECT status, end_reason FROM stage_contexts').get()).toEqual({ status: 'expired', end_reason: 'expired' })
  })

  it('enforces action transitions and idempotent outcomes', () => {
    const action = createAgentAction({
      origin: 'chat', actionType: 'play', reasonCode: 'user_request', goalCode: 'none',
      items: [{ itemType: 'track', ordinal: 0, entityKey: 'id:42', payload: { title: '主角' } }],
    }, database)
    transitionAgentAction(action.id, 'started', {}, database)
    transitionAgentActionItem(action.items[0].id, 'started', undefined, database)
    transitionAgentActionItem(action.items[0].id, 'succeeded', undefined, database)
    transitionAgentAction(action.id, 'succeeded', {}, database)
    expect(() => transitionAgentAction(action.id, 'failed', {}, database)).toThrow('Invalid agent action transition')

    const outcome = {
      actionId: action.id,
      actionItemId: action.items[0].id,
      sourceEventKey: 'playback_final:instance-1',
      outcomeType: 'completed' as const,
      polarity: 'positive' as const,
      strength: 'medium' as const,
    }
    expect(recordAgentActionOutcome(outcome, database).inserted).toBe(true)
    expect(recordAgentActionOutcome(outcome, database).inserted).toBe(false)
  })

  it('deletes private context evidence but keeps decontextualized action facts', () => {
    const context = applyStageContextProposal({
      proposal: { operation: 'create', kind: 'emotional_support', confidence: 0.95, summary: '今天心情低落', evidenceConversationIds: [7] },
    }, database)!
    const action = createAgentAction({
      origin: 'chat', actionType: 'reply', reasonCode: 'context_companionship', goalCode: 'companionship',
      stageContextId: context.id, stageContextRevision: context.revision,
    }, database)

    deleteStageContext(context.id, database)
    expect(database.prepare('SELECT COUNT(*) count FROM stage_context_evidence').get()).toEqual({ count: 0 })
    expect(database.prepare('SELECT id, stage_context_id FROM agent_actions WHERE id = ?').get(action.id)).toEqual({ id: action.id, stage_context_id: null })
  })

  it('recovers interrupted action and item state together after restart', () => {
    const action = createAgentAction({
      origin: 'listening', actionType: 'speak_then_play', reasonCode: 'recommendation_followup', goalCode: 'companionship',
      plannedAt: '2026-08-12T09:00:00.000Z', items: [{ itemType: 'track', ordinal: 0 }],
    }, database)
    transitionAgentAction(action.id, 'started', { at: '2026-08-12T09:01:00.000Z' }, database)
    transitionAgentActionItem(action.items[0].id, 'started', '2026-08-12T09:01:00.000Z', database)

    expect(recoverInterruptedAgentActions(new Date('2026-08-12T10:00:00.000Z'), database)).toBe(1)
    expect(database.prepare('SELECT status, failure_kind FROM agent_actions WHERE id = ?').get(action.id)).toEqual({ status: 'failed', failure_kind: 'interrupted' })
    expect(database.prepare('SELECT status FROM agent_action_items WHERE id = ?').get(action.items[0].id)).toEqual({ status: 'failed' })
  })
})
