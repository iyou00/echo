import type { TasteProfile, Track, TrackSemantic } from '../../../types/ipc'
import { getFeedbackScore, listExplicitTrackFeedback } from '../../db/feedback'
import { listFavoriteTracks } from '../../db/favorites'
import { getTrackSemantic } from '../../db/semantics'
import { inferTrackSemanticFallback } from '../semantics'
import type { RecommendationIntent } from './intent'
import { recommendationMemoryConstraintScore, type RecommendationMemoryConstraints } from './memoryConstraints'
import { hasTrackIdentity, normalizeText, trackKey } from './text'

const EXPLICIT_FEEDBACK_LIMIT = 50
const FAVORITE_DIRECTION_LIMIT = 60

export interface DirectionMemoryItem {
  action: 'more_like_this' | 'not_right' | 'favorite'
  semantic: TrackSemantic
  artist: string
  trackKey: string
  weight: number
}

export function semanticForCandidate(track: Track): TrackSemantic {
  return track.semantic ?? getTrackSemantic(track) ?? inferTrackSemanticFallback(track)
}

function overlapScore(left: string[], right: string[], unit: number): number {
  const target = new Set(right.map((item) => normalizeText(item)).filter(Boolean))
  return left.reduce((score, item) => score + (target.has(normalizeText(item)) ? unit : 0), 0)
}

function semanticSimilarity(left: TrackSemantic, right: TrackSemantic): number {
  let score = 0
  score += overlapScore(left.moods, right.moods, 1.25)
  score += overlapScore(left.scenes, right.scenes, 0.85)
  score += overlapScore(left.genres, right.genres, 0.65)
  if (left.language && right.language && left.language === right.language) score += 0.85
  if (left.tempo === right.tempo) score += 0.8
  const energyGap = Math.abs(left.energy - right.energy)
  if (energyGap <= 0.12) score += 0.9
  else if (energyGap <= 0.28) score += 0.45
  if (left.familiarity === right.familiarity) score += 0.35
  return score
}

function artistOverlap(left: string, right: string): boolean {
  const rightParts = new Set(right.toLowerCase().split(/[/、,，&＋+]| feat\.?| ft\.?| and /i).map((item) => item.trim()).filter(Boolean))
  return left.toLowerCase().split(/[/、,，&＋+]| feat\.?| ft\.?| and /i).map((item) => item.trim()).filter(Boolean).some((item) => rightParts.has(item))
}

export function buildDirectionMemory(): DirectionMemoryItem[] {
  const explicit = listExplicitTrackFeedback(EXPLICIT_FEEDBACK_LIMIT).map((item, index) => ({
    action: item.action,
    semantic: semanticForCandidate(item.track),
    artist: item.track.artist,
    trackKey: trackKey(item.track),
    weight: Math.max(0.35, 1 - index * 0.018),
  }))
  const favorites = listFavoriteTracks().slice(0, FAVORITE_DIRECTION_LIMIT).map((track, index) => ({
    action: 'favorite' as const,
    semantic: semanticForCandidate(track),
    artist: track.artist,
    trackKey: trackKey(track),
    weight: Math.max(0.25, 0.65 - index * 0.006),
  }))
  return [...explicit, ...favorites]
}

export function directionMemoryScore(track: Track, semantic: TrackSemantic, memory: DirectionMemoryItem[]): number {
  let score = 0
  for (const item of memory) {
    const similarity = semanticSimilarity(semantic, item.semantic)
    if (similarity <= 0.8) continue
    const sameArtist = artistOverlap(track.artist, item.artist)
    const sameTrack = trackKey(track) === item.trackKey
    if (item.action === 'more_like_this') {
      score += Math.min(4.4, similarity * 0.75 + (sameArtist ? 0.7 : 0) + (sameTrack ? 1.4 : 0)) * item.weight
    } else if (item.action === 'not_right') {
      score -= Math.min(6.2, similarity * 1.05 + (sameArtist ? 1.2 : 0) + (sameTrack ? 2.8 : 0)) * item.weight
    } else {
      score += Math.min(2.1, similarity * 0.28 + (sameArtist ? 0.25 : 0) + (sameTrack ? 0.7 : 0)) * item.weight
    }
  }
  return Math.max(-10, Math.min(7, Number(score.toFixed(2))))
}

function scoreCandidateWithFeedback(
  track: Track,
  intent: RecommendationIntent,
  recentKeys: Set<string>,
  memory: DirectionMemoryItem[],
  feedbackScore: (track: Track) => number,
  profile?: TasteProfile | null,
  constraints?: RecommendationMemoryConstraints,
): number {
  const semantic = semanticForCandidate(track)
  let score = 0
  for (const mood of intent.moods) if (semantic.moods.includes(mood)) score += 3
  for (const scene of intent.scenes) if (semantic.scenes.includes(scene)) score += 2
  if (intent.language) {
    if (semantic.language === intent.language) score += 4
    else score -= 3
  }
  if (intent.tempo && semantic.tempo === intent.tempo) score += 2
  if (intent.energy === 'low') score += Math.max(0, 2 - semantic.energy * 2)
  if (intent.energy === 'high') {
    score += semantic.energy * 5
    if (semantic.energy < 0.55) score -= 5
  }
  if (intent.familiarity === 'safe' && semantic.familiarity === 'safe') score += 1.5
  if (intent.familiarity === 'explore' && track.recommendSource === 'new_song') score += 1.5
  if (intent.artistQuery && normalizeText(track.artist).includes(normalizeText(intent.artistQuery))) score += 8
  if (intent.seedTitle && normalizeText(track.title).includes(normalizeText(intent.seedTitle))) score += 10
  if (track.recommendSource === 'similar') score += 1.2
  if (track.recommendSource === 'artist') score += 0.9
  if (track.recommendSource === 'playlist') score += 0.7
  if (track.recommendSource === 'daily' || track.recommendSource === 'fm') score += 0.8
  score += Math.max(-5, Math.min(5, feedbackScore(track)))
  score += directionMemoryScore(track, semantic, memory)
  if (constraints) score += recommendationMemoryConstraintScore(track, intent, constraints)
  if (hasTrackIdentity(recentKeys, track) && !(intent.seedTitle && normalizeText(track.title).includes(normalizeText(intent.seedTitle)))) score -= 12
  if (profile?.energy_preference != null && intent.energy == null) {
    const gap = Math.abs(semantic.energy - profile.energy_preference)
    if (gap <= 0.15) score += 1.0
    else if (gap <= 0.3) score += 0.4
    else if (gap > 0.5) score -= 1.5
  }
  if (profile?.tempo_preference && intent.tempo == null) {
    const total = profile.tempo_preference.slow + profile.tempo_preference.medium + profile.tempo_preference.fast
    if (total > 0) score += ((profile.tempo_preference[semantic.tempo] ?? 0) / total) * 2.5
  }
  return score
}

export function scoreCandidate(
  track: Track,
  intent: RecommendationIntent,
  recentKeys: Set<string>,
  memory: DirectionMemoryItem[],
  profile?: TasteProfile | null,
  constraints?: RecommendationMemoryConstraints,
): number {
  return scoreCandidateWithFeedback(track, intent, recentKeys, memory, getFeedbackScore, profile, constraints)
}

export function scoreCandidateForTest(track: Track, intent: RecommendationIntent, recentKeys: Set<string>, memory: DirectionMemoryItem[]): number {
  return scoreCandidateWithFeedback(track, intent, recentKeys, memory, () => 0)
}

export function genericDiscoveryScore(track: Track, recentSevenDayKeys: Set<string>, memory: DirectionMemoryItem[], intent?: RecommendationIntent, constraints?: RecommendationMemoryConstraints): number {
  const semantic = semanticForCandidate(track)
  let score = Math.random() * 3
  if (semantic.familiarity === 'explore') score += 0.6
  if (track.recommendSource === 'style') score += 0.9
  if (track.recommendSource === 'search') score += 0.4
  score += directionMemoryScore(track, semantic, memory)
  if (intent && constraints) score += recommendationMemoryConstraintScore(track, intent, constraints)
  if (hasTrackIdentity(recentSevenDayKeys, track)) score -= 8
  return score
}

export function matchesIntentFloor(track: Track, intent: RecommendationIntent): boolean {
  const semantic = track.semantic ?? semanticForCandidate(track)
  if (typeof intent.rejectIf?.minEnergy === 'number' && semantic.energy < intent.rejectIf.minEnergy) return false
  if (typeof intent.rejectIf?.maxEnergy === 'number' && semantic.energy > intent.rejectIf.maxEnergy) return false
  if (intent.rejectIf?.forbidTempo?.includes(semantic.tempo)) return false
  if (intent.rejectIf?.requireTempo?.length && !intent.rejectIf.requireTempo.includes(semantic.tempo)) return false
  if (intent.energy === 'high' && semantic.energy < 0.5 && semantic.tempo !== 'fast') return false
  if (intent.tempo === 'fast' && semantic.tempo === 'slow' && semantic.energy < 0.6) return false
  if (intent.energy === 'low' && semantic.energy > 0.78) return false
  if (intent.tempo === 'slow' && semantic.tempo === 'fast' && semantic.energy > 0.72) return false
  return true
}
