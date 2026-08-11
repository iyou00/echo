import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Track } from '../../../types/ipc'
import { listFavoriteTracks } from '../../db/favorites'
import { getAllImportedTracks } from '../../db/playlists'
import { loadRecentRecommendedTracks } from '../../db/tracks'
import { musicSearchTestHelpers, searchMusic } from './search'
import { recommendFromNetease } from '../../services/recommendation'

vi.mock('../../services/recommendation', () => ({
  inferIntentWithLlm: vi.fn(async () => null),
  NeteaseAuthRequiredError: class NeteaseAuthRequiredError extends Error {},
  recommendFromNetease: vi.fn(async () => []),
}))

vi.mock('../../db/favorites', () => ({
  listFavoriteTracks: vi.fn(() => []),
}))

vi.mock('../../db/playlists', () => ({
  getAllImportedTracks: vi.fn(() => []),
}))

vi.mock('../../db/tracks', () => ({
  loadRecentRecommendedTracks: vi.fn(() => []),
}))

function track(title: string, artist: string, id: string): Track {
  return {
    id,
    title,
    artist,
    source: 'netease',
  }
}

describe('music search local similarity reference', () => {
  afterEach(() => {
    vi.clearAllMocks()
  })

  it('uses a local favorite as the similarity reference when online verification has no track id', () => {
    const favorite = track('冷夜', '陈奕迅', 'favorite-cold-night')
    vi.mocked(listFavoriteTracks).mockReturnValueOnce([favorite])

    const reference = musicSearchTestHelpers.selectSimilarityReference({
      seedTitle: '冷夜',
      artistQuery: '陈奕迅',
      explicitCount: false,
      entities: [],
      ambiguity: 'missing_artist',
      confidence: 0.84,
      source: 'llm',
      verificationStatus: 'unverified',
    })

    expect(reference).toBe(favorite)
  })

  it('keeps the local fallback constrained by artist when the user names one', () => {
    const wrongArtist = track('冷夜', '王菲', 'wrong-artist')
    const imported = track('冷夜', '陈奕迅', 'imported-cold-night')
    vi.mocked(listFavoriteTracks).mockReturnValueOnce([wrongArtist])
    vi.mocked(getAllImportedTracks).mockReturnValueOnce([imported])

    const reference = musicSearchTestHelpers.selectSimilarityReference({
      seedTitle: '冷夜',
      artistQuery: '陈奕迅',
      explicitCount: false,
      entities: [],
      ambiguity: 'missing_artist',
      confidence: 0.84,
      source: 'llm',
      verificationStatus: 'unverified',
    })

    expect(reference).toBe(imported)
  })

  it('prefers favorites before recent recommendations and imported tracks', () => {
    const favorite = track('主角', '王菲', 'favorite-main-role')
    const recent = track('主角', '王菲', 'recent-main-role')
    const imported = track('主角', '王菲', 'imported-main-role')
    vi.mocked(listFavoriteTracks).mockReturnValueOnce([favorite])
    vi.mocked(loadRecentRecommendedTracks).mockReturnValueOnce([recent])
    vi.mocked(getAllImportedTracks).mockReturnValueOnce([imported])

    const reference = musicSearchTestHelpers.selectSimilarityReference({
      seedTitle: '主角',
      artistQuery: '王菲',
      explicitCount: false,
      entities: [],
      ambiguity: 'missing_artist',
      confidence: 0.84,
      source: 'llm',
      verificationStatus: 'unverified',
    })

    expect(reference).toBe(favorite)
  })

  it('continues similar-track recall with a local reference when online verification cannot provide one', async () => {
    const favorite = track('冷夜', '陈奕迅', 'favorite-cold-night')
    vi.mocked(listFavoriteTracks).mockReturnValueOnce([favorite])
    vi.mocked(recommendFromNetease).mockResolvedValueOnce([
      track('相似候选', '新歌手', 'similar-candidate'),
    ])

    const result = await searchMusic({
      query: '类似陈奕迅的冷夜来一首',
      mode: 'similar-to-track',
      intentOverride: {
        wantsMusic: true,
        artistQuery: '陈奕迅',
        seedTitle: '冷夜',
        intentConfidence: 0.94,
      },
      authoritativeIntentEntities: true,
      signal: new AbortController().signal,
    })

    expect(recommendFromNetease).toHaveBeenCalledOnce()
    expect(recommendFromNetease).toHaveBeenCalledWith(
      '类似陈奕迅的冷夜来一首',
      expect.anything(),
      expect.objectContaining({
        similarityReference: favorite,
      }),
    )
    expect(result).toEqual([track('相似候选', '新歌手', 'similar-candidate')])
  })
})
