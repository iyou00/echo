import { describe, expect, it, vi } from 'vitest'
import type { Track, TrackSemantic } from '../../types/ipc'
import type { RecommendationIntent } from './recommendation'
import {
  OVER_LIMIT_RECOMMENDATION_LINE,
  parseRequestedTrackCount,
  pickPlayableCandidatesForTest,
  recommendationTestHelpers,
} from './recommendation'

vi.mock('electron', () => ({
  app: {
    getPath: () => process.cwd(),
    getAppPath: () => process.cwd(),
  },
}))

const upbeatSemantic: TrackSemantic = {
  language: '英语',
  genres: ['Pop'],
  moods: ['清醒', '热烈'],
  scenes: ['下午工作'],
  energy: 0.86,
  tempo: 'fast',
  familiarity: 'explore',
  confidence: 0.9,
}

const slowSemantic: TrackSemantic = {
  language: '华语',
  genres: ['流行'],
  moods: ['放松'],
  scenes: ['夜晚'],
  energy: 0.22,
  tempo: 'slow',
  familiarity: 'safe',
  confidence: 0.9,
}

function track(id: string, title: string, semantic: TrackSemantic, playUrl?: string): Track {
  return {
    id,
    neteaseId: id,
    title,
    artist: 'Echo Test',
    source: 'netease',
    playUrl,
    semantic,
  }
}

describe('recommendation intent count', () => {
  it('defaults to one track when user does not ask for a count', () => {
    expect(parseRequestedTrackCount('这个时候有什么值得听的吗')).toEqual({
      requestedCount: 1,
      targetCount: 1,
      overLimit: false,
      explicit: false,
    })
  })

  it('uses an explicit five-track request', () => {
    expect(parseRequestedTrackCount('准备听会儿歌休息，来5首欢快的歌曲')).toMatchObject({
      requestedCount: 5,
      targetCount: 5,
      overLimit: false,
      explicit: true,
    })
  })

  it('caps over-limit requests at five tracks', () => {
    expect(parseRequestedTrackCount('给我十首激昂的英文歌')).toMatchObject({
      requestedCount: 10,
      targetCount: 5,
      overLimit: true,
      explicit: true,
    })
    expect(OVER_LIMIT_RECOMMENDATION_LINE).toContain('5 首')
  })
})

describe('recommendation candidate filtering', () => {
  it('drops recently listened tracks before playable filtering', async () => {
    const intent = recommendationTestHelpers.parseIntent('来一首激昂的英文歌')
    const repeated = track('1', 'Repeated', upbeatSemantic, 'mock://1')
    const fresh = track('2', 'Fresh', upbeatSemantic, 'mock://2')

    const picked = await pickPlayableCandidatesForTest(
      [repeated, fresh],
      intent,
      [repeated],
      async (tracks, limit) => tracks.filter((item) => item.playUrl).slice(0, limit),
    )

    expect(picked.map((item) => item.title)).toEqual(['Fresh'])
  })

  it('switches to the next candidate when the first one has no playable link', async () => {
    const intent = recommendationTestHelpers.parseIntent('来一首激昂的英文歌')
    const noUrl = track('1', 'No Url', upbeatSemantic)
    const playable = track('2', 'Playable', upbeatSemantic, 'mock://2')

    const picked = await pickPlayableCandidatesForTest(
      [noUrl, playable],
      intent,
      [],
      async (tracks, limit) => tracks.filter((item) => item.playUrl).slice(0, limit),
    )

    expect(picked).toHaveLength(1)
    expect(picked[0].title).toBe('Playable')
  })

  it('lets explicit negative feedback lower similar candidates', () => {
    const intent = recommendationTestHelpers.parseIntent('来一首激昂的英文歌') as RecommendationIntent
    const target = track('1', 'Too Much', upbeatSemantic)
    const baseScore = recommendationTestHelpers.scoreCandidate(target, intent, new Set(), [])
    const memoryScore = recommendationTestHelpers.scoreCandidate(target, intent, new Set(), [
      {
        action: 'not_right',
        semantic: upbeatSemantic,
        artist: target.artist,
        trackKey: 'netease:1',
        weight: 1,
      },
    ])

    expect(memoryScore).toBeLessThan(baseScore)
  })

  it('rejects slow low-energy tracks for high-energy intent', () => {
    const intent = recommendationTestHelpers.parseIntent('来一首激昂的英文歌')
    expect(recommendationTestHelpers.matchesIntentFloor(track('3', 'Too Slow', slowSemantic), intent)).toBe(false)
  })
})
