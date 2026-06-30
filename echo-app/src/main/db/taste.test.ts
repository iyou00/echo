import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { TasteProfile } from '../../types/ipc'

const mocks = vi.hoisted(() => ({
  run: vi.fn(),
  get: vi.fn(),
  prepare: vi.fn(),
  clearRecommendationCache: vi.fn(),
}))

vi.mock('./index', () => ({
  getDb: vi.fn(() => ({
    prepare: mocks.prepare,
  })),
}))

vi.mock('./recommendationCache', () => ({
  clearRecommendationCache: mocks.clearRecommendationCache,
}))

import { saveTasteProfile } from './taste'

function profile(): TasteProfile {
  return {
    echo_portrait: '我还在观察你。',
    work_summary: '执行摘要',
    artists: [],
    genres: [],
    moods: [],
    signature_tracks: [],
    anti_patterns: [],
    discovery_appetite: 0.5,
    profile_meta: {},
  }
}

describe('taste profile persistence', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.prepare.mockReturnValue({ run: mocks.run, get: mocks.get })
  })

  it('invalidates recommendation cache whenever profile is saved', () => {
    saveTasteProfile(profile(), '执行摘要')

    expect(mocks.run).toHaveBeenCalledOnce()
    expect(mocks.clearRecommendationCache).toHaveBeenCalledOnce()
  })
})
