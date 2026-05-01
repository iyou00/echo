import type { ExplicitTrackFeedbackAction, Track } from '../../types/ipc'
import { recordExplicitTrackFeedback } from '../db/feedback'
import { applySignal, maybeRefreshStructuredProfile } from './taste'

const messages: Record<ExplicitTrackFeedbackAction, string> = {
  more_like_this: '我记住了，这类可以多来一点。',
  not_right: '收到，这个方向我先收一收。',
}

export async function recordFeedback(track: Track, action: ExplicitTrackFeedbackAction, context?: string): Promise<{ ok: boolean; message: string }> {
  recordExplicitTrackFeedback(action, track, context)
  if (action === 'more_like_this') {
    await applySignal('like_artist', { artist: track.artist, trackId: track.id ?? track.neteaseId, title: track.title, context, strength: 0.08, note: `多来这种:${track.title}` })
    maybeRefreshStructuredProfile('explicit_like')
  } else {
    await applySignal('skipped', { artist: track.artist, trackId: track.id ?? track.neteaseId, title: track.title, context })
    maybeRefreshStructuredProfile('explicit_miss')
  }
  return { ok: true, message: messages[action] }
}
