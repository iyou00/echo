import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Track } from '../../types/ipc'

const mocked = vi.hoisted(() => {
  interface FeedbackRow {
    track_key: string
    play_count: number
    skip_count: number
    loop_count: number
    favorite_count: number
    last_completion?: number | null
    track_json: string
    updated_at?: string
  }
  interface FeedbackEvent {
    track_key: string
    action: string
    track_json: string
  }
  const rows = new Map<string, FeedbackRow>()
  const events: FeedbackEvent[] = []

  function explicitCounts(trackKey: string) {
    return {
      explicit_like_count: events.filter((event) => event.track_key === trackKey && event.action === 'more_like_this').length,
      explicit_miss_count: events.filter((event) => event.track_key === trackKey && event.action === 'not_right').length,
    }
  }

  return {
    rows,
    events,
    reset() {
      rows.clear()
      events.splice(0)
    },
    db: {
      transaction(fn: () => void) {
        return () => fn()
      },
      prepare(sql: string) {
        return {
          run(...args: unknown[]) {
            if (sql.includes('INSERT INTO track_feedback_events')) {
              const [trackKey, action, , , , , , trackJson] = args
              events.push({ track_key: String(trackKey), action: String(action), track_json: String(trackJson) })
              return
            }
            if (sql.includes('INSERT INTO track_feedback')) {
              const [trackKey, , , , , trackJson] = args
              const key = String(trackKey)
              rows.set(key, rows.get(key) ?? {
                track_key: key,
                play_count: 0,
                skip_count: 0,
                loop_count: 0,
                favorite_count: 0,
                last_completion: null,
                track_json: String(trackJson),
                updated_at: 'now',
              })
              rows.get(key)!.track_json = String(trackJson)
              return
            }
            if (sql.includes('UPDATE track_feedback')) {
              const [completion, trackKey] = args
              const row = rows.get(String(trackKey))
              if (!row) return
              if (sql.includes('play_count = play_count + 1')) row.play_count += 1
              if (sql.includes('skip_count = skip_count + 1')) row.skip_count += 1
              if (sql.includes('loop_count = loop_count + 1')) row.loop_count += 1
              if (sql.includes('favorite_count = 1')) row.favorite_count = 1
              if (sql.includes('favorite_count = 0')) row.favorite_count = 0
              if (typeof completion === 'number') row.last_completion = completion
            }
          },
          get(trackKey?: unknown) {
            if (sql.includes('SUM(CASE WHEN action =')) {
              const key = String(trackKey)
              const counts = explicitCounts(key)
              return { likes: counts.explicit_like_count, misses: counts.explicit_miss_count }
            }
            if (sql.includes('AS total')) {
              const aggregate = Array.from(rows.values()).reduce((sum, row) => sum + row.play_count + row.skip_count + row.loop_count + row.favorite_count, 0)
              return { total: aggregate + events.length }
            }
            const row = rows.get(String(trackKey))
            return row ? { ...row, ...explicitCounts(row.track_key) } : undefined
          },
          all() {
            return Array.from(rows.values()).map((row) => ({ ...row, ...explicitCounts(row.track_key) }))
          },
        }
      },
    },
  }
})

vi.mock('./index', () => ({
  getDb: () => mocked.db,
}))

vi.mock('./recommendationCache', () => ({
  clearRecommendationCache: vi.fn(),
}))

import { getFeedbackScore, getFeedbackSignalCount, getTrackFeedback, listProfileTrackFeedback, recordExplicitTrackFeedback, recordTrackFeedback } from './feedback'

const track: Track = {
  id: 'track-1',
  title: '沉溺',
  artist: '陈默之',
  source: 'netease',
}

beforeEach(() => {
  mocked.reset()
})

describe('track feedback evidence boundaries', () => {
  it('keeps explicit feedback separate from playback counters while preserving signal strength', () => {
    recordExplicitTrackFeedback('more_like_this', track, '这类多来一点')
    recordExplicitTrackFeedback('not_right', track, '这首不太合适')

    const feedback = getTrackFeedback(track)
    expect(feedback).toMatchObject({
      playCount: 0,
      skipCount: 0,
      explicitLikeCount: 1,
      explicitMissCount: 1,
    })
    expect(getFeedbackScore(track)).toBe(-1)
    expect(getFeedbackSignalCount()).toBe(2)

    recordTrackFeedback('played', track, 1)
    expect(getTrackFeedback(track)).toMatchObject({
      playCount: 1,
      skipCount: 0,
      explicitLikeCount: 1,
      explicitMissCount: 1,
    })
  })

  it('deduplicates recent and stable feedback rows for profile building', () => {
    recordExplicitTrackFeedback('more_like_this', track, '这类多来一点')
    recordTrackFeedback('played', track, 1)

    const rows = listProfileTrackFeedback()

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      trackKey: 'id:track-1',
      explicitLikeCount: 1,
      playCount: 1,
    })
  })
})
