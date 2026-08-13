import type {
  AgentActionOrigin,
  AgentActionOutcomePolarity,
  AgentActionOutcomeStrength,
  AgentActionOutcomeType,
  AgentActionReason,
  AgentActionStatus,
  AgentActionType,
  AgentUserAgency,
  StageContextGoal,
} from '../../../types/ipc'

export interface AgentActionItemPlan {
  id?: string
  itemType: 'message' | 'speech' | 'track'
  ordinal: number
  entityKey?: string
  payload?: Record<string, unknown>
}

export interface AgentActionPlan {
  id?: string
  origin: AgentActionOrigin
  actionType: AgentActionType
  reasonCode: AgentActionReason
  goalCode: StageContextGoal
  stageContextId?: string
  stageContextRevision?: number
  runtimeTaskId?: string
  recoversActionId?: string
  decision?: Record<string, unknown>
  items?: AgentActionItemPlan[]
  plannedAt?: string
}

export interface AgentActionRecord extends Omit<AgentActionPlan, 'items'> {
  id: string
  status: AgentActionStatus
  plannedAt: string
  startedAt?: string
  finishedAt?: string
  failureKind?: string
  items: Array<AgentActionItemPlan & { id: string; status: AgentActionStatus }>
}

export interface AgentActionOutcomeInput {
  actionId: string
  actionItemId?: string
  sourceEventKey: string
  outcomeType: AgentActionOutcomeType
  polarity: AgentActionOutcomePolarity
  strength: AgentActionOutcomeStrength
  occurredAt?: string
  metadata?: Record<string, unknown> & { userAgency?: AgentUserAgency }
}
