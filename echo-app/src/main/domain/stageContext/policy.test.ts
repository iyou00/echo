import { describe, expect, it } from 'vitest'
import type { StageContext, StageContextProposal } from '../../../types/ipc'
import { decideStageContextChange, normalizeStageContextProposal } from './policy'

const now = new Date('2026-08-12T10:00:00.000Z')
const current: StageContext = {
  id: 'context-1',
  kind: 'work',
  status: 'active',
  summary: '今晚在赶方案',
  state: { emotion: 'tired', energy: 'low', interactionPreference: 'music', safety: 'normal' },
  goal: 'focus',
  confidence: 0.9,
  revision: 2,
  startedAt: '2026-08-12T08:00:00.000Z',
  lastActiveAt: '2026-08-12T09:00:00.000Z',
  expiresAt: '2026-08-12T17:00:00.000Z',
}

function proposal(value: Partial<StageContextProposal>): StageContextProposal {
  return { operation: 'update', confidence: 0.8, evidenceConversationIds: [42], ...value }
}

describe('stage context policy', () => {
  it('updates a compatible stage without resetting its identity or start time', () => {
    const decision = decideStageContextChange(current, proposal({ goal: 'energize', statePatch: { energy: 'medium' } }), now)
    expect(decision).toMatchObject({
      type: 'upsert',
      replaceCurrent: false,
      value: { kind: 'work', goal: 'energize', revision: 3, startedAt: current.startedAt },
    })
  })

  it('replaces an incompatible stage instead of mixing two active contexts', () => {
    const decision = decideStageContextChange(current, proposal({ operation: 'create', kind: 'rest', goal: 'recover' }), now)
    expect(decision).toMatchObject({ type: 'upsert', replaceCurrent: true, value: { kind: 'rest', revision: 1 } })
  })

  it('requires enough confidence before changing durable current state', () => {
    expect(decideStageContextChange(current, proposal({ confidence: 0.59 }), now)).toEqual({ type: 'none' })
  })

  it('ends an existing stage when the user says it is over', () => {
    expect(decideStageContextChange(current, proposal({ operation: 'end', confidence: 0.9 }), now)).toMatchObject({
      type: 'end',
      reason: 'user_ended',
    })
  })

  it('keeps only supplied evidence ids and bounds private summaries', () => {
    const normalized = normalizeStageContextProposal(proposal({
      summary: `  ${'很累 '.repeat(40)}  `,
      evidenceConversationIds: [42, 42, 99],
    }), [42])
    expect(normalized.evidenceConversationIds).toEqual([42])
    expect(normalized.summary?.length).toBeLessThanOrEqual(120)
  })
})
