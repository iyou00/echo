import type { AgentActionOutcomeType, CareFrequency, StageContext } from '../../../types/ipc'

export type ProactiveVerdict = 'allow' | 'defer' | 'silence'

export type ProactiveDecisionCode =
  | 'eligible'
  | 'disabled'
  | 'paused'
  | 'muted_today'
  | 'quiet_hours'
  | 'daily_budget_exhausted'
  | 'cooldown'
  | 'recent_negative_feedback'
  | 'recent_user_activity'
  | 'active_session'
  | 'fullscreen_blocked'
  | 'stage_prefers_quiet'
  | 'safety_caution'
  | 'insufficient_evidence'

export interface ProactiveOutcomeSummary {
  type: Extract<AgentActionOutcomeType, 'opened' | 'ignored' | 'dismissed' | 'system_failure'>
  occurredAt: string
}

export interface ProactiveBudgetInput {
  now: Date
  enabled: boolean
  frequency: CareFrequency
  quietHours: { enabled: boolean; start: string; end: string }
  pausedUntil?: string
  mutedToday: boolean
  activeStage: StageContext | null
  lastUserInteractionAt?: string
  activeListeningSession: boolean
  activeSceneSession: boolean
  fullscreenBlocked: boolean
  sentToday: number
  lastSentAt?: string
  recentInterventionOutcomes: ProactiveOutcomeSummary[]
  evidenceReady: boolean
  evaluationWindowEndAt?: string
}

export interface ProactiveBudgetDecision {
  verdict: ProactiveVerdict
  code: ProactiveDecisionCode
  eligibleAt?: string
  budgetBefore: number
  budgetCost: 0 | 1
  policyVersion: 1
}
