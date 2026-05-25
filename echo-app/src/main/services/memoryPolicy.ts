import type { Track } from '../../types/ipc'
import { getTrackFeedback } from '../db/feedback'
import { decideMemorySignal, type MemorySignalSource } from '../skills/memory/policy'
import { applySignal, maybeRefreshStructuredProfile } from './taste'

export async function applyMemorySignal(
  kind: string,
  payload: Record<string, unknown>,
  options: {
    source: MemorySignalSource
    track?: Track
    refreshReason?: string
  },
): Promise<boolean> {
  const feedback = options.track ? getTrackFeedback(options.track) : null
  const decision = decideMemorySignal({
    kind,
    payload,
    source: options.source,
    track: options.track,
    feedback,
  })
  if (!decision.apply) return false
  await applySignal(decision.kind, decision.payload)
  maybeRefreshStructuredProfile(options.refreshReason ?? decision.refreshReason)
  return true
}
