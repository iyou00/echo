import { describe, expect, it } from 'vitest'
import type { TasteProfile } from '../../../types/ipc'
import { tasteProfileJobsTestHelpers } from './tasteProfileJobs'

function profile(meta: TasteProfile['profile_meta']): TasteProfile {
  return {
    artists: [],
    genres: [],
    moods: [],
    discovery_appetite: 0.5,
    anti_patterns: [],
    signature_tracks: [],
    echo_portrait: '我还在观察你。',
    profile_meta: meta,
  }
}

describe('taste profile scheduler timestamps', () => {
  it('uses portraitUpdatedAt before legacy updatedAt', () => {
    expect(tasteProfileJobsTestHelpers.lastPortraitUpdatedAt(profile({
      updatedAt: '2026-06-10T08:00:00.000Z',
      structuredUpdatedAt: '2026-06-17T08:00:00.000Z',
      portraitUpdatedAt: '2026-06-12T08:00:00.000Z',
    }))).toBe('2026-06-12T08:00:00.000Z')
  })

  it('refreshes structured profile when a correction arrives after the last structured refresh', () => {
    expect(tasteProfileJobsTestHelpers.hasNewTasteSignalsSinceStructuredSnapshot(profile({
      structuredUpdatedAt: '2026-06-23T08:00:00.000Z',
      signalCount: 12,
    }), 12, null, '2026-06-23T09:00:00.000Z')).toBe(true)
  })

  it('refreshes portrait text when a correction arrives after the last portrait refresh', () => {
    expect(tasteProfileJobsTestHelpers.hasNewTasteSignalsSincePortraitSnapshot(profile({
      portraitUpdatedAt: '2026-06-23T08:00:00.000Z',
      portraitSignalCount: 12,
    }), 12, null, '2026-06-23T09:00:00.000Z')).toBe(true)
  })

  it('skips portrait refresh when feedback and correction signals are already covered', () => {
    expect(tasteProfileJobsTestHelpers.hasNewTasteSignalsSincePortraitSnapshot(profile({
      portraitUpdatedAt: '2026-06-23T08:00:00.000Z',
      portraitSignalCount: 12,
      signalUpdatedAt: '2026-06-23T07:00:00.000Z',
      signalRevision: 4,
      portraitSignalRevision: 4,
    }), 12, '2026-06-23T07:30:00.000Z', '2026-06-23T07:45:00.000Z')).toBe(false)
  })

  it('skips portrait refresh on a later day when there are still no new taste signals', () => {
    expect(tasteProfileJobsTestHelpers.hasNewTasteSignalsSincePortraitSnapshot(profile({
      portraitUpdatedAt: '2026-06-22T08:00:00.000Z',
      portraitSignalCount: 12,
      signalUpdatedAt: '2026-06-22T07:00:00.000Z',
      signalRevision: 4,
      portraitSignalRevision: 4,
    }), 12, '2026-06-22T07:30:00.000Z', '2026-06-22T07:45:00.000Z')).toBe(false)
  })

  it('refreshes portrait text when memory signal revision advanced without a feedback count increase', () => {
    expect(tasteProfileJobsTestHelpers.hasNewTasteSignalsSincePortraitSnapshot(profile({
      portraitUpdatedAt: '2026-06-23T08:00:00.000Z',
      portraitSignalCount: 12,
      signalUpdatedAt: '2026-06-23T07:00:00.000Z',
      signalRevision: 5,
      portraitSignalRevision: 4,
    }), 12, '2026-06-23T07:30:00.000Z', '2026-06-23T07:45:00.000Z')).toBe(true)
  })

  it('refreshes structured profile when memory signal revision advanced without a feedback count increase', () => {
    expect(tasteProfileJobsTestHelpers.hasNewTasteSignalsSinceStructuredSnapshot(profile({
      structuredUpdatedAt: '2026-06-23T08:00:00.000Z',
      signalCount: 12,
      signalUpdatedAt: '2026-06-23T07:00:00.000Z',
      signalRevision: 5,
      structuredSignalRevision: 4,
    }), 12, '2026-06-23T07:30:00.000Z', '2026-06-23T07:45:00.000Z')).toBe(true)
  })
})
