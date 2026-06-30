import type { TasteProfile, Track, TrackSemantic } from '../../../types/ipc'
import { getFeedbackScore, listExplicitTrackFeedback } from '../../db/feedback'
import { listFavoriteTracks } from '../../db/favorites'
import { getTasteProfile } from '../../db/taste'
import { getTrackSemantic } from '../../db/semantics'
import { inferTrackSemanticFallback } from '../semantics'
import type { RecommendationIntent } from './intent'
import { recommendationMemoryConstraintScore, type RecommendationMemoryConstraints } from './memoryConstraints'
import { hasTrackIdentity, normalizeText, trackKey } from './text'
import { stableUnit, type RecommendationDeterminismContext } from './deterministic'

const EXPLICIT_FEEDBACK_LIMIT = 50
const FAVORITE_DIRECTION_LIMIT = 60
const CHAT_SIGNATURE_DIRECTION_LIMIT = 20
const CHAT_SIGNATURE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
const GENERIC_DISCOVERY_JITTER_MAX = 3
const EXPLORE_FAMILIARITY_BONUS = 0.6
const STYLE_SOURCE_BONUS = 0.9
const SEARCH_SOURCE_BONUS = 0.4
const RECENT_DISCOVERY_PENALTY = 8

export interface DirectionMemoryItem {
  action: 'more_like_this' | 'not_right' | 'favorite'
  semantic: TrackSemantic
  artist: string
  trackKey: string
  weight: number
}

function latestExplicitFeedbackByTrack(limit: number): ReturnType<typeof listExplicitTrackFeedback> {
  const seen = new Set<string>()
  const latest: ReturnType<typeof listExplicitTrackFeedback> = []
  for (const item of listExplicitTrackFeedback(limit)) {
    const key = item.trackKey || trackKey(item.track)
    if (!key || seen.has(key)) continue
    seen.add(key)
    latest.push(item)
  }
  return latest
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

export function buildDirectionMemory(profile: TasteProfile | null = getTasteProfile()): DirectionMemoryItem[] {
  const explicit = latestExplicitFeedbackByTrack(EXPLICIT_FEEDBACK_LIMIT).map((item, index) => ({
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
  const now = Date.now()
  const chatSignatures = (profile?.signature_tracks ?? [])
    .filter((track) => track.source === 'chat')
    .filter((track) => {
      const recordedAt = track.recommendedAt ? new Date(track.recommendedAt).getTime() : Number.NaN
      return Number.isFinite(recordedAt) && now - recordedAt <= CHAT_SIGNATURE_MAX_AGE_MS
    })
    .slice(0, CHAT_SIGNATURE_DIRECTION_LIMIT)
    .map((track, index) => ({
      action: 'favorite' as const,
      semantic: semanticForCandidate(track),
      artist: track.artist,
      trackKey: trackKey(track),
      weight: Math.max(0.12, 0.24 - index * 0.006),
    }))
  return [...explicit, ...favorites, ...chatSignatures]
}

function intentExplicitlyRequestsExactTrack(track: Track, intent?: RecommendationIntent): boolean {
  const seedTitle = normalizeText(intent?.seedTitle ?? '')
  if (!seedTitle) return false
  const title = normalizeText(track.title)
  if (!title || !(title.includes(seedTitle) || seedTitle.includes(title))) return false
  const artistQuery = normalizeText(intent?.artistQuery ?? '')
  if (!artistQuery) return true
  const artist = normalizeText(track.artist)
  return Boolean(artist && (artist.includes(artistQuery) || artistQuery.includes(artist)))
}

export function directionMemoryScore(track: Track, semantic: TrackSemantic, memory: DirectionMemoryItem[], options: { ignoreNegative?: boolean } = {}): number {
  let score = 0
  for (const item of memory) {
    const similarity = semanticSimilarity(semantic, item.semantic)
    if (similarity <= 0.8) continue
    const sameArtist = artistOverlap(track.artist, item.artist)
    const sameTrack = trackKey(track) === item.trackKey
    if (item.action === 'more_like_this') {
      score += Math.min(4.4, similarity * 0.75 + (sameArtist ? 0.7 : 0) + (sameTrack ? 1.4 : 0)) * item.weight
    } else if (item.action === 'not_right') {
      if (options.ignoreNegative) continue
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
  const energy = semantic.energy ?? 0.5
  if (intent.energy === 'low') score += Math.max(0, 2 - energy * 2)
  if (intent.energy === 'high') {
    score += energy * 5
    if (energy < 0.55) score -= 5
  }
  if (intent.familiarity === 'safe' && semantic.familiarity === 'safe') score += 1.5
  if (intent.familiarity === 'explore' && track.recommendSource === 'new_song') score += 1.5
  if (intent.artistQuery && normalizeText(track.artist).includes(normalizeText(intent.artistQuery))) score += 8
  if (intent.seedTitle && normalizeText(track.title).includes(normalizeText(intent.seedTitle))) score += 10
  if (track.recommendSource === 'similar') score += 1.2
  if (track.recommendSource === 'artist') score += 0.9
  if (track.recommendSource === 'playlist') score += 0.7
  if (track.recommendSource === 'daily' || track.recommendSource === 'fm') score += 0.8
  const explicitExactTrackRequest = intentExplicitlyRequestsExactTrack(track, intent)
  const rawFeedbackScore = feedbackScore(track)
  score += explicitExactTrackRequest
    ? Math.max(0, Math.min(5, rawFeedbackScore))
    : Math.max(-5, Math.min(5, rawFeedbackScore))
  score += directionMemoryScore(track, semantic, memory, { ignoreNegative: explicitExactTrackRequest })
  if (constraints) score += recommendationMemoryConstraintScore(track, intent, constraints)
  if (hasTrackIdentity(recentKeys, track) && !(intent.seedTitle && normalizeText(track.title).includes(normalizeText(intent.seedTitle)))) score -= 12
  if (profile?.energy_preference != null && intent.energy == null) {
    const gap = Math.abs((semantic.energy ?? 0.5) - profile.energy_preference)
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

export function scoreCandidateForTest(
  track: Track,
  intent: RecommendationIntent,
  recentKeys: Set<string>,
  memory: DirectionMemoryItem[],
  profile?: TasteProfile | null,
  constraints?: RecommendationMemoryConstraints,
): number {
  return scoreCandidateWithFeedback(track, intent, recentKeys, memory, () => 0, profile, constraints)
}

export function genericDiscoveryScore(track: Track, recentSevenDayKeys: Set<string>, memory: DirectionMemoryItem[], intent?: RecommendationIntent, constraints?: RecommendationMemoryConstraints): number {
  return genericDiscoveryScoreWithContext(track, recentSevenDayKeys, memory, {}, intent, constraints)
}

export function genericDiscoveryScoreWithContext(
  track: Track,
  recentSevenDayKeys: Set<string>,
  memory: DirectionMemoryItem[],
  determinism: Partial<RecommendationDeterminismContext>,
  intent?: RecommendationIntent,
  constraints?: RecommendationMemoryConstraints,
): number {
  const semantic = semanticForCandidate(track)
  const seed = `${determinism.daySeed ?? 'stable'}:${intent?.query ?? 'generic'}:${trackKey(track)}:${track.recommendSource ?? ''}`
  let score = stableUnit(seed) * GENERIC_DISCOVERY_JITTER_MAX
  if (semantic.familiarity === 'explore') score += EXPLORE_FAMILIARITY_BONUS
  if (track.recommendSource === 'style') score += STYLE_SOURCE_BONUS
  if (track.recommendSource === 'search') score += SEARCH_SOURCE_BONUS
  score += directionMemoryScore(track, semantic, memory, { ignoreNegative: intentExplicitlyRequestsExactTrack(track, intent) })
  if (intent && constraints) score += recommendationMemoryConstraintScore(track, intent, constraints)
  if (hasTrackIdentity(recentSevenDayKeys, track)) score -= RECENT_DISCOVERY_PENALTY
  return score
}

export function matchesIntentFloor(track: Track, intent: RecommendationIntent): boolean {
  const semantic = track.semantic ?? semanticForCandidate(track)
  const energy = semantic.energy ?? 0.5
  if (typeof intent.rejectIf?.minEnergy === 'number' && energy < intent.rejectIf.minEnergy) return false
  if (typeof intent.rejectIf?.maxEnergy === 'number' && energy > intent.rejectIf.maxEnergy) return false
  if (intent.rejectIf?.forbidTempo?.includes(semantic.tempo)) return false
  if (intent.rejectIf?.requireTempo?.length && !intent.rejectIf.requireTempo.includes(semantic.tempo)) return false
  if (intent.energy === 'high' && energy < 0.5 && semantic.tempo !== 'fast') return false
  if (intent.tempo === 'fast' && semantic.tempo === 'slow' && energy < 0.6) return false
  if (intent.energy === 'low' && energy > 0.78) return false
  if (intent.tempo === 'slow' && semantic.tempo === 'fast' && energy > 0.72) return false
  return true
}
