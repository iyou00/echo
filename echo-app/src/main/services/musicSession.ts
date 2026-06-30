import { listTodayExplicitTrackFeedback } from '../db/feedback'
import { loadTodayMeaningfulTrackEvents } from '../db/tracks'
import { buildMusicSessionSummary } from '../skills/memory/session'

export function buildTodayMusicSessionSummary(): string {
  const tracks = loadTodayMeaningfulTrackEvents(80)
  const explicit = listTodayExplicitTrackFeedback(40)
  return buildMusicSessionSummary(tracks, explicit)
}
