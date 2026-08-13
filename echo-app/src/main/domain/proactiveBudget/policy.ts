import type { CareFrequency } from '../../../types/ipc'
import type {
  ProactiveBudgetDecision,
  ProactiveBudgetInput,
  ProactiveDecisionCode,
  ProactiveOutcomeSummary,
} from './contracts'

const POLICY_VERSION = 1 as const
const DAY_MS = 24 * 60 * 60 * 1000
const HOUR_MS = 60 * 60 * 1000
const MINUTE_MS = 60 * 1000

const LIMITS: Record<CareFrequency, { daily: number; cooldownMs: number }> = {
  gentle: { daily: 1, cooldownMs: 8 * HOUR_MS },
  normal: { daily: 2, cooldownMs: 5 * HOUR_MS },
  frequent: { daily: 3, cooldownMs: 3 * HOUR_MS },
}

function validTime(value: string | undefined): number | null {
  if (!value) return null
  const time = Date.parse(value)
  return Number.isNaN(time) ? null : time
}

function clockMinutes(value: string): number | null {
  const match = /^(\d{2}):(\d{2})$/.exec(value)
  if (!match) return null
  const hour = Number(match[1])
  const minute = Number(match[2])
  return hour <= 23 && minute <= 59 ? hour * 60 + minute : null
}

function quietHoursEnd(input: ProactiveBudgetInput): Date | null {
  if (!input.quietHours.enabled) return null
  const start = clockMinutes(input.quietHours.start)
  const end = clockMinutes(input.quietHours.end)
  if (start === null || end === null || start === end) return null
  const nowMinutes = input.now.getHours() * 60 + input.now.getMinutes()
  const inside = start < end
    ? nowMinutes >= start && nowMinutes < end
    : nowMinutes >= start || nowMinutes < end
  if (!inside) return null
  const result = new Date(input.now)
  result.setHours(Math.floor(end / 60), end % 60, 0, 0)
  if (start > end && nowMinutes >= start) result.setDate(result.getDate() + 1)
  return result
}

function canDeferUntil(input: ProactiveBudgetInput, eligibleAt: number): boolean {
  const windowEnd = validTime(input.evaluationWindowEndAt)
  return windowEnd !== null && eligibleAt > input.now.getTime() && eligibleAt <= windowEnd
}

function recentOutcomes(outcomes: ProactiveOutcomeSummary[]): ProactiveOutcomeSummary[] {
  return outcomes
    .filter((outcome) => validTime(outcome.occurredAt) !== null)
    .sort((a, b) => Date.parse(b.occurredAt) - Date.parse(a.occurredAt))
}

export function decideProactiveBudget(input: ProactiveBudgetInput): ProactiveBudgetDecision {
  const limits = LIMITS[input.frequency]
  const budgetBefore = Math.max(0, limits.daily - Math.max(0, Math.floor(input.sentToday)))
  const decide = (
    verdict: ProactiveBudgetDecision['verdict'],
    code: ProactiveDecisionCode,
    eligibleAt?: number,
  ): ProactiveBudgetDecision => ({
    verdict,
    code,
    ...(eligibleAt ? { eligibleAt: new Date(eligibleAt).toISOString() } : {}),
    budgetBefore,
    budgetCost: verdict === 'allow' ? 1 : 0,
    policyVersion: POLICY_VERSION,
  })

  if (!input.enabled) return decide('silence', 'disabled')
  const pausedUntil = validTime(input.pausedUntil)
  if (pausedUntil !== null && pausedUntil > input.now.getTime()) return decide('silence', 'paused', pausedUntil)
  if (input.mutedToday) return decide('silence', 'muted_today')
  if (input.activeStage?.state.safety === 'caution') return decide('silence', 'safety_caution')
  if (input.fullscreenBlocked) return decide('silence', 'fullscreen_blocked')
  if (input.activeListeningSession || input.activeSceneSession) return decide('silence', 'active_session')

  const quietEnd = quietHoursEnd(input)
  if (quietEnd) {
    return canDeferUntil(input, quietEnd.getTime())
      ? decide('defer', 'quiet_hours', quietEnd.getTime())
      : decide('silence', 'quiet_hours')
  }

  const lastUserInteractionAt = validTime(input.lastUserInteractionAt)
  if (lastUserInteractionAt !== null) {
    const eligibleAt = lastUserInteractionAt + 20 * MINUTE_MS
    if (eligibleAt > input.now.getTime()) {
      return canDeferUntil(input, eligibleAt)
        ? decide('defer', 'recent_user_activity', eligibleAt)
        : decide('silence', 'recent_user_activity')
    }
  }

  if (input.activeStage?.state.interactionPreference === 'quiet') return decide('silence', 'stage_prefers_quiet')

  const outcomes = recentOutcomes(input.recentInterventionOutcomes)
  const latestThree = outcomes.slice(0, 3)
  const ignoredCount = latestThree.filter((outcome) => outcome.type === 'ignored').length
  const latestDismissed = outcomes.find((outcome) => outcome.type === 'dismissed')
  if (latestDismissed && input.now.getTime() - Date.parse(latestDismissed.occurredAt) < DAY_MS) {
    return decide('silence', 'recent_negative_feedback')
  }
  if (latestThree.length === 3 && ignoredCount === 3) {
    const eligibleAt = Date.parse(latestThree[0].occurredAt) + 72 * HOUR_MS
    if (eligibleAt > input.now.getTime()) return decide('silence', 'recent_negative_feedback', eligibleAt)
  }
  if (ignoredCount >= 2 && input.sentToday >= 1) return decide('silence', 'recent_negative_feedback')

  if (budgetBefore <= 0) return decide('silence', 'daily_budget_exhausted')

  const lastSentAt = validTime(input.lastSentAt)
  if (lastSentAt !== null) {
    const focusPenalty = input.activeStage?.goal === 'focus' ? 2 * HOUR_MS : 0
    const ignoredPenalty = outcomes[0]?.type === 'ignored' ? 2 * HOUR_MS : 0
    const eligibleAt = lastSentAt + limits.cooldownMs + focusPenalty + ignoredPenalty
    if (eligibleAt > input.now.getTime()) {
      return canDeferUntil(input, eligibleAt)
        ? decide('defer', 'cooldown', eligibleAt)
        : decide('silence', 'cooldown')
    }
  }

  if (!input.evidenceReady) return decide('silence', 'insufficient_evidence')
  return decide('allow', 'eligible')
}

export const proactiveBudgetPolicyTestHelpers = { LIMITS, quietHoursEnd }
