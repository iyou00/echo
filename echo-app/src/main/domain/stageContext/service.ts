import { randomUUID } from 'node:crypto'
import type Database from 'better-sqlite3'
import type { StageContext, StageContextCorrection, StageContextEvidenceStrength, StageContextProposal } from '../../../types/ipc'
import { getDb } from '../../db'
import { decideStageContextChange } from './policy'
import {
  endStageContext,
  insertStageContext,
  insertStageContextEvidence,
  loadActiveStageContext,
  updateStageContext,
  deleteStageContext,
} from './repository'

export function applyStageContextProposal(input: {
  proposal: StageContextProposal
  sourceType?: 'conversation' | 'event' | 'scene_session' | 'listening_session' | 'user_correction' | 'system'
  evidenceStrength?: StageContextEvidenceStrength
  allowedEvidenceConversationIds?: number[]
  evidenceSourceIds?: string[]
  now?: Date
}, database: Database.Database = getDb()): StageContext | null {
  const now = input.now ?? new Date()
  return database.transaction(() => {
    const current = loadActiveStageContext(now, database)
    const proposal = {
      ...input.proposal,
      evidenceConversationIds: input.proposal.evidenceConversationIds.filter((id) => (
        input.allowedEvidenceConversationIds === undefined || input.allowedEvidenceConversationIds.includes(id)
      )),
    }
    const decision = decideStageContextChange(current, proposal, now)
    if (decision.type === 'none') return current
    if (decision.type === 'end') {
      endStageContext(decision.current.id, decision.reason, decision.endedAt, database)
      return null
    }
    if (decision.replaceCurrent && current) {
      endStageContext(current.id, 'replaced', now.toISOString(), database)
    }
    const context: StageContext = {
      ...decision.value,
      id: current && !decision.replaceCurrent ? current.id : randomUUID(),
    }
    if (current && !decision.replaceCurrent) updateStageContext(context, database)
    else insertStageContext(context, database)
    const evidenceSourceIds = input.evidenceSourceIds ?? proposal.evidenceConversationIds.map(String)
    for (const sourceId of evidenceSourceIds) {
      insertStageContextEvidence({
        contextId: context.id,
        sourceType: input.sourceType ?? 'conversation',
        sourceId,
        strength: input.evidenceStrength ?? 'proposed',
        fact: context.summary,
      }, database)
    }
    return context
  })()
}

export function endActiveStageContext(now = new Date(), database: Database.Database = getDb()): StageContext | null {
  const current = loadActiveStageContext(now, database)
  if (!current) return null
  endStageContext(current.id, 'user_ended', now.toISOString(), database)
  return { ...current, status: 'ended', endedAt: now.toISOString(), endReason: 'user_ended' }
}

export function correctActiveStageContext(input: StageContextCorrection, database: Database.Database = getDb()): StageContext | null {
  const current = loadActiveStageContext(new Date(), database)
  if (!current) return null
  return applyStageContextProposal({
    proposal: {
      operation: 'update',
      kind: input.kind ?? current.kind,
      summary: input.summary,
      statePatch: input.statePatch,
      goal: input.goal,
      confidence: 1,
      ttlClass: 'day',
      evidenceConversationIds: [],
    },
    sourceType: 'user_correction',
    evidenceSourceIds: [`manual:${Date.now()}`],
    evidenceStrength: 'explicit',
  }, database)
}

export function removeStageContext(id: string, database: Database.Database = getDb()): void {
  deleteStageContext(id, database)
}
