import type { TasteProfile, Track } from '../../types/ipc'
import { getRecommendationCache, setRecommendationCache } from '../db/recommendationCache'
import { loadListenedTrackWindows, loadRecentRecommendedTracks } from '../db/tracks'
import { getTasteProfile } from '../db/taste'
import { filterPlayableTracks } from '../netease/music'
import { readNeteaseCookie } from '../netease/auth'
import { sceneIntentOverride } from './scene'
import {
  diversifyByArtist,
  hasTrackIdentity,
  normalizeText,
  trackIdentitySet,
  uniqueTracks,
} from './recommendation/text'
import {
  GENERIC_DISCOVERY_PATTERN,
  MAX_RECOMMENDATION_COUNT,
  MUSIC_REQUEST_PATTERN,
  OVER_LIMIT_RECOMMENDATION_LINE,
  SPECIFIC_DISCOVERY_PATTERN,
  inferIntentWithLlm,
  mergeIntent,
  parseIntent,
  parseRequestedTrackCount,
  validateIntentOverride,
  type IntentOverride,
  type RecommendationIntent,
} from './recommendation/intent'
import {
  buildDirectionMemory,
  genericDiscoveryScoreWithContext,
  matchesIntentFloor,
  scoreCandidate,
  scoreCandidateForTest,
  semanticForCandidate,
  type DirectionMemoryItem,
} from './recommendation/scoring'
import { selectFinalTracks } from './recommendation/selection'
import { fetchCandidates, fetchGenericDiscoveryCandidates } from './recommendation/recall'
import { NeteaseAuthRequiredError } from './recommendation/errors'
import { buildRecommendationMemoryConstraints } from './recommendation/memoryConstraints'
import { currentMusicCorrectionConstraintForQuery } from '../skills/music/correctionMemory'
import { filterTracksByMusicEntity, mergeMusicEntityConstraints, type MusicEntityConstraint } from '../skills/music/verifier'
import { createRecommendationDeterminismContext, stableShuffle, type RecommendationDeterminismContext } from './recommendation/deterministic'

export {
  MAX_RECOMMENDATION_COUNT,
  NeteaseAuthRequiredError,
  OVER_LIMIT_RECOMMENDATION_LINE,
  inferIntentWithLlm,
  parseRequestedTrackCount,
  validateIntentOverride,
}

export type { IntentOverride, RecommendationIntent } from './recommendation/intent'

export interface RecommendationOptions {
  ignoreScene?: boolean
  disableEntityInference?: boolean
  candidatePoolSize?: number
  /** @deprecated use candidatePoolSize */
  candidateCount?: number
  signal?: AbortSignal
  onProgress?: (patch: RecommendationProgressPatch) => void
}

export interface RecommendationProgressPatch {
  phase?: string
  current?: number
  total?: number
  message?: string
}

function assertRecommendationActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('任务已取消', 'AbortError')
}

function reportRecommendationProgress(options: RecommendationOptions, patch: RecommendationProgressPatch): void {
  options.onProgress?.(patch)
}

function candidatePoolSize(options: RecommendationOptions): number | undefined {
  const value = options.candidatePoolSize ?? options.candidateCount
  if (!value || !Number.isFinite(value)) return undefined
  return Math.max(1, Math.floor(value))
}

function intentForCandidatePool(intent: RecommendationIntent, poolSize?: number): RecommendationIntent {
  if (!poolSize || poolSize <= intent.targetCount) return intent
  return { ...intent, targetCount: poolSize }
}

function queryFingerprint(text: string): string {
  return normalizeText(text)
    .replace(/推|推荐|来几首|来一首|听什么|听啥|值得听|适合听|想听|能听|放点|放首|来点|找首|找一首|给我|歌曲|歌|音乐|曲/g, '')
    .slice(0, 48)
}

function buildCacheKey(intent: RecommendationIntent, determinism?: Partial<RecommendationDeterminismContext>): string {
  return normalizeText(JSON.stringify({
    daySeed: determinism?.daySeed,
    moods: intent.moods,
    scenes: intent.scenes,
    language: intent.language,
    energy: intent.energy,
    tempo: intent.tempo,
    familiarity: intent.familiarity,
    targetCount: intent.targetCount,
    seedTitle: intent.seedTitle,
    artistQuery: intent.artistQuery,
    evidence: intent.evidence?.slice(0, 6).sort(),
    rejectIf: intent.rejectIf,
    sceneKey: intent.sceneKey,
    query: queryFingerprint(intent.query),
  }))
}

function hasExplicitSpecificRequest(text: string, intent: RecommendationIntent): boolean {
  if (intent.artistQuery || intent.seedTitle || intent.language) return true
  if (SPECIFIC_DISCOVERY_PATTERN.test(text)) return true
  const evidence = intent.evidence ?? []
  if (evidence.some((item) => SPECIFIC_DISCOVERY_PATTERN.test(item))) return true
  return false
}

function isGenericDiscoveryRequest(text: string, intent: RecommendationIntent): boolean {
  if (intent.sceneKey) return false
  if (!MUSIC_REQUEST_PATTERN.test(text)) return false
  if (!GENERIC_DISCOVERY_PATTERN.test(text)) return false
  return !hasExplicitSpecificRequest(text, intent)
}

function withGenericReason(track: Track, index: number): Track {
  const notes = [
    '按你常听的气质随手捞一首,今天先从它开始。',
    '这首从你的风格偏好里长出来,放在后面刚好换口气。',
    '这一首保留一点新鲜感,接着听会比较顺。',
    '这首颜色轻一点,适合把这组歌铺开。',
    '最后这首收得稳,留一点余味。',
  ]
  return { ...track, reason: track.reason ?? notes[index] ?? '这首从你的风格偏好里捞出来,现在听刚好。' }
}

async function recommendGenericDiscovery(intent: RecommendationIntent, options: RecommendationOptions, poolSize: number | undefined, determinism: RecommendationDeterminismContext, profile: TasteProfile | null): Promise<Track[]> {
  reportRecommendationProgress(options, { phase: 'generic-discovery', current: 2, total: 5, message: '按画像召回泛推荐候选' })
  const recallIntent = intentForCandidatePool(intent, poolSize)
  const desiredCount = poolSize ?? intent.targetCount
  const candidates = await fetchGenericDiscoveryCandidates(recallIntent, options.signal, determinism, { profile })
  assertRecommendationActive(options.signal)
  const memory = buildDirectionMemory()
  const constraints = buildRecommendationMemoryConstraints(profile)
  const listenedWindows = loadListenedTrackWindows(24 * 7, 800, 24, 400)
  const lastDayKeys = trackIdentitySet(listenedWindows.recent)
  const lastSevenDayKeys = trackIdentitySet(listenedWindows.history)
  const enriched = uniqueTracks(candidates.map((track) => ({ ...track, semantic: semanticForCandidate(track) })))
    .map((track) => ({ track, score: genericDiscoveryScoreWithContext(track, lastSevenDayKeys, memory, determinism, intent, constraints) }))
    .sort((a, b) => b.score - a.score)
    .map((item) => item.track)

  const stages = [
    enriched.filter((track) => !hasTrackIdentity(lastDayKeys, track) && !hasTrackIdentity(lastSevenDayKeys, track)),
    enriched.filter((track) => !hasTrackIdentity(lastDayKeys, track)),
  ]

  for (const stage of stages) {
    if (stage.length === 0) continue
    const playable = await filterPlayableTracks(stage, Math.max(20, desiredCount * 8), options.signal)
    assertRecommendationActive(options.signal)
    const picked = diversifyByArtist(uniqueTracks(playable), poolSize ? 2 : 1).slice(0, desiredCount).map(withGenericReason)
    if (picked.length) {
      return picked.map((track) => ({
        ...track,
        profileEvidence: {
          moods: intent.moods,
          scenes: intent.scenes,
          source: track.recommendSource ?? 'search',
          score: genericDiscoveryScoreWithContext(track, lastSevenDayKeys, memory, determinism, intent, constraints),
        },
      }))
    }
  }

  return []
}

function isArtistFocusedIntent(intent: RecommendationIntent): boolean {
  return Boolean(intent.artistQuery) && !intent.seedTitle && intent.moods.every((mood) => mood === '陪伴')
}

function isDirectSongRequest(text: string, intent: RecommendationIntent): boolean {
  if (!intent.seedTitle) return false
  if (/像|类似|相似|那种|那类|风格/.test(text)) return false
  return /想听|想要听|要听|我要听|我想听|播放|放首|放|找首|找一首|来一首|听/.test(text)
}

function titleMatchesSeed(track: Track, seedTitle?: string): boolean {
  const seed = normalizeText(seedTitle ?? '')
  const title = normalizeText(track.title)
  if (!seed || !title) return false
  return title === seed || title.includes(seed)
}

function artistMatchesQuery(track: Track, artistQuery?: string): boolean {
  const query = normalizeText(artistQuery ?? '')
  if (!query) return true
  return normalizeText(track.artist).includes(query)
}

function directSongCandidates(tracks: Track[], intent: RecommendationIntent): Track[] {
  const titleMatched = uniqueTracks(tracks).filter((track) => titleMatchesSeed(track, intent.seedTitle))
  const artistMatched = titleMatched.filter((track) => artistMatchesQuery(track, intent.artistQuery))
  return artistMatched.length ? artistMatched : intent.artistQuery ? [] : titleMatched
}

function shuffleTracks(tracks: Track[], seed: string): Track[] {
  return stableShuffle(tracks, seed, (track) => `${track.title}:${track.artist}:${track.neteaseId ?? track.id ?? ''}`)
}

function constraintFromIntent(intent: RecommendationIntent): MusicEntityConstraint | undefined {
  const intentConstraint = intent.artistQuery || intent.seedTitle
    ? {
        artistQuery: intent.artistQuery,
        seedTitle: intent.seedTitle,
      }
    : undefined
  return mergeMusicEntityConstraints(intentConstraint, currentMusicCorrectionConstraintForQuery(intent.query))
}

function constrainByIntent<T extends Track>(tracks: T[], intent: RecommendationIntent): T[] {
  return filterTracksByMusicEntity(tracks, constraintFromIntent(intent), {
    strictArtist: Boolean(intent.artistQuery),
  })
}

export async function pickPlayableCandidatesForTest(
  candidates: Track[],
  intent: RecommendationIntent,
  recentTracks: Track[],
  playableFilter: (tracks: Track[], limit: number) => Promise<Track[]>,
  memory: DirectionMemoryItem[] = [],
): Promise<Track[]> {
  const recentKeys = trackIdentitySet(recentTracks)
  const ranked = uniqueTracks(candidates)
    .map((track) => ({ track: { ...track, semantic: semanticForCandidate(track) }, score: scoreCandidateForTest(track, intent, recentKeys, memory) }))
    .sort((a, b) => b.score - a.score)
    .map((item) => item.track)
    .filter((track) => !hasTrackIdentity(recentKeys, track) && matchesIntentFloor(track, intent))
  return playableFilter(ranked, intent.targetCount)
}

export const recommendationTestHelpers = {
  buildCacheKey,
  hasTrackIdentity,
  matchesIntentFloor,
  parseIntent,
  scoreCandidate: scoreCandidateForTest,
  trackIdentitySet,
}

export async function recommendFromNetease(text: string, override?: IntentOverride, options: RecommendationOptions = {}): Promise<Track[]> {
  assertRecommendationActive(options.signal)
  if (!readNeteaseCookie()) throw new NeteaseAuthRequiredError()
  const inferEntities = !options.disableEntityInference
  const baseIntent = mergeIntent(parseIntent(text, { inferEntities }), options.ignoreScene ? undefined : sceneIntentOverride())
  const intent = mergeIntent(baseIntent, validateIntentOverride(text, override ?? null, { inferEntities }) ?? undefined)
  const determinism = createRecommendationDeterminismContext()
  const poolSize = candidatePoolSize(options)
  const recallIntent = intentForCandidatePool(intent, poolSize)
  const desiredCount = poolSize ?? intent.targetCount
  const profile = getTasteProfile()
  reportRecommendationProgress(options, { phase: 'intent', current: 1, total: 5, message: '解析推荐意图' })
  if (isGenericDiscoveryRequest(text, intent)) {
    return recommendGenericDiscovery(intent, options, poolSize, determinism, profile)
  }
  const directSongRequest = isDirectSongRequest(text, intent)
  const allowCooldownFallback = Boolean(intent.seedTitle || intent.artistQuery || intent.sceneKey)
  function matchesSeedTitle(track: Track): boolean {
    if (!intent.seedTitle) return false
    return normalizeText(track.title).includes(normalizeText(intent.seedTitle))
  }
  const cacheKey = buildCacheKey(intent, determinism)
  const memory = buildDirectionMemory()
  const constraints = buildRecommendationMemoryConstraints(profile)
  const listenedWindows = loadListenedTrackWindows(24 * 7, 900, 24, 500)
  const hardCooldownKeys = trackIdentitySet(listenedWindows.recent)
  const recentKeys = trackIdentitySet([...loadRecentRecommendedTracks(120), ...listenedWindows.history])
  const cached = getRecommendationCache(cacheKey)
  reportRecommendationProgress(options, { phase: 'cache', current: 2, total: 5, message: '检查推荐缓存和冷却' })
  if (cached?.tracks.length && !poolSize) {
    const cachedFreshSource = directSongRequest ? directSongCandidates(cached.tracks, intent) : constrainByIntent(cached.tracks, intent)
    const cachedFresh = cachedFreshSource
      .filter((track) => !hasTrackIdentity(hardCooldownKeys, track) && (matchesSeedTitle(track) || !hasTrackIdentity(recentKeys, track)))
      .map((track) => ({ ...track, semantic: track.semantic ?? semanticForCandidate(track), playUrl: undefined, urlExpiresAt: undefined }))
      .filter((track) => matchesIntentFloor(track, intent))
    const playable = await filterPlayableTracks(cachedFresh, intent.targetCount, options.signal)
    assertRecommendationActive(options.signal)
    if (playable.length >= intent.targetCount) return playable
  }

  reportRecommendationProgress(options, { phase: 'recall', current: 3, total: 5, message: '召回网易云候选歌曲' })
  const candidates = constrainByIntent(await fetchCandidates(recallIntent, options.signal, determinism, { profile }), intent)
  assertRecommendationActive(options.signal)
  if (directSongRequest) {
    const directPool = directSongCandidates(candidates, intent)
    const playableDirect = await filterPlayableTracks(directPool, intent.targetCount, options.signal)
    assertRecommendationActive(options.signal)
    const picked = playableDirect.slice(0, intent.targetCount).map((track) => ({
      ...track,
      reason: '你点名要听的。',
    }))
    if (picked.length) {
      setRecommendationCache(cacheKey, intent as unknown as Record<string, unknown>, picked.map((track) => ({ ...track, playUrl: undefined, urlExpiresAt: undefined })))
    }
    return picked
  }
  if (isArtistFocusedIntent(intent)) {
    const artistCandidates = candidates
      .filter((track) => !hasTrackIdentity(hardCooldownKeys, track))
      .filter((track) => !hasTrackIdentity(recentKeys, track))
      .filter((track) => intent.artistQuery ? normalizeText(track.artist).includes(normalizeText(intent.artistQuery)) : true)
    const fallbackArtistCandidates = candidates
      .filter((track) => !hasTrackIdentity(hardCooldownKeys, track))
      .filter((track) => intent.artistQuery ? normalizeText(track.artist).includes(normalizeText(intent.artistQuery)) : true)
    const lastResortArtistCandidates = allowCooldownFallback
      ? candidates.filter((track) => intent.artistQuery ? normalizeText(track.artist).includes(normalizeText(intent.artistQuery)) : true)
      : []
    const playableArtistTracks = await filterPlayableTracks(shuffleTracks(
      artistCandidates.length ? artistCandidates : fallbackArtistCandidates.length ? fallbackArtistCandidates : lastResortArtistCandidates,
      `${determinism.daySeed}:artist:${intent.query}:${intent.artistQuery ?? ''}:${desiredCount}`,
    ), desiredCount, options.signal)
    assertRecommendationActive(options.signal)
    if (playableArtistTracks.length) {
      const picked = playableArtistTracks.slice(0, desiredCount).map((track) => ({
        ...track,
        reason: track.reason ?? `${intent.artistQuery} 的歌里,这首现在接上就行。`,
      }))
      if (!poolSize) setRecommendationCache(cacheKey, intent as unknown as Record<string, unknown>, picked.map((track) => ({ ...track, playUrl: undefined, urlExpiresAt: undefined })))
      return picked
    }
  }
  const ranked = candidates
    .map((track) => ({ track: { ...track, semantic: semanticForCandidate(track) }, score: scoreCandidate(track, intent, recentKeys, memory, profile, constraints) }))
    .sort((a, b) => b.score - a.score)
    .map((item) => item.track)
  reportRecommendationProgress(options, { phase: 'rank', current: 4, total: 5, message: `排序 ${ranked.length} 首候选` })
  const intentMatched = ranked.filter((track) => !hasTrackIdentity(hardCooldownKeys, track) && (matchesSeedTitle(track) || !hasTrackIdentity(recentKeys, track)) && (matchesSeedTitle(track) || matchesIntentFloor(track, intent)))
  const cooledPool = ranked.filter((track) => !hasTrackIdentity(hardCooldownKeys, track) && matchesIntentFloor(track, intent))
  const fallbackPool = allowCooldownFallback ? ranked.filter((track) => matchesIntentFloor(track, intent)) : []
  const primaryPool = intentMatched.length >= desiredCount ? intentMatched : cooledPool.length >= desiredCount ? cooledPool : fallbackPool
  const playablePool = await filterPlayableTracks(primaryPool, Math.max(20, desiredCount * 8), options.signal)
  assertRecommendationActive(options.signal)
  const diversifiedPool = diversifyByArtist(playablePool, 2)
  if (poolSize) return diversifiedPool.slice(0, poolSize)
  reportRecommendationProgress(options, { phase: 'select', current: 5, total: 5, message: '生成最终推荐理由' })
  const finalTracks = await selectFinalTracks(text, diversifiedPool, intent, options.signal)
  assertRecommendationActive(options.signal)
  const evidencedTracks = finalTracks.map((track) => ({
    ...track,
    reason: matchesSeedTitle(track) ? `你点名要听的。` : track.reason,
    profileEvidence: {
      moods: intent.moods,
      scenes: intent.scenes,
      source: track.recommendSource ?? 'search',
      score: scoreCandidate(track, intent, recentKeys, memory, profile, constraints),
    },
  }))
  const playable = await filterPlayableTracks(evidencedTracks, intent.targetCount, options.signal)
  assertRecommendationActive(options.signal)
  if (playable.length) setRecommendationCache(cacheKey, intent as unknown as Record<string, unknown>, playable.map((track) => ({ ...track, playUrl: undefined, urlExpiresAt: undefined })))
  return playable
}
