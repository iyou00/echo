import type { ExplicitTrackFeedbackAction, Track } from '../../types/ipc'
import { recordExplicitTrackFeedback, recordTrackFeedback } from '../db/feedback'
import { buildExplicitTrackFeedbackSignals, explicitFeedbackMessages } from '../skills/memory/feedback'
import { applyMemorySignal, applyMemorySignals } from './memoryPolicy'

function assertExplicitTrackFeedbackAction(action: ExplicitTrackFeedbackAction): void {
  if (action !== 'more_like_this' && action !== 'not_right') {
    throw new Error('未知的反馈动作')
  }
}

export async function recordFeedback(track: Track, action: ExplicitTrackFeedbackAction, context?: string): Promise<{ ok: boolean; message: string }> {
  assertExplicitTrackFeedbackAction(action)
  recordExplicitTrackFeedback(action, track, context)
  const signals = buildExplicitTrackFeedbackSignals(track, action, context)
  await applyMemorySignals(signals, { source: 'explicit_feedback', track })
  return { ok: true, message: explicitFeedbackMessages[action] }
}

export async function recordSkippedFeedback(track: Track, context?: string): Promise<{ ok: boolean; message: string }> {
  recordTrackFeedback('skipped', track, 0)
  await applyMemorySignal('skipped', {
    artist: track.artist,
    trackId: track.id ?? track.neteaseId,
    title: track.title,
    completionRate: 0,
    context,
  }, { source: 'chat', track })
  return { ok: true, message: '好，这首先跳过。' }
}
