import { describe, expect, it } from 'vitest'
import type { TodayTrackEvent } from '../db/tracks'
import { yinyiDismissedTrackEvidence, yinyiPositiveListeningEvidence, yinyiRecommendationEvidence } from './prompt'

describe('yinyi prompt evidence boundaries', () => {
  it('uses only meaningful Echo recommendations as writing evidence', () => {
    const events: TodayTrackEvent[] = [
      {
        title: 'Queued',
        artist: 'Echo',
        source: 'recommended_by_echo',
        listenedAt: '2026-06-17 10:00:00',
        queueStatus: 'pending',
      },
      {
        title: 'Scene Replaced',
        artist: 'Echo',
        source: 'recommended_by_echo',
        listenedAt: '2026-06-17 10:01:00',
        queueStatus: 'skipped',
        queueStatusReason: 'scene_replaced',
      },
      {
        title: 'Rejected',
        artist: 'Echo',
        source: 'recommended_by_echo',
        listenedAt: '2026-06-17 10:01:30',
        queueStatus: 'skipped',
        queueStatusReason: 'explicit_feedback',
      },
      {
        title: 'Played',
        artist: 'Echo',
        source: 'recommended_by_echo',
        listenedAt: '2026-06-17 10:02:00',
        queueStatus: 'completed',
      },
      {
        title: 'Imported',
        artist: 'User',
        source: 'manual',
        listenedAt: '2026-06-17 10:03:00',
      },
    ]

    expect(yinyiRecommendationEvidence(events).map((track) => track.title)).toEqual(['Played'])
  })

  it('splits positive listening and dismissed tracks for yinyi writing context', () => {
    const events: TodayTrackEvent[] = [
      {
        title: 'Pending',
        artist: 'Echo',
        source: 'recommended_by_echo',
        listenedAt: '2026-06-17 10:00:00',
        queueStatus: 'pending',
      },
      {
        title: 'Rejected',
        artist: 'Echo',
        source: 'recommended_by_echo',
        listenedAt: '2026-06-17 10:01:00',
        queueStatus: 'skipped',
        queueStatusReason: 'explicit_feedback',
      },
      {
        title: 'Removed',
        artist: 'Echo',
        source: 'recommended_by_echo',
        listenedAt: '2026-06-17 10:01:30',
        queueStatus: 'skipped',
        queueStatusReason: 'queue_removed',
      },
      {
        title: 'Failed',
        artist: 'Echo',
        source: 'recommended_by_echo',
        listenedAt: '2026-06-17 10:01:40',
        queueStatus: 'skipped',
        queueStatusReason: 'playback_failed',
      },
      {
        title: 'Played',
        artist: 'Echo',
        source: 'recommended_by_echo',
        listenedAt: '2026-06-17 10:02:00',
        queueStatus: 'completed',
      },
      {
        title: 'Manual',
        artist: 'User',
        source: 'manual',
        listenedAt: '2026-06-17 10:03:00',
      },
    ]

    expect(yinyiPositiveListeningEvidence(events).map((track) => track.title)).toEqual(['Played', 'Manual'])
    expect(yinyiDismissedTrackEvidence(events).map((track) => track.title)).toEqual(['Rejected'])
  })
})
