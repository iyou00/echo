import type { ExplicitTrackFeedbackAction, Track } from '../../types/ipc'
import { recordExplicitTrackFeedback } from '../db/feedback'
import { buildExplicitTrackFeedbackSignals, explicitFeedbackMessages } from '../skills/memory/feedback'
import { applyMemorySignal } from './memoryPolicy'

export async function recordFeedback(track: Track, action: ExplicitTrackFeedbackAction, context?: string): Promise<{ ok: boolean; message: string }> {
  recordExplicitTrackFeedback(action, track, context)
  const signals = buildExplicitTrackFeedbackSignals(track, action, context)
  let applied = false
  for (const signal of signals) {
    const didApply = await applyMemorySignal(signal.kind, signal.payload, {
      source: 'explicit_feedback',
      track,
      refreshReason: signal.refreshReason,
    })
    applied = applied || didApply
  }
  if (!applied && signals[0]?.refreshReason) {
    await applyMemorySignal(signals[0].kind, signals[0].payload, {
      source: 'explicit_feedback',
      track,
      refreshReason: signals[0].refreshReason,
    })
  }
  return { ok: true, message: explicitFeedbackMessages[action] }
}
