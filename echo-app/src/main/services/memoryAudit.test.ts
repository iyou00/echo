import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Track } from '../../types/ipc'
import type { ExplicitTrackFeedback, TrackFeedback } from '../db/feedback'
import type { ActiveEvent } from '../db/events'

const mocks = vi.hoisted(() => ({
  corrections: [] as ActiveEvent[],
  feedback: [] as TrackFeedback[],
  explicit: [] as ExplicitTrackFeedback[],
}))

vi.mock('./memoryCorrections', () => ({
  loadTrustedCorrections: vi.fn(() => mocks.corrections),
}))

vi.mock('../db/feedback', () => ({
  listTrackFeedback: vi.fn(() => mocks.feedback),
  listExplicitTrackFeedback: vi.fn(() => mocks.explicit),
}))

import { getMemoryAudit } from './memoryAudit'

function track(title: string, artist: string): Track {
  return { title, artist, album: '测试专辑', source: 'netease' }
}

function feedbackRow(patch: Partial<TrackFeedback> & { track: Track; trackKey: string }): TrackFeedback {
  return {
    playCount: 0,
    skipCount: 0,
    loopCount: 0,
    favoriteCount: 0,
    explicitLikeCount: 0,
    explicitMissCount: 0,
    score: 0,
    ...patch,
  }
}

describe('memory audit summary', () => {
  beforeEach(() => {
    mocks.corrections = []
    mocks.feedback = []
    mocks.explicit = []
  })

  it('summarizes long-term memory evidence without dropping corrections or negative feedback', () => {
    const liked = track('主角', '王菲')
    const missed = track('沉溺', '陈默之')
    const stable = track('冷夜', '陈奕迅')

    mocks.corrections = [
      {
        kind: 'correction',
        content: '别把我写成一直很悲伤的人，我最近更想听轻快一点。',
        weight: 0.82,
        createdAt: '2026-06-24T12:00:00.000Z',
      },
    ]
    mocks.explicit = [
      {
        trackKey: 'explicit-like',
        action: 'more_like_this',
        context: '这首可以多来一点',
        track: liked,
        createdAt: '2026-06-24T12:05:00.000Z',
      },
      {
        trackKey: 'explicit-miss',
        action: 'not_right',
        context: '这首不合适',
        track: missed,
        createdAt: '2026-06-24T12:10:00.000Z',
      },
    ]
    mocks.feedback = [
      feedbackRow({
        trackKey: 'stable',
        track: stable,
        favoriteCount: 1,
        loopCount: 2,
        playCount: 3,
        skipCount: 2,
        updatedAt: '2026-06-24T12:03:00.000Z',
      }),
    ]

    const audit = getMemoryAudit(20)

    expect(audit.counts).toEqual({
      corrections: 1,
      favorites: 1,
      explicitLikes: 1,
      explicitMisses: 1,
      loops: 1,
      repeatedSkips: 1,
    })
    expect(audit.items.map((item) => item.kind)).toEqual([
      'explicit_miss',
      'explicit_like',
      'favorite',
      'loop',
      'played',
      'skip',
      'correction',
    ])
    expect(audit.items.find((item) => item.kind === 'correction')).toMatchObject({
      label: '纠正',
      weight: 0.82,
    })
    expect(audit.items.find((item) => item.kind === 'explicit_miss')).toMatchObject({
      label: '不合适',
      detail: '这首不合适',
    })
  })

  it('deduplicates memory audit items by stable ids and respects the limit', () => {
    const stable = track('冷夜', '陈奕迅')
    mocks.feedback = [
      feedbackRow({
        trackKey: 'stable',
        track: stable,
        favoriteCount: 1,
        loopCount: 1,
        playCount: 3,
        skipCount: 2,
        updatedAt: '2026-06-24T12:00:00.000Z',
      }),
    ]

    const audit = getMemoryAudit(2)

    expect(audit.items).toHaveLength(2)
    expect(audit.items.map((item) => item.kind)).toEqual(['favorite', 'loop'])
    expect(new Set(audit.items.map((item) => item.id)).size).toBe(audit.items.length)
  })
})
