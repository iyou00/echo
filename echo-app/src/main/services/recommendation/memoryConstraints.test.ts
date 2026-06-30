import { describe, expect, it, vi } from 'vitest'
import type { TasteProfile, Track } from '../../../types/ipc'
import {
  allowsArtistFromCorrection,
  allowsTrackFromMemoryConstraints,
  buildRecommendationMemoryConstraints,
  recommendationMemoryConstraintScore,
} from './memoryConstraints'
import { parseIntent } from './intent'

const mockTaste = vi.hoisted(() => ({
  profile: null as TasteProfile | null,
}))

vi.mock('../../db/taste', () => ({
  getTasteProfile: vi.fn(() => mockTaste.profile),
}))

vi.mock('../memoryCorrections', () => ({
  loadTrustedCorrections: vi.fn(() => []),
}))

function profile(patch: Partial<TasteProfile> = {}): TasteProfile {
  return {
    artists: [],
    genres: [],
    moods: [],
    signature_tracks: [],
    echo_portrait: '',
    energy_preference: 0.5,
    tempo_preference: { slow: 0, medium: 1, fast: 0 },
    discovery_appetite: 0.5,
    anti_patterns: [],
    profile_meta: {},
    ...patch,
  } as TasteProfile
}

function track(patch: Partial<Track> = {}): Track {
  return {
    title: '主角',
    artist: '王菲',
    album: '寓言',
    semantic: {
      language: '华语',
      genres: ['流行'],
      moods: ['安静'],
      scenes: ['夜晚'],
      energy: 0.4,
      tempo: 'medium',
      familiarity: 'safe',
      confidence: 0.8,
    },
    ...patch,
  }
}

describe('recommendation memory constraints', () => {
  it('turns explicit disliked tracks into blocked recommendation constraints', () => {
    mockTaste.profile = profile({
      anti_patterns: ['不喜欢:王菲 主角'],
    })

    const constraints = buildRecommendationMemoryConstraints()
    const candidate = track()
    const genericIntent = parseIntent('推荐一首适合晚上听的歌')

    expect(constraints.blockedTerms).toContain('王菲 主角')
    expect(allowsTrackFromMemoryConstraints(candidate, genericIntent, constraints)).toBe(false)
    expect(recommendationMemoryConstraintScore(candidate, genericIntent, constraints)).toBeLessThanOrEqual(-6)
  })

  it('keeps explicit user requests stronger than old avoidance memory', () => {
    mockTaste.profile = profile({
      anti_patterns: ['不喜欢:王菲 主角'],
    })

    const constraints = buildRecommendationMemoryConstraints()
    const candidate = track()
    const explicitIntent = parseIntent('我要听王菲的主角')

    expect(allowsTrackFromMemoryConstraints(candidate, explicitIntent, constraints)).toBe(true)
    expect(recommendationMemoryConstraintScore(candidate, explicitIntent, constraints)).toBe(0)
  })

  it('keeps track-level dislikes even when the artist has a positive memory', () => {
    mockTaste.profile = profile({
      anti_patterns: ['不喜欢:周杰伦 晴天'],
      profile_meta: {
        incrementalSignals: [
          {
            kind: 'like_artist',
            target: '周杰伦',
            strength: 0.08,
            updatedAt: new Date().toISOString(),
          },
        ],
      },
    })

    const constraints = buildRecommendationMemoryConstraints()
    const dislikedTrack = track({ title: '晴天', artist: '周杰伦' })
    const otherTrack = track({ title: '夜曲', artist: '周杰伦' })
    const genericIntent = parseIntent('推荐一首适合现在听的歌')

    expect(constraints.blockedTerms).toContain('周杰伦 晴天')
    expect(allowsTrackFromMemoryConstraints(dislikedTrack, genericIntent, constraints)).toBe(false)
    expect(allowsTrackFromMemoryConstraints(otherTrack, genericIntent, constraints)).toBe(true)
  })

  it('lets artist-level positive memory override artist-level avoidance only', () => {
    mockTaste.profile = profile({
      anti_patterns: ['周杰伦'],
      profile_meta: {
        incrementalSignals: [
          {
            kind: 'like_artist',
            target: '周杰伦',
            strength: 0.08,
            updatedAt: new Date().toISOString(),
          },
        ],
      },
    })

    const constraints = buildRecommendationMemoryConstraints()
    const candidate = track({ title: '夜曲', artist: '周杰伦' })
    const genericIntent = parseIntent('推荐一首适合现在听的歌')

    expect(constraints.blockedTerms).not.toContain('周杰伦')
    expect(allowsTrackFromMemoryConstraints(candidate, genericIntent, constraints)).toBe(true)
  })

  it('blocks explicitly disliked artists across recall and candidate filtering', () => {
    mockTaste.profile = profile({
      anti_patterns: ['不喜欢歌手:周杰伦'],
    })

    const constraints = buildRecommendationMemoryConstraints()
    const candidate = track({ title: '晴天', artist: '周杰伦' })
    const genericIntent = parseIntent('推荐一首适合现在听的歌')
    const explicitIntent = parseIntent('推荐一首周杰伦的歌')

    expect(constraints.blockedArtists).toContain('周杰伦')
    expect(constraints.blockedTerms).not.toContain('周杰伦')
    expect(allowsArtistFromCorrection('周杰伦', genericIntent, constraints)).toBe(false)
    expect(allowsTrackFromMemoryConstraints(candidate, genericIntent, constraints)).toBe(false)
    expect(recommendationMemoryConstraintScore(candidate, genericIntent, constraints)).toBeLessThanOrEqual(-7)
    expect(allowsArtistFromCorrection('周杰伦', explicitIntent, constraints)).toBe(true)
    expect(allowsTrackFromMemoryConstraints(candidate, explicitIntent, constraints)).toBe(true)
    expect(recommendationMemoryConstraintScore(candidate, explicitIntent, constraints)).toBe(0)
  })

  it('treats legacy plain anti-patterns that match known artists as artist blocks', () => {
    mockTaste.profile = profile({
      artists: [{ name: '王菲', affinity: 0.2 }],
      anti_patterns: ['王菲'],
    })

    const constraints = buildRecommendationMemoryConstraints()
    const candidate = track({ title: '容易受伤的女人', artist: '王菲' })
    const genericIntent = parseIntent('推荐一首适合晚上听的歌')

    expect(constraints.blockedArtists).toContain('王菲')
    expect(constraints.blockedTerms).not.toContain('王菲')
    expect(allowsArtistFromCorrection('王菲', genericIntent, constraints)).toBe(false)
    expect(allowsTrackFromMemoryConstraints(candidate, genericIntent, constraints)).toBe(false)
  })

  it('lets a favorite track override an older quoted correction for the same track', () => {
    mockTaste.profile = profile({
      signature_tracks: [{
        title: '沉溺',
        artist: '陈默之',
        source: 'favorite',
        recommendedAt: '2026-06-24T10:00:00.000Z',
      }],
    })

    const constraints = buildRecommendationMemoryConstraints(mockTaste.profile, [
      { kind: 'correction', content: '我不喜欢陈默之《沉溺》，少推一点。', weight: 0.9, createdAt: '2026-06-23T10:00:00.000Z' },
    ])
    const candidate = track({ title: '沉溺', artist: '陈默之' })
    const genericIntent = parseIntent('推荐一首适合现在听的歌')

    expect(constraints.blockedTerms).not.toContain('陈默之沉溺')
    expect(allowsTrackFromMemoryConstraints(candidate, genericIntent, constraints)).toBe(true)
  })

  it('keeps a newer quoted correction stronger than an older favorite track', () => {
    mockTaste.profile = profile({
      signature_tracks: [{
        title: '沉溺',
        artist: '陈默之',
        source: 'favorite',
        recommendedAt: '2026-06-23T10:00:00.000Z',
      }],
    })

    const constraints = buildRecommendationMemoryConstraints(mockTaste.profile, [
      { kind: 'correction', content: '我不喜欢陈默之《沉溺》，少推一点。', weight: 0.9, createdAt: '2026-06-24T10:00:00.000Z' },
    ])
    const candidate = track({ title: '沉溺', artist: '陈默之' })
    const genericIntent = parseIntent('推荐一首适合现在听的歌')

    expect(constraints.blockedTerms).toContain('陈默之沉溺')
    expect(allowsTrackFromMemoryConstraints(candidate, genericIntent, constraints)).toBe(false)
  })

  it('keeps a newer explicit miss stronger than an older favorite track', () => {
    mockTaste.profile = profile({
      anti_patterns: ['不喜欢:王菲 主角'],
      anti_pattern_meta: {
        '不喜欢:王菲 主角': '2026-06-24T10:00:00.000Z',
      },
      signature_tracks: [{
        title: '主角',
        artist: '王菲',
        source: 'favorite',
        recommendedAt: '2026-06-23T10:00:00.000Z',
      }],
    })

    const constraints = buildRecommendationMemoryConstraints()
    const candidate = track()
    const genericIntent = parseIntent('推荐一首适合晚上听的歌')

    expect(constraints.blockedTerms).toContain('王菲 主角')
    expect(allowsTrackFromMemoryConstraints(candidate, genericIntent, constraints)).toBe(false)
  })

  it('lets a newer favorite clear an older explicit miss for the same track', () => {
    mockTaste.profile = profile({
      anti_patterns: ['不喜欢:王菲 主角'],
      anti_pattern_meta: {
        '不喜欢:王菲 主角': '2026-06-23T10:00:00.000Z',
      },
      signature_tracks: [{
        title: '主角',
        artist: '王菲',
        source: 'favorite',
        recommendedAt: '2026-06-24T10:00:00.000Z',
      }],
    })

    const constraints = buildRecommendationMemoryConstraints()
    const candidate = track()
    const genericIntent = parseIntent('推荐一首适合晚上听的歌')

    expect(constraints.blockedTerms).not.toContain('王菲 主角')
    expect(allowsTrackFromMemoryConstraints(candidate, genericIntent, constraints)).toBe(true)
  })

  it('turns soft negative mood or genre memory into scoring penalties without hard blocking', () => {
    mockTaste.profile = profile({
      anti_patterns: ['少推:安静', '少推:流行'],
    })

    const constraints = buildRecommendationMemoryConstraints()
    const candidate = track()
    const genericIntent = parseIntent('推荐一首适合晚上听的歌')

    expect(constraints.softenedTerms).toEqual(['安静', '流行'])
    expect(allowsTrackFromMemoryConstraints(candidate, genericIntent, constraints)).toBe(true)
    expect(recommendationMemoryConstraintScore(candidate, genericIntent, constraints)).toBeLessThanOrEqual(-4.4)
  })

  it('lets newer explicit positive memory override stale profile avoidance terms', () => {
    mockTaste.profile = profile({
      anti_patterns: ['不喜欢:王菲 主角', '少推:安静'],
      signature_tracks: [{
        title: '主角',
        artist: '王菲',
        source: 'chat',
        recommendedAt: new Date().toISOString(),
      }],
      profile_meta: {
        incrementalSignals: [
          {
            kind: 'reinforce_vibe',
            target: '安静',
            strength: 0.08,
            updatedAt: new Date().toISOString(),
          },
        ],
      },
    })

    const constraints = buildRecommendationMemoryConstraints()
    const candidate = track()
    const genericIntent = parseIntent('推荐一首适合晚上听的歌')

    expect(constraints.blockedTerms).not.toContain('王菲 主角')
    expect(constraints.softenedTerms).not.toContain('安静')
    expect(allowsTrackFromMemoryConstraints(candidate, genericIntent, constraints)).toBe(true)
    expect(recommendationMemoryConstraintScore(candidate, genericIntent, constraints)).toBe(0)
  })

  it('does not let stale chat signature tracks override current avoidance terms', () => {
    mockTaste.profile = profile({
      anti_patterns: ['不喜欢:王菲 主角'],
      signature_tracks: [{
        title: '主角',
        artist: '王菲',
        source: 'chat',
        recommendedAt: '1970-01-01T00:00:00.000Z',
      }],
    })

    const constraints = buildRecommendationMemoryConstraints()
    const candidate = track()
    const genericIntent = parseIntent('推荐一首适合晚上听的歌')

    expect(constraints.blockedTerms).toContain('王菲 主角')
    expect(allowsTrackFromMemoryConstraints(candidate, genericIntent, constraints)).toBe(false)
  })

  it('does not let expired chat positive memory override current avoidance terms', () => {
    mockTaste.profile = profile({
      anti_patterns: ['不喜欢:王菲 主角', '少推:安静'],
      profile_meta: {
        incrementalSignals: [
          {
            kind: 'like_track',
            target: '王菲 / 主角',
            artist: '王菲',
            title: '主角',
            strength: 0.08,
            updatedAt: '1970-01-01T00:00:00.000Z',
          },
          {
            kind: 'reinforce_vibe',
            target: '安静',
            strength: 0.08,
            updatedAt: '1970-01-01T00:00:00.000Z',
          },
        ],
      },
    })

    const constraints = buildRecommendationMemoryConstraints()
    const candidate = track()
    const genericIntent = parseIntent('推荐一首适合晚上听的歌')

    expect(constraints.blockedTerms).toContain('王菲 主角')
    expect(constraints.softenedTerms).toContain('安静')
    expect(allowsTrackFromMemoryConstraints(candidate, genericIntent, constraints)).toBe(false)
  })

  it('cleans conversational filler from natural profile corrections before matching tracks', () => {
    mockTaste.profile = profile()
    const constraints = buildRecommendationMemoryConstraints(mockTaste.profile, [
      { kind: 'correction', content: '少推一点周杰伦，我现在听这个会腻。', weight: 0.9 },
      { kind: 'correction', content: '少推这种很吵的电子音墙，我最近不太想听。', weight: 0.9 },
      { kind: 'correction', content: '别推歌手周杰伦，先换别的方向。', weight: 0.9 },
    ])
    const artistCandidate = track({ title: '晴天', artist: '周杰伦' })
    const directionCandidate = track({
      title: '亮得刺耳',
      artist: '电子歌手',
      semantic: {
        language: '华语',
        genres: ['电子'],
        moods: ['电子音墙'],
        scenes: ['夜晚'],
        energy: 0.8,
        tempo: 'fast',
        familiarity: 'explore',
        confidence: 0.8,
      },
    })
    const genericIntent = parseIntent('推荐一首适合现在听的歌')

    expect(constraints.blockedTerms).toContain('周杰伦')
    expect(constraints.blockedTerms).toContain('电子音墙')
    expect(allowsTrackFromMemoryConstraints(artistCandidate, genericIntent, constraints)).toBe(false)
    expect(recommendationMemoryConstraintScore(directionCandidate, genericIntent, constraints)).toBeLessThanOrEqual(-6)
  })

  it('does not turn portrait-style corrections into generic blocked filler terms', () => {
    mockTaste.profile = profile()
    const constraints = buildRecommendationMemoryConstraints(mockTaste.profile, [
      { kind: 'correction', content: '别把我写成一直很悲伤的人，我最近更想听轻快一点。', weight: 0.9 },
    ])
    const brightTrack = track({
      title: '轻一点',
      artist: '新歌手',
      semantic: {
        language: '华语',
        genres: ['流行'],
        moods: ['轻快'],
        scenes: ['下午工作'],
        energy: 0.62,
        tempo: 'medium',
        familiarity: 'explore',
        confidence: 0.8,
      },
    })
    const genericIntent = parseIntent('推荐一首歌')

    expect(constraints.blockedTerms).not.toContain('人')
    expect(constraints.blockedTerms).not.toContain('的人')
    expect(constraints.blockedTerms).not.toContain('我')
    expect(constraints.blockedTerms).not.toContain('一直')
    expect(constraints.blockedTerms).toContain('悲伤')
    expect(constraints.preferredTerms).toContain('轻快')
    expect(recommendationMemoryConstraintScore(brightTrack, genericIntent, constraints)).toBeGreaterThan(0)
    expect(recommendationMemoryConstraintScore(track({
      title: '低处',
      artist: '新歌手',
      semantic: {
        language: '华语',
        genres: ['流行'],
        moods: ['悲伤'],
        scenes: ['夜晚'],
        energy: 0.32,
        tempo: 'slow',
        familiarity: 'safe',
        confidence: 0.8,
      },
    }), genericIntent, constraints)).toBeLessThan(0)
    expect(constraints.notes).toContain('别把我写成一直很悲伤的人，我最近更想听轻快一点。')
  })

  it('softens corrected profile artists while preserving the requested new direction', () => {
    mockTaste.profile = profile({
      artists: [{ name: '王菲', affinity: 0.82 }],
    })
    const constraints = buildRecommendationMemoryConstraints(mockTaste.profile, [
      { kind: 'correction', content: '我最近听王菲比较多，是那几天刚好在听。最近更想听轻快一点。', weight: 0.9 },
    ])
    const oldMisreadTrack = track({
      title: '旧误判',
      artist: '王菲',
      semantic: {
        language: '华语',
        genres: ['流行'],
        moods: ['悲伤'],
        scenes: ['夜晚'],
        energy: 0.36,
        tempo: 'slow',
        familiarity: 'safe',
        confidence: 0.8,
      },
    })
    const correctedDirectionTrack = track({
      title: '轻快一点',
      artist: '新歌手',
      semantic: {
        language: '华语',
        genres: ['流行'],
        moods: ['轻快'],
        scenes: ['上午'],
        energy: 0.66,
        tempo: 'medium',
        familiarity: 'explore',
        confidence: 0.8,
      },
    })
    const genericIntent = parseIntent('推荐一首歌')

    expect(constraints.softenedArtists).toContain('王菲')
    expect(constraints.preferredTerms).toContain('轻快')
    expect(recommendationMemoryConstraintScore(correctedDirectionTrack, genericIntent, constraints))
      .toBeGreaterThan(recommendationMemoryConstraintScore(oldMisreadTrack, genericIntent, constraints))
  })

  it('lets newer preferred correction terms override stale profile avoidance terms', () => {
    mockTaste.profile = profile({
      anti_patterns: ['不喜欢:电子音墙'],
    })
    const constraints = buildRecommendationMemoryConstraints(mockTaste.profile, [
      { kind: 'correction', content: '最近想听电子音墙一点的歌。', weight: 0.9 },
    ])

    expect(constraints.blockedTerms).not.toContain('电子音墙')
    expect(constraints.preferredTerms).toContain('电子音墙')
  })

  it('keeps newer profile avoidance stronger than stale preferred correction terms', () => {
    mockTaste.profile = profile({
      anti_patterns: ['不喜欢:电子音墙'],
      anti_pattern_meta: {
        '不喜欢:电子音墙': '2026-06-24T10:00:00.000Z',
      },
    })
    const constraints = buildRecommendationMemoryConstraints(mockTaste.profile, [
      { kind: 'correction', content: '最近想听电子音墙一点的歌。', weight: 0.9, createdAt: '2026-06-23T10:00:00.000Z' },
    ])

    expect(constraints.blockedTerms).toContain('电子音墙')
    expect(constraints.preferredTerms).not.toContain('电子音墙')
  })
})
