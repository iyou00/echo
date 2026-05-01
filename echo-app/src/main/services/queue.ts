import type { Track } from '../../types/ipc'
import type { QueueHistoryDay } from '../../types/ipc'
import { hideRecommendedTrackHistoryDates, loadRecentTracks, loadRecommendedTrackHistory, updateRecommendedTrackStatus } from '../db/tracks'

function trackKey(track: Track): string {
  return `${track.title.trim().toLowerCase()}::${track.artist.trim().toLowerCase()}`
}

export function getQueue(limit = 30): Track[] {
  const seen = new Set<string>()
  const tracks = loadRecentTracks(limit)
  const queue: Track[] = []

  for (const track of tracks) {
    if (track.queueStatus === 'skipped') continue
    const key = trackKey(track)
    if (seen.has(key)) continue
    seen.add(key)
    queue.push({ ...track, source: track.source ?? 'imported' })
    if (queue.length >= limit) break
  }

  return queue
}

export function getQueueHistory(limitDays = 7): QueueHistoryDay[] {
  return loadRecommendedTrackHistory(limitDays)
}

export function clearQueueHistoryDates(dates: string[]): QueueHistoryDay[] {
  hideRecommendedTrackHistoryDates(dates)
  return getQueueHistory()
}

export function markQueueStatus(track: Track, status: NonNullable<Track['queueStatus']>): Track[] {
  if (status === 'playing') {
    for (const item of getQueue()) {
      if (item.queueStatus === 'playing' && trackKey(item) !== trackKey(track)) {
        updateRecommendedTrackStatus(item, 'skipped')
      }
    }
  }
  updateRecommendedTrackStatus(track, status)
  return getQueue()
}
