import type { Track } from '../../types/ipc'
import { getTrackFeedback } from '../db/feedback'
import { decideMemorySignal, type MemorySignalSource } from '../skills/memory/policy'
import { applySignal, maybeRefreshStructuredProfile } from './taste'

export interface ApplyMemorySignalOptions {
  source: MemorySignalSource
  track?: Track
  refreshReason?: string
  deferRefresh?: boolean
}

export async function applyMemorySignal(
  kind: string,
  payload: Record<string, unknown>,
  options: ApplyMemorySignalOptions,
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
  if (!options.deferRefresh && !decision.kind.startsWith('event_')) {
    maybeRefreshStructuredProfile(options.refreshReason ?? decision.refreshReason)
  }
  return true
}

export async function applyMemorySignals(
  signals: Array<{ kind: string; payload: Record<string, unknown>; refreshReason?: string }>,
  options: Omit<ApplyMemorySignalOptions, 'refreshReason' | 'deferRefresh'>,
): Promise<boolean> {
  let applied = false
  let durableApplied = false
  let refreshReason: string | undefined
  for (const signal of signals) {
    const didApply = await applyMemorySignal(signal.kind, signal.payload, {
      ...options,
      refreshReason: signal.refreshReason,
      deferRefresh: true,
    })
    if (!didApply) continue
    applied = true
    if (!signal.kind.startsWith('event_')) {
      durableApplied = true
      refreshReason ??= signal.refreshReason
    }
  }
  if (durableApplied) maybeRefreshStructuredProfile(refreshReason ?? 'memory_signal')
  return applied
}
