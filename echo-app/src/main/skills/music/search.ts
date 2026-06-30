import type { Track } from '../../../types/ipc'
import {
  inferIntentWithLlm,
  NeteaseAuthRequiredError,
  recommendFromNetease,
  type IntentOverride,
  type RecommendationProgressPatch,
} from '../../services/recommendation'
import { listFavoriteTracks } from '../../db/favorites'
import { getAllImportedTracks } from '../../db/playlists'
import { loadRecentRecommendedTracks } from '../../db/tracks'
import {
  resolveMusicEntitiesFromText,
  verifyMusicEntitiesWithNetease,
  type MusicEntity,
  type MusicEntityResolution,
} from './entityResolver'
import { currentMusicCorrectionConstraintForQuery } from './correctionMemory'
import { artistMatchesConstraint, titleMatchesConstraint } from './verifier'
export { similarTrackSearchQuery } from './query'

export type MusicSearchMode =
  | 'direct-song'
  | 'similar-to-track'
  | 'scene'
  | 'voice'
  | 'generic'

export type MusicSearchFailureReason =
  | 'entity_unclear'
  | 'artist_not_found'
  | 'track_not_found'
  | 'not_playable'
  | 'candidate_mismatch'
  | 'auth_required'
  | 'search_failed'

export interface MusicSearchFailure {
  reason: MusicSearchFailureReason
  artistQuery?: string
  seedTitle?: string
  verificationStatus?: MusicEntityResolution['verificationStatus']
}

export interface MusicSearchRequest {
  query: string
  mode: MusicSearchMode
  candidatePoolSize?: number
  /** @deprecated use candidatePoolSize */
  candidateCount?: number
  respectCooldown?: boolean
  targetCount?: number
  ignoreScene?: boolean
  intentOverride?: IntentOverride | null
  authoritativeIntentEntities?: boolean
  authoritativeIntentSemantics?: boolean
  similarityReference?: Track
  signal?: AbortSignal
  onProgress?: (patch: RecommendationProgressPatch) => void
  onEntitiesResolved?: (resolution: MusicEntityResolution) => void
  onSearchFailure?: (failure: MusicSearchFailure) => void
}

export interface MusicIntentInferenceRequest {
  query: string
  mode: MusicSearchMode
  recentDialog?: string
  signal?: AbortSignal
}

function assertMusicSearchActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('任务已取消', 'AbortError')
}

function normalizeQuery(query: string): string {
  return query.trim()
}

function defaultIgnoreScene(mode: MusicSearchMode): boolean {
  return mode === 'direct-song' || mode === 'similar-to-track' || mode === 'voice'
}

function defaultCandidatePoolSize(mode: MusicSearchMode, targetCount?: number): number | undefined {
  if (mode === 'voice') return 8
  if (mode === 'scene') return Math.max(36, Math.max(1, targetCount ?? 1) * 18)
  return undefined
}

function withTargetCount(override: IntentOverride | null | undefined, targetCount?: number): IntentOverride | undefined {
  const next = override ? { ...override } : {}
  if (targetCount && !next.targetCount) next.targetCount = Math.max(1, Math.min(5, Math.floor(targetCount)))
  return Object.keys(next).length > 0 ? next : undefined
}

function withResolvedEntities(
  override: IntentOverride | null | undefined,
  entities: MusicEntityResolution,
  query: string,
  targetCount?: number,
): IntentOverride | undefined {
  const next = withTargetCount(override, targetCount) ?? {}
  const correction = currentMusicCorrectionConstraintForQuery(query)
  if (!next.clearArtistQuery && entities.artistQuery && (entities.verificationStatus === 'verified' || !next.artistQuery)) {
    next.artistQuery = entities.artistQuery
  }
  if (!next.clearSeedTitle && entities.seedTitle && (entities.verificationStatus === 'verified' || !next.seedTitle)) {
    next.seedTitle = entities.seedTitle
  }
  if (correction?.artistQuery) next.artistQuery = correction.artistQuery
  if (correction?.seedTitle) next.seedTitle = correction.seedTitle
  if (entities.explicitCount && entities.targetCount) {
    next.targetCount = entities.targetCount
  }
  if (entities.confidence > 0 && (next.intentConfidence == null || entities.confidence > next.intentConfidence)) {
    next.intentConfidence = entities.confidence
  }
  return Object.keys(next).length > 0 ? next : undefined
}

function withoutEntityTargets(override: IntentOverride | null | undefined): IntentOverride | undefined {
  if (!override) return undefined
  const next = { ...override }
  delete next.artistQuery
  delete next.seedTitle
  return Object.keys(next).length > 0 ? next : undefined
}

function similarityReferenceFromEntities(entities: MusicEntityResolution): Track | undefined {
  const title = entities.verifiedTrackTitle
  const id = entities.verifiedTrackId
  if (!title || !id) return undefined
  return {
    id,
    neteaseId: id,
    title,
    artist: entities.verifiedArtistName ?? entities.artistQuery ?? '未知艺人',
    source: 'netease',
  }
}

function localSimilarityReferenceFromEntities(entities: MusicEntityResolution): Track | undefined {
  if (!entities.seedTitle) return undefined
  const pool = [
    ...listFavoriteTracks({ limit: 80 }),
    ...loadRecentRecommendedTracks(120),
    ...getAllImportedTracks(),
  ]
  return pool.find((track) => {
    const titleOk = titleMatchesConstraint(track.title, entities.seedTitle, false)
    const artistOk = entities.artistQuery
      ? artistMatchesConstraint(track.artist, entities.artistQuery)
      : true
    return titleOk && artistOk
  })
}

function selectSimilarityReference(
  entities: MusicEntityResolution,
  contextualReference?: Track,
): Track | undefined {
  const explicitTrack = similarityReferenceFromEntities(entities)
  if (entities.seedTitle) return explicitTrack ?? localSimilarityReferenceFromEntities(entities)
  if (entities.artistQuery) return undefined
  return contextualReference
}

function selectSimilarityArtistQuery(entities: MusicEntityResolution): string | undefined {
  if (entities.seedTitle) return undefined
  return entities.verifiedArtistName ?? entities.artistQuery
}

function emptyEntityResolution(targetCount?: number): MusicEntityResolution {
  return {
    targetCount,
    requestedCount: targetCount ?? 1,
    explicitCount: Boolean(targetCount),
    entities: [],
    ambiguity: 'none',
    confidence: 0,
    source: 'rules',
    verificationStatus: 'not_needed',
  }
}

function shouldResolveEntities(mode: MusicSearchMode): boolean {
  return mode !== 'scene'
}

function resolutionWithIntentOverride(
  resolution: MusicEntityResolution,
  override: IntentOverride | null | undefined,
  preferOverrideEntities = false,
): MusicEntityResolution {
  if (!override?.artistQuery && !override?.seedTitle && !override?.clearArtistQuery && !override?.clearSeedTitle) return resolution
  const entities: MusicEntity[] = resolution.entities.filter((entity) => (
    !(override.clearArtistQuery && entity.kind === 'artist')
    && !(override.clearSeedTitle && entity.kind === 'title')
    && !(preferOverrideEntities && override.artistQuery && entity.kind === 'artist')
    && !(preferOverrideEntities && override.seedTitle && entity.kind === 'title')
  ))
  let artistQuery = override.clearArtistQuery ? undefined : resolution.artistQuery
  let seedTitle = override.clearSeedTitle ? undefined : resolution.seedTitle
  let added = false
  const confidence = Math.max(0.72, Math.min(0.96, override.intentConfidence ?? resolution.confidence ?? 0.72))

  if (override.artistQuery && (preferOverrideEntities || !artistQuery)) {
    artistQuery = override.artistQuery
    entities.push({
      kind: 'artist',
      text: override.artistQuery,
      sourceSpan: override.artistQuery,
      confidence,
      source: 'llm',
    })
    added = true
  }
  if (override.seedTitle && (preferOverrideEntities || !seedTitle)) {
    seedTitle = override.seedTitle
    entities.push({
      kind: 'title',
      text: override.seedTitle,
      sourceSpan: override.seedTitle,
      confidence,
      source: 'llm',
    })
    added = true
  }

  if (!added && artistQuery === resolution.artistQuery && seedTitle === resolution.seedTitle) return resolution
  return {
    ...resolution,
    artistQuery,
    seedTitle,
    verifiedArtistId: override.clearArtistQuery ? undefined : resolution.verifiedArtistId,
    verifiedArtistName: override.clearArtistQuery ? undefined : resolution.verifiedArtistName,
    verifiedTrackId: override.clearSeedTitle ? undefined : resolution.verifiedTrackId,
    verifiedTrackTitle: override.clearSeedTitle ? undefined : resolution.verifiedTrackTitle,
    entities,
    ambiguity: seedTitle && !artistQuery ? 'missing_artist' : 'none',
    confidence: Math.max(resolution.confidence, confidence),
    source: resolution.source === 'rules' ? 'llm' : resolution.source,
  }
}

export const musicSearchTestHelpers = {
  localSimilarityReferenceFromEntities,
  resolutionWithIntentOverride,
  selectSimilarityReference,
  selectSimilarityArtistQuery,
}

export function shouldInferMusicSearchIntent(mode: MusicSearchMode): boolean {
  return mode === 'generic' || mode === 'similar-to-track'
}

export async function inferMusicSearchIntent(request: MusicIntentInferenceRequest): Promise<IntentOverride | null> {
  assertMusicSearchActive(request.signal)
  if (!shouldInferMusicSearchIntent(request.mode)) return null
  const query = normalizeQuery(request.query)
  if (!query) return null
  const intent = await inferIntentWithLlm(query, request.recentDialog, { signal: request.signal })
  assertMusicSearchActive(request.signal)
  return intent
}

export function isMusicSearchAuthError(error: unknown): boolean {
  return error instanceof NeteaseAuthRequiredError
}

function inferSearchFailure(entities: MusicEntityResolution, tracks: Track[]): MusicSearchFailure | null {
  if (tracks.length > 0) return null
  const base = {
    artistQuery: entities.artistQuery,
    seedTitle: entities.seedTitle,
    verificationStatus: entities.verificationStatus,
  }
  if (entities.verificationStatus === 'auth_required') return { ...base, reason: 'auth_required' }
  if (entities.ambiguity === 'artist_or_title' || entities.ambiguity === 'missing_artist') return { ...base, reason: 'entity_unclear' }
  if (entities.artistQuery && !entities.verifiedArtistName && entities.verificationStatus === 'unverified') {
    return { ...base, reason: 'artist_not_found' }
  }
  if (entities.seedTitle && !entities.verifiedTrackTitle && entities.verificationStatus === 'unverified') {
    return { ...base, reason: 'track_not_found' }
  }
  if (entities.verifiedTrackId || entities.verifiedTrackTitle) return { ...base, reason: 'not_playable' }
  if (entities.artistQuery || entities.seedTitle) return { ...base, reason: 'track_not_found' }
  return { ...base, reason: 'search_failed' }
}

export async function searchMusic(request: MusicSearchRequest): Promise<Track[]> {
  assertMusicSearchActive(request.signal)
  const query = normalizeQuery(request.query)
  if (!query) return []
  const modeDefaultCandidatePoolSize = defaultCandidatePoolSize(request.mode, request.targetCount)
  const resolveEntities = shouldResolveEntities(request.mode)
  const ruleEntities = resolveEntities
    ? resolutionWithIntentOverride(
      resolveMusicEntitiesFromText(query),
      request.intentOverride,
      request.mode === 'similar-to-track' || request.authoritativeIntentEntities === true,
    )
    : emptyEntityResolution(request.targetCount)
  let verifiedEntities = ruleEntities
  if (resolveEntities) {
    request.onProgress?.({ phase: 'entity', message: '识别音乐实体' })
    request.onProgress?.({ phase: 'entity-verify', message: '校验艺人和歌名' })
    verifiedEntities = await verifyMusicEntitiesWithNetease(ruleEntities, { signal: request.signal }).catch((error) => {
      assertMusicSearchActive(request.signal)
      console.warn('[music-search] entity verification unavailable', error)
      return ruleEntities
    })
  }
  assertMusicSearchActive(request.signal)
  request.onEntitiesResolved?.(verifiedEntities)
  const resolvedOverride = resolveEntities
    ? withResolvedEntities(request.intentOverride, verifiedEntities, query, request.targetCount)
    : withTargetCount(request.intentOverride, request.targetCount)
  const similarityReference = request.mode === 'similar-to-track'
    ? selectSimilarityReference(verifiedEntities, request.similarityReference)
    : undefined
  const similarityArtistQuery = request.mode === 'similar-to-track'
    ? selectSimilarityArtistQuery(verifiedEntities)
    : undefined
  const similarityArtistId = request.mode === 'similar-to-track' && !verifiedEntities.seedTitle
    ? verifiedEntities.verifiedArtistId
    : undefined
  if (request.mode === 'similar-to-track' && verifiedEntities.seedTitle && !similarityReference) {
    const failure = inferSearchFailure(verifiedEntities, [])
    if (failure) request.onSearchFailure?.(failure)
    return []
  }
  const tracks = await recommendFromNetease(
    query,
    request.mode === 'similar-to-track' ? withoutEntityTargets(resolvedOverride) : resolvedOverride,
    {
      signal: request.signal,
      candidatePoolSize: request.candidatePoolSize ?? request.candidateCount ?? modeDefaultCandidatePoolSize,
      respectCooldown: request.respectCooldown,
      ignoreScene: request.ignoreScene ?? defaultIgnoreScene(request.mode),
      disableEntityInference: request.mode === 'similar-to-track' || !resolveEntities,
      similarityReference,
      similarityArtistQuery,
      similarityArtistId,
      preserveIntentSemantics: request.authoritativeIntentSemantics,
      onProgress: request.onProgress,
    },
  )
  assertMusicSearchActive(request.signal)
  const failure = inferSearchFailure(verifiedEntities, tracks)
  if (failure) request.onSearchFailure?.(failure)
  return tracks
}
