import { listTodayExplicitTrackFeedback } from '../db/feedback'
import { loadTodayTrackEvents } from '../db/tracks'
import { buildMusicSessionSummary } from '../skills/memory/session'

export function buildTodayMusicSessionSummary(): string {
  const tracks = loadTodayTrackEvents(80)
  const explicit = listTodayExplicitTrackFeedback(40)
  return buildMusicSessionSummary(tracks, explicit)
}
