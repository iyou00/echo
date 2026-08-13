import type { Track } from '../../../types/ipc'
import type { AgentActionPlan, AgentActionRecord } from './contracts'
import {
  createAgentAction,
  loadAgentActionItemStatus,
  loadAgentActionStatus,
  transitionAgentAction,
  transitionAgentActionItem,
} from './repository'

export function beginAgentAction(plan: AgentActionPlan): AgentActionRecord {
  return createAgentAction(plan)
}

export function attributeTracksToAgentAction(action: AgentActionRecord, tracks: Track[]): Track[] {
  const trackItems = action.items.filter((item) => item.itemType === 'track')
  return tracks.map((track, index) => {
    const item = trackItems[index]
    if (!item) return track
    return {
      ...track,
      agentActionId: action.id,
      agentActionItemId: item.id,
      stageContextId: action.stageContextId,
    }
  })
}

export function completeAgentAction(action: AgentActionRecord): void {
  if (loadAgentActionStatus(action.id) === 'planned') transitionAgentAction(action.id, 'started')
  for (const item of action.items) {
    if (loadAgentActionItemStatus(item.id) === 'planned') transitionAgentActionItem(item.id, 'started')
    if (loadAgentActionItemStatus(item.id) === 'started') transitionAgentActionItem(item.id, 'succeeded')
  }
  if (loadAgentActionStatus(action.id) === 'started') transitionAgentAction(action.id, 'succeeded')
}

export function failAgentAction(action: AgentActionRecord, failureKind: string): void {
  for (const item of action.items) {
    const status = loadAgentActionItemStatus(item.id)
    if (status === 'planned' || status === 'started') transitionAgentActionItem(item.id, 'failed')
  }
  const status = loadAgentActionStatus(action.id)
  if (status === 'planned' || status === 'started') transitionAgentAction(action.id, 'failed', { failureKind })
}
