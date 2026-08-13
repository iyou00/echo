import { beforeEach, describe, expect, it, vi } from 'vitest'

vi.mock('../llm/client', () => ({ completeChat: vi.fn() }))
vi.mock('../domain/stageContext/repository', () => ({ loadActiveStageContext: vi.fn(() => null) }))
vi.mock('../domain/agentAction/service', () => ({
  attributeTracksToAgentAction: vi.fn(),
  beginAgentAction: vi.fn(() => ({ id: 'care-silence', items: [] })),
  completeAgentAction: vi.fn(),
  failAgentAction: vi.fn(),
}))
vi.mock('../domain/agentAction/repository', () => ({ recordAgentActionOutcome: vi.fn() }))

import { completeChat } from '../llm/client'
import { carePingTestHelpers, runCarePingSlot } from './carePings'

describe('care ping budget gate', () => {
  beforeEach(() => vi.clearAllMocks())

  it('does not call the model when policy requires silence', async () => {
    const result = await runCarePingSlot({ label: '午后提醒', hour: 14, minute: 10 }, {
      budgetDecision: {
        verdict: 'silence',
        code: 'daily_budget_exhausted',
        budgetBefore: 0,
        budgetCost: 0,
        policyVersion: 1,
      },
    })

    expect(result.status).toBe('skipped')
    expect(completeChat).not.toHaveBeenCalled()
  })

  it('does not call the model when policy defers the plan', async () => {
    const result = await runCarePingSlot({ label: '午后提醒', hour: 14, minute: 10 }, {
      budgetDecision: {
        verdict: 'defer',
        code: 'recent_user_activity',
        eligibleAt: '2026-08-13T06:30:00.000Z',
        budgetBefore: 2,
        budgetCost: 0,
        policyVersion: 1,
      },
    })

    expect(result).toMatchObject({ status: 'deferred', deferredUntil: '2026-08-13T06:30:00.000Z' })
    expect(completeChat).not.toHaveBeenCalled()
  })

  it('blocks delivery when a hard boundary changes during generation', () => {
    expect(() => carePingTestHelpers.recheckCarePingBudget({
      budgetDecision: {
        verdict: 'allow', code: 'eligible', budgetBefore: 2, budgetCost: 1, policyVersion: 1,
      },
    }, () => ({
      verdict: 'silence', code: 'paused', budgetBefore: 2, budgetCost: 0, policyVersion: 1,
    }))).toThrowError(expect.objectContaining({ name: 'CarePingBudgetChangedError' }))
  })
})
