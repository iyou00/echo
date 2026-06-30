import { describe, expect, it, vi } from 'vitest'
import type { TasteProfile, Track, TrackSemantic } from '../../../types/ipc'
import { buildRecommendationMemoryConstraints } from './memoryConstraints'
import { buildDirectionMemory, scoreCandidateForTest } from './scoring'
import { parseIntent } from './intent'
import { buildExplicitTrackFeedbackSignals } from '../../skills/memory/feedback'
import { listExplicitTrackFeedback } from '../../db/feedback'

vi.mock('../../db/feedback', () => ({
  getFeedbackScore: vi.fn(() => 0),
  listExplicitTrackFeedback: vi.fn(() => []),
}))

vi.mock('../../db/favorites', () => ({
  listFavoriteTracks: vi.fn(() => []),
}))

const mockTaste = vi.hoisted(() => ({
  profile: null as TasteProfile | null,
}))

vi.mock('../../db/taste', () => ({
  getTasteProfile: vi.fn(() => mockTaste.profile),
}))

const semantic: TrackSemantic = {
  moods: ['温柔'],
  scenes: ['夜晚'],
  genres: ['华语流行'],
  energy: 0.42,
  tempo: 'medium',
  language: '华语',
  familiarity: 'safe',
  confidence: 0.8,
}

function chatSignature(title: string, daysAgo: number): Track {
  return {
    title,
    artist: '王菲',
    source: 'chat',
    recommendedAt: new Date(Date.now() - daysAgo * 24 * 60 * 60 * 1000).toISOString(),
    semantic,
  }
}

describe('recommendation direction memory', () => {
  it('uses the latest explicit feedback per track for direction memory', () => {
    vi.mocked(listExplicitTrackFeedback).mockReturnValueOnce([
      {
        trackKey: 'name:主角::王菲',
        action: 'more_like_this',
        track: { title: '主角', artist: '王菲', semantic },
        createdAt: '2026-06-24T10:00:00.000Z',
      },
      {
        trackKey: 'name:主角::王菲',
        action: 'not_right',
        track: { title: '主角', artist: '王菲', semantic },
        createdAt: '2026-06-23T10:00:00.000Z',
      },
    ])

    const memory = buildDirectionMemory()
    const candidate = { title: '相近的歌', artist: '王菲', semantic }
    const intent = parseIntent('推荐一首适合晚上听的歌')

    expect(memory).toHaveLength(1)
    expect(memory[0]).toMatchObject({
      action: 'more_like_this',
      trackKey: 'name:主角::王菲',
    })
    expect(scoreCandidateForTest(candidate, intent, new Set(), memory)).toBeGreaterThan(
      scoreCandidateForTest(candidate, intent, new Set(), []),
    )
  })

  it('uses recent chat-liked signature tracks as weak positive direction memory', () => {
    mockTaste.profile = {
      artists: [],
      genres: [],
      moods: [],
      signature_tracks: [
        chatSignature('主角', 2),
        chatSignature('很久以前', 45),
        { ...chatSignature('收藏来源', 2), source: 'favorite' },
      ],
      echo_portrait: '',
      energy_preference: 0.5,
      tempo_preference: { slow: 0, medium: 1, fast: 0 },
      discovery_appetite: 0.5,
      anti_patterns: [],
      profile_meta: {},
    } as TasteProfile

    const memory = buildDirectionMemory()

    expect(memory).toHaveLength(1)
    expect(memory[0]).toMatchObject({
      action: 'favorite',
      artist: '王菲',
      trackKey: 'name:主角::王菲',
    })
    expect(memory[0].weight).toBeLessThan(0.25)
    expect(scoreCandidateForTest(chatSignature('类似的歌', 0), parseIntent('推荐一首适合晚上听的歌'), new Set(), memory))
      .toBeGreaterThan(scoreCandidateForTest({
        ...chatSignature('陌生的歌', 0),
        artist: '陌生歌手',
        semantic: { ...semantic, moods: ['热烈'], genres: ['摇滚'], energy: 0.9, tempo: 'fast' },
      }, parseIntent('推荐一首适合晚上听的歌'), new Set(), []))
  })

  it('applies recommendation memory constraints in the same scoring path as production', () => {
    const profile = {
      artists: [],
      genres: [],
      moods: [],
      signature_tracks: [],
      echo_portrait: '',
      energy_preference: 0.5,
      tempo_preference: { slow: 0, medium: 1, fast: 0 },
      discovery_appetite: 0.5,
      anti_patterns: ['少推:安静', '不喜欢:陈默之 沉溺'],
      profile_meta: {},
    } as TasteProfile
    const constraints = buildRecommendationMemoryConstraints(profile, [])
    const intent = parseIntent('推荐一首歌')
    const calmTrack: Track = {
      title: '夜风',
      artist: '某歌手',
      semantic: { ...semantic, moods: ['安静'] },
    }
    const dislikedTrack: Track = {
      title: '沉溺',
      artist: '陈默之',
      semantic,
    }
    const neutralTrack: Track = {
      title: '普通朋友',
      artist: '另一位歌手',
      semantic,
    }

    const neutralScore = scoreCandidateForTest(neutralTrack, intent, new Set(), [], profile, constraints)

    expect(scoreCandidateForTest(calmTrack, intent, new Set(), [], profile, constraints))
      .toBeLessThan(neutralScore)
    expect(scoreCandidateForTest(dislikedTrack, intent, new Set(), [], profile, constraints))
      .toBeLessThan(scoreCandidateForTest(calmTrack, intent, new Set(), [], profile, constraints))
  })

  it('closes the replacement feedback loop from explicit dislike to next recommendation score', () => {
    const rejected: Track = {
      title: '冷夜',
      artist: '陈默之',
      semantic: {
        moods: ['安静'],
        scenes: ['夜晚'],
        genres: ['民谣'],
        energy: 0.35,
        tempo: 'slow',
        language: '华语',
        familiarity: 'safe',
        confidence: 0.8,
      },
    }
    const signals = buildExplicitTrackFeedbackSignals(rejected, 'not_right', '这首歌不好听，换一首激情一点的')
    const antiPatterns = signals
      .filter((signal) => signal.kind === 'unlike_track' || signal.kind === 'soften_vibe' || signal.kind === 'soften_genre')
      .map((signal) => {
        if (signal.kind === 'unlike_track') return `不喜欢:${signal.payload.artist} ${signal.payload.title}`
        return `少推:${signal.payload.target}`
      })
    const profile = {
      artists: [],
      genres: [],
      moods: [],
      signature_tracks: [],
      echo_portrait: '',
      energy_preference: 0.5,
      tempo_preference: { slow: 0, medium: 1, fast: 0 },
      discovery_appetite: 0.5,
      anti_patterns: antiPatterns,
      profile_meta: {
        incrementalSignals: signals
          .filter((signal) => signal.kind === 'reinforce_vibe' || signal.kind === 'like_genre')
          .map((signal) => ({
            kind: signal.kind,
            target: String(signal.payload.target),
            strength: Number(signal.payload.strength ?? 0.08),
            updatedAt: new Date().toISOString(),
          })),
      },
    } as TasteProfile
    const intent = parseIntent('推荐一首激情一点的歌')
    const constraints = buildRecommendationMemoryConstraints(profile, [])
    const highEnergy: Track = {
      title: '热烈一点',
      artist: '新歌手',
      semantic: {
        moods: ['热烈'],
        scenes: ['运动'],
        genres: ['摇滚'],
        energy: 0.88,
        tempo: 'fast',
        language: '华语',
        familiarity: 'explore',
        confidence: 0.8,
      },
    }

    expect(constraints.blockedTerms).toContain('陈默之 冷夜')
    expect(constraints.softenedTerms).toEqual([])
    expect(constraints.preferredTerms).toEqual([])
    expect(scoreCandidateForTest(highEnergy, intent, new Set(), [], profile, constraints))
      .toBeGreaterThan(scoreCandidateForTest(rejected, intent, new Set(), [], profile, constraints))
  })

  it('adds soft negative direction only when explicit dislike names a mismatch reason', () => {
    const rejected: Track = {
      title: '冷夜',
      artist: '陈默之',
      semantic: {
        moods: ['安静'],
        scenes: ['夜晚'],
        genres: ['民谣'],
        energy: 0.35,
        tempo: 'slow',
        language: '华语',
        familiarity: 'safe',
        confidence: 0.8,
      },
    }
    const signals = buildExplicitTrackFeedbackSignals(rejected, 'not_right', '这首太慢了，没劲')
    const antiPatterns = signals
      .filter((signal) => signal.kind === 'unlike_track' || signal.kind === 'soften_vibe' || signal.kind === 'soften_genre')
      .map((signal) => {
        if (signal.kind === 'unlike_track') return `不喜欢:${signal.payload.artist} ${signal.payload.title}`
        return `少推:${signal.payload.target}`
      })
    const profile = {
      artists: [],
      genres: [],
      moods: [],
      signature_tracks: [],
      echo_portrait: '',
      energy_preference: 0.5,
      tempo_preference: { slow: 0, medium: 1, fast: 0 },
      discovery_appetite: 0.5,
      anti_patterns: antiPatterns,
      profile_meta: {},
    } as TasteProfile
    const constraints = buildRecommendationMemoryConstraints(profile, [])

    expect(constraints.blockedTerms).toContain('陈默之 冷夜')
    expect(constraints.softenedTerms).toContain('安静')
    expect(constraints.softenedTerms).not.toContain('民谣')
  })
})
