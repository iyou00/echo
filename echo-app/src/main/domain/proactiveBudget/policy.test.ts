import { describe, expect, it } from 'vitest'
import type { StageContext } from '../../../types/ipc'
import type { ProactiveBudgetInput } from './contracts'
import { decideProactiveBudget } from './policy'

const now = new Date(2026, 7, 13, 14, 0, 0)

const stage: StageContext = {
  id: 'stage-1',
  kind: 'work',
  status: 'active',
  summary: '正在工作',
  state: { emotion: 'neutral', energy: 'medium', interactionPreference: 'music', safety: 'normal' },
  goal: 'focus',
  confidence: 0.9,
  revision: 1,
  startedAt: new Date(2026, 7, 13, 9).toISOString(),
  lastActiveAt: new Date(2026, 7, 13, 13).toISOString(),
  expiresAt: new Date(2026, 7, 13, 18).toISOString(),
}

function input(patch: Partial<ProactiveBudgetInput> = {}): ProactiveBudgetInput {
  return {
    now,
    enabled: true,
    frequency: 'normal',
    quietHours: { enabled: true, start: '22:30', end: '08:30' },
    mutedToday: false,
    activeStage: null,
    activeListeningSession: false,
    activeSceneSession: false,
    fullscreenBlocked: false,
    sentToday: 0,
    recentInterventionOutcomes: [],
    evidenceReady: true,
    evaluationWindowEndAt: new Date(2026, 7, 13, 15).toISOString(),
    ...patch,
  }
}

describe('proactive budget policy', () => {
  it.each([
    ['disabled', { enabled: false }],
    ['muted_today', { mutedToday: true }],
    ['fullscreen_blocked', { fullscreenBlocked: true }],
    ['active_session', { activeListeningSession: true }],
    ['safety_caution', { activeStage: { ...stage, state: { ...stage.state, safety: 'caution' as const } } }],
  ])('honors the hard boundary %s before considering budget', (code, patch) => {
    expect(decideProactiveBudget(input(patch))).toMatchObject({ verdict: 'silence', code, budgetCost: 0 })
  })

  it('silences a future explicit pause and exposes its end without spending budget', () => {
    const pausedUntil = new Date(2026, 7, 20, 8).toISOString()
    expect(decideProactiveBudget(input({ pausedUntil }))).toMatchObject({
      verdict: 'silence', code: 'paused', eligibleAt: pausedUntil, budgetBefore: 2, budgetCost: 0,
    })
  })

  it('handles cross-midnight quiet hours and only defers inside the evaluation window', () => {
    const late = new Date(2026, 7, 13, 23, 0)
    const quietEnd = new Date(2026, 7, 14, 8, 30).toISOString()
    expect(decideProactiveBudget(input({ now: late, evaluationWindowEndAt: new Date(2026, 7, 14, 9).toISOString() }))).toMatchObject({
      verdict: 'defer', code: 'quiet_hours', eligibleAt: quietEnd,
    })
    expect(decideProactiveBudget(input({ now: late, evaluationWindowEndAt: new Date(2026, 7, 13, 23, 30).toISOString() }))).toMatchObject({
      verdict: 'silence', code: 'quiet_hours',
    })
  })

  it('defers shortly after user activity instead of interrupting the conversation', () => {
    const lastUserInteractionAt = new Date(2026, 7, 13, 13, 50).toISOString()
    expect(decideProactiveBudget(input({ lastUserInteractionAt }))).toMatchObject({
      verdict: 'defer', code: 'recent_user_activity', eligibleAt: new Date(2026, 7, 13, 14, 10).toISOString(),
    })
  })

  it('keeps quiet stage preference stronger than available daily budget', () => {
    expect(decideProactiveBudget(input({
      activeStage: { ...stage, state: { ...stage.state, interactionPreference: 'quiet' } },
    }))).toMatchObject({ verdict: 'silence', code: 'stage_prefers_quiet' })
  })

  it('enforces daily limits for each visible frequency', () => {
    expect(decideProactiveBudget(input({ frequency: 'gentle', sentToday: 1 }))).toMatchObject({ verdict: 'silence', code: 'daily_budget_exhausted' })
    expect(decideProactiveBudget(input({ frequency: 'normal', sentToday: 2 }))).toMatchObject({ verdict: 'silence', code: 'daily_budget_exhausted' })
    expect(decideProactiveBudget(input({ frequency: 'frequent', sentToday: 2 }))).toMatchObject({ verdict: 'allow', budgetBefore: 1 })
  })

  it('extends cooldown for a focus stage and a latest ignored intervention', () => {
    const lastSentAt = new Date(2026, 7, 13, 8).toISOString()
    expect(decideProactiveBudget(input({
      activeStage: stage,
      lastSentAt,
      recentInterventionOutcomes: [{ type: 'ignored', occurredAt: new Date(2026, 7, 13, 12).toISOString() }],
      evaluationWindowEndAt: new Date(2026, 7, 13, 18).toISOString(),
    }))).toMatchObject({
      verdict: 'defer', code: 'cooldown', eligibleAt: new Date(2026, 7, 13, 17).toISOString(),
    })
  })

  it('converges after repeated ignores without treating system failures as rejection', () => {
    const ignored = [12, 11].map((hour) => ({ type: 'ignored' as const, occurredAt: new Date(2026, 7, 13, hour).toISOString() }))
    expect(decideProactiveBudget(input({ sentToday: 1, recentInterventionOutcomes: ignored }))).toMatchObject({
      verdict: 'silence', code: 'recent_negative_feedback',
    })
    expect(decideProactiveBudget(input({
      recentInterventionOutcomes: [{ type: 'system_failure', occurredAt: new Date(2026, 7, 13, 12).toISOString() }],
    }))).toMatchObject({ verdict: 'allow', code: 'eligible' })
  })

  it('pauses for 72 hours after three consecutive ignores', () => {
    const outcomes = [12, 11, 10].map((hour) => ({ type: 'ignored' as const, occurredAt: new Date(2026, 7, 13, hour).toISOString() }))
    expect(decideProactiveBudget(input({ recentInterventionOutcomes: outcomes }))).toMatchObject({
      verdict: 'silence',
      code: 'recent_negative_feedback',
      eligibleAt: new Date(2026, 7, 16, 12).toISOString(),
    })
  })

  it('does not allow an intervention without a safe evidence basis', () => {
    expect(decideProactiveBudget(input({ evidenceReady: false }))).toMatchObject({
      verdict: 'silence', code: 'insufficient_evidence', budgetCost: 0,
    })
    expect(decideProactiveBudget(input())).toMatchObject({ verdict: 'allow', code: 'eligible', budgetCost: 1 })
  })
})
