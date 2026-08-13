import type { AgentActionOutcomeInput } from './contracts'

export interface PlaybackOutcomeInput {
  playbackInstanceId: string
  actionId: string
  actionItemId?: string
  positionMs: number
  durationMs: number
  reason: 'ended' | 'next' | 'stop' | 'app_closed' | 'system_failure'
  userAgency?: NonNullable<AgentActionOutcomeInput['metadata']>['userAgency']
  occurredAt?: string
}

export function classifyPlaybackOutcome(input: PlaybackOutcomeInput): AgentActionOutcomeInput {
  const duration = Math.max(0, input.durationMs)
  const position = Math.max(0, input.positionMs)
  const completionRate = duration > 0 ? Math.min(1, position / duration) : 0
  const base = {
    actionId: input.actionId,
    actionItemId: input.actionItemId,
    sourceEventKey: `playback_final:${input.playbackInstanceId}`,
    occurredAt: input.occurredAt,
    metadata: { completionRate, positionMs: position, durationMs: duration, userAgency: input.userAgency ?? 'reactive' },
  }
  if (input.reason === 'system_failure') return { ...base, outcomeType: 'system_failure', polarity: 'system', strength: 'weak' }
  if (input.reason === 'app_closed') return { ...base, outcomeType: 'app_closed', polarity: 'neutral', strength: 'weak' }
  if (input.reason === 'stop') return { ...base, outcomeType: 'user_stop', polarity: 'neutral', strength: 'weak' }
  if (input.reason === 'ended' && duration === 0) {
    return { ...base, outcomeType: 'completed', polarity: 'positive', strength: 'medium', metadata: { ...base.metadata, completionRate: 1 } }
  }
  if (completionRate >= 0.8) return { ...base, outcomeType: 'completed', polarity: 'positive', strength: 'medium' }
  if (position >= 60_000 || completionRate >= 0.3) return { ...base, outcomeType: 'effective_listen', polarity: 'positive', strength: 'weak' }
  if (position < 30_000 && completionRate < 0.3) return { ...base, outcomeType: 'quick_skip', polarity: 'negative', strength: 'weak' }
  return { ...base, outcomeType: 'user_stop', polarity: 'neutral', strength: 'weak' }
}
