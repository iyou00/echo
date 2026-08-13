import type { ProfileDisplayModel, ProfileEvidenceLevel, ProfileEvidenceSource, ProfileInsight, ProfileInsightFeedbackAction, TasteProfile, Track, TrackSemantic } from '../../types/ipc'
import { trackIdentity as trackKey } from '../../shared/trackIdentity'
import { profileInsightConfirmationSignal } from '../../shared/profileInsight'
import { getDb } from '../db'
import { loadRecentConversations, loadTodayConversations } from '../db/conversations'
import { getFeedbackSignalCount, listProfileTrackFeedback, listTrackFeedback, listTrackFeedbackUpdatedSince, type TrackFeedback } from '../db/feedback'
import { getAllImportedTracks } from '../db/playlists'
import { clearRecommendationCache } from '../db/recommendationCache'
import { getTrackSemantic, listSemantics, semanticTrackKey } from '../db/semantics'
import { isExternalListeningSource, loadProfileTrackEvents, loadProfileTrackEventsBetween, type ProfileTrackEvent } from '../db/tracks'
import {
  addTasteQuestion,
  answerTasteQuestion as saveTasteQuestionAnswer,
  getPendingQuestions,
  getTasteProfile,
  listActiveProfileInsightFeedbackIds,
  publishTasteProfile,
  saveProfileInsightFeedback,
  saveTasteProfile,
} from '../db/taste'
import { getSettings } from '../db/settings'
import { getYinyiRange } from '../db/yinyi'
import { completeChat, LlmError, type LlmMessage } from '../llm/client'
import { escapePromptData, safePromptJson } from '../llm/promptData'
import { readRootFile } from '../utils/paths'
import { buildSoulPolicyPrompt } from '../skills/soul/policy'
import { inferTrackSemanticFallback } from './semantics'
import { buildMemoryEvidencePrompt, formatAvoidedPattern } from './memoryEvidence'
import { parseIntent, type RecommendationIntent } from './recommendation/intent'
import { musicLanguageGenre } from './recommendation/language'
import { buildRecentProfileInsights, filterAcknowledgedProfileInsights, profileEventAgencyFactor, profileTrackAgencyFactor } from './profileInsights'
import { listQualifiedActionItemIds } from '../db/agentActions'

interface ArtistSeed {
  genre?: string[]
  mood?: string[]
  signature_vibe?: string
  echo_should_ask?: boolean
}

interface PortraitResponse {
  portrait?: string
  summary?: string
  suggested_questions?: Array<{ kind?: string; content?: string; context?: Record<string, unknown> }>
}

export class PortraitRegenerationError extends Error {
  constructor(message: string) {
    super(message)
    this.name = 'PortraitRegenerationError'
  }
}

interface RegeneratePortraitOptions {
  refreshStructured?: boolean
  fallbackOnError?: boolean
  signal?: AbortSignal
  report?: (patch: { phase?: string; current?: number; total?: number; message?: string }) => void
}

function assertPortraitActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('任务已取消', 'AbortError')
}

function portraitRegenerationErrorFor(error: unknown): PortraitRegenerationError {
  if (error instanceof PortraitRegenerationError) return error
  if (error instanceof LlmError) {
    switch (error.kind) {
      case 'config':
        return new PortraitRegenerationError('模型配置还没准备好，画像文案没有刷新。')
      case 'auth':
        return new PortraitRegenerationError('模型鉴权失败，画像文案没有刷新。')
      case 'rate_limit':
        return new PortraitRegenerationError('模型请求有点频繁，画像文案稍后再刷新。')
      case 'timeout':
        return new PortraitRegenerationError('模型响应超时，画像文案稍后再刷新。')
      case 'network':
        return new PortraitRegenerationError('模型网络连接失败，画像文案稍后再刷新。')
      case 'server':
        return new PortraitRegenerationError('模型服务暂时异常，画像文案稍后再刷新。')
      case 'canceled':
        return new PortraitRegenerationError('画像文案刷新已取消。')
    }
  }
  return new PortraitRegenerationError('画像文案刷新失败。')
}

function clamp(value: number): number {
  return Math.max(0, Math.min(1, Number(value.toFixed(2))))
}

function readArtistSeed(): Record<string, ArtistSeed> {
  try {
    const parsed = JSON.parse(readRootFile('samples/artist-genre-seed.json')) as { artists?: Record<string, ArtistSeed> }
    return parsed.artists ?? {}
  } catch {
    return {}
  }
}

function countBy<T extends string>(items: T[]): Map<T, number> {
  const counts = new Map<T, number>()
  for (const item of items) counts.set(item, (counts.get(item) ?? 0) + 1)
  return counts
}

function topEntries(counts: Map<string, number>, limit: number): Array<[string, number]> {
  return Array.from(counts.entries()).sort((a, b) => b[1] - a[1]).slice(0, limit)
}

function eraForYear(year?: number): string | null {
  if (!year) return null
  if (year >= 2020) return '20s'
  if (year >= 2010) return '10s'
  if (year >= 2000) return '00s'
  if (year >= 1990) return '90s'
  if (year >= 1980) return '80s'
  if (year >= 1970) return '70s'
  return null
}

function addWeighted(counts: Map<string, number>, key: string, value: number): void {
  if (!key) return
  counts.set(key, (counts.get(key) ?? 0) + value)
}

function normalizedGenre(genre: string, language?: string): string {
  if (genre === '流行') {
    return musicLanguageGenre(language) ?? '华语流行'
  }
  if (/r&b/i.test(genre)) return 'Pop / R&B'
  return genre
}

function mostFrequent(items: string[]): string | null {
  const counts = countBy(items.filter(Boolean))
  return topEntries(counts, 1)[0]?.[0] ?? null
}

function eventMoods(events: ProfileTrackEvent[]): string[] {
  return events.flatMap((event) => event.track.profileEvidence?.moods ?? [])
}

function repeatedEventScene(events: ProfileTrackEvent[]): string | null {
  const counts = new Map<string, number>()
  for (const event of events.filter(isPositiveProfileEvent)) {
    for (const scene of event.track.profileEvidence?.scenes ?? []) {
      counts.set(scene, (counts.get(scene) ?? 0) + profileEventAgencyFactor(event))
    }
  }
  const top = topEntries(counts, 1)[0]
  return top && top[1] >= 2 ? top[0] : null
}

interface EvidenceNote {
  text?: string
  evidenceLevel: ProfileEvidenceLevel
  source: ProfileEvidenceSource
  count?: number
}

const LEGACY_PROFILE_NOTE_PATTERNS = [
  /耳朵很少抗拒它/,
  /像一个稳的回头点/,
  /它在你的「.*」安全区里很稳/,
  /安全区/,
  /接上/,
  /它是导入歌单里的稳定坐标/,
]

const PROFILE_WEIGHT = {
  importedTrack: 0.35,
  semanticBase: 2,
  semanticArtistBase: 0.8,
  playedFeedback: 0.9,
  loopFeedback: 2,
  favoriteFeedback: 2.4,
  skipFeedback: -1.2,
  positiveGenreFeedback: 0.8,
  completedEventGenre: 0.85,
  skippedEventGenre: -0.25,
  neutralEventGenre: 0.25,
  completedEventArtist: 0.55,
  skippedEventArtist: -0.35,
  neutralEventArtist: 0.15,
  eventMood: 0.7,
  eventGenreSemantic: 0.55,
  signatureFeedback: 2,
  signatureEvent: 0.45,
  signatureFavorite: 4,
  signatureLoop: 1.8,
} as const
const CHAT_SIGNATURE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000

function semanticProfileWeight(feedback: TrackFeedback | undefined, track: Track = feedback?.track ?? { title: '', artist: '' }): number {
  if (!feedback) return PROFILE_WEIGHT.semanticBase * profileTrackAgencyFactor(track)
  const positiveSignals = feedback.playCount + feedback.loopCount + feedback.favoriteCount + feedback.explicitLikeCount
  const negativeSignals = feedback.skipCount + feedback.explicitMissCount
  if (negativeSignals > 0 && positiveSignals === 0 && feedback.score <= 0) return 0
  const agency = profileTrackAgencyFactor(track)
  const positiveBoost = Math.max(0, Math.min(3, feedback.score))
  const negativeDrag = negativeSignals > positiveSignals ? 0.35 : 1
  return (PROFILE_WEIGHT.semanticBase + positiveBoost) * agency * negativeDrag
}

function effectiveProfilePlayCount(feedback: TrackFeedback | undefined, events: ProfileTrackEvent[]): number {
  const feedbackCount = (feedback?.playCount ?? 0) * profileTrackAgencyFactor(feedback?.track ?? {})
  const eventCount = events
    .filter(isPositiveProfileEvent)
    .reduce((sum, event) => sum + profileEventAgencyFactor(event), 0)
  return Math.max(feedbackCount, eventCount)
}

function hasLegacyProfileNote(note?: string): boolean {
  return Boolean(note && LEGACY_PROFILE_NOTE_PATTERNS.some((pattern) => pattern.test(note)))
}

function signatureEvidence(feedback: TrackFeedback | undefined, events: ProfileTrackEvent[], semanticMood?: string): EvidenceNote {
  if (feedback?.favoriteCount) return { text: '你主动收藏过,Echo 会把它留在代表曲里。', evidenceLevel: 'strong', source: 'favorite', count: feedback.favoriteCount }
  if ((feedback?.explicitLikeCount ?? 0) > 0) return { text: `主动表达想多听这种 ${feedback?.explicitLikeCount} 次。`, evidenceLevel: 'strong', source: 'explicit_like', count: feedback?.explicitLikeCount }
  if ((feedback?.loopCount ?? 0) >= 2) return { text: `你循环过 ${feedback?.loopCount} 次,属于会回头的声音。`, evidenceLevel: 'strong', source: 'loop', count: feedback?.loopCount }
  const effectivePlayCount = effectiveProfilePlayCount(feedback, events)
  if (effectivePlayCount >= 3) return { text: `你主动留下过这首歌。`, evidenceLevel: 'strong', source: 'played', count: Math.round(effectivePlayCount) }
  if ((feedback?.explicitMissCount ?? 0) > 0) return { text: `主动标记不太合适 ${feedback?.explicitMissCount} 次。`, evidenceLevel: 'medium', source: 'explicit_miss', count: feedback?.explicitMissCount }
  const scene = repeatedEventScene(events)
  if (scene) return { text: `${scene}时常出现在播放里。`, evidenceLevel: 'strong', source: 'scene' }
  const mood = mostFrequent(eventMoods(events)) ?? semanticMood
  if (mood) return { text: `「${mood}」线索`, evidenceLevel: 'medium', source: 'semantic' }
  return { text: undefined, evidenceLevel: 'weak', source: 'imported' }
}

function genreNote(
  name: string,
  weight: number,
  trend: 'up' | 'down' | 'steady',
  artists: string[],
  options: { hasBehaviorEvidence?: boolean } = {},
): { note: string; evidenceLevel: ProfileEvidenceLevel; source: ProfileEvidenceSource } {
  const evidenceLevel: ProfileEvidenceLevel = (artists.length >= 2 || weight >= 0.18 || trend !== 'steady') ? 'medium' : 'weak'
  const canDescribeChange = Boolean(options.hasBehaviorEvidence)
  const source: ProfileEvidenceSource = canDescribeChange
    ? 'played'
    : artists.length > 0
      ? 'semantic'
      : 'fallback'
  if (artists.length === 0) {
    const pct = Math.round(weight * 100)
    if (canDescribeChange && trend === 'up') return { note: `${name} 最近上来,占比 ${pct}%`, evidenceLevel, source }
    if (canDescribeChange && trend === 'down') return { note: `${name} 占比 ${pct}%,在收`, evidenceLevel, source }
    return { note: `${name} · ${pct}%`, evidenceLevel, source }
  }
  const top = artists[0]
  const pct = Math.round(weight * 100)
  if (canDescribeChange && trend === 'up') return { note: `${top} 推动 ${name} 上来 · ${pct}%`, evidenceLevel, source }
  if (canDescribeChange && trend === 'down') return { note: `${top} 还在,${name} 收了一点 · ${pct}%`, evidenceLevel, source }
  return { note: `${top} · ${pct}%`, evidenceLevel, source }
}

function artistEvidence(stats: ArtistStats, seed?: ArtistSeed): EvidenceNote {
  if (stats.favorited > 0) return { text: `收藏过 ${stats.favorited} 首`, evidenceLevel: 'strong', source: 'favorite' }
  if (stats.looped > 0) return { text: `循环过 ${stats.looped} 次`, evidenceLevel: 'strong', source: 'loop' }
  if (stats.explicitLiked > 0) return { text: `主动想多听 ${stats.explicitLiked} 次`, evidenceLevel: 'strong', source: 'explicit_like' }
  if (stats.explicitMissed >= 2) return { text: `主动标记不合适 ${stats.explicitMissed} 次`, evidenceLevel: 'medium', source: 'explicit_miss' }
  if (stats.played >= 3) return { text: `完整听过 ${stats.played} 次`, evidenceLevel: 'strong', source: 'played' }
  const sceneCounts = countBy(stats.scenes)
  const sceneEntry = topEntries(sceneCounts, 1)[0]
  const scene = sceneEntry && sceneEntry[1] >= 2 ? sceneEntry[0] : null
  if (scene) return { text: `${scene}时常出现`, evidenceLevel: 'strong', source: 'scene' }
  if (stats.skipped >= 3 && stats.played < stats.skipped) return { text: `跳过 ${stats.skipped} 次`, evidenceLevel: 'medium', source: 'explicit_miss' }
  if (stats.imported > 0) return { text: `导入 ${stats.imported} 首`, evidenceLevel: 'medium', source: 'imported' }
  if (seed?.signature_vibe) return { text: seed.signature_vibe, evidenceLevel: 'weak', source: 'semantic' }
  return { text: '还在观察', evidenceLevel: 'weak', source: 'fallback' }
}

interface ArtistStats {
  imported: number
  played: number
  skipped: number
  looped: number
  favorited: number
  explicitLiked: number
  explicitMissed: number
  scenes: string[]
  score: number
}

type ProfileStatsEvidence = NonNullable<NonNullable<TasteProfile['profile_meta']>['statsEvidence']>
type TempoPreference = NonNullable<TasteProfile['tempo_preference']>

interface SonicPreferenceBuildResult {
  energy?: number
  tempo?: TempoPreference
  energyImportedCount: number
  energyBehaviorCount: number
  tempoImportedCount: number
  tempoBehaviorCount: number
}

interface ProfileBuildContext {
  tracks: Track[]
  importedTrackKeys: Set<string>
  artistSeed: Record<string, ArtistSeed>
  semanticTracks: Array<{ title: string; artist: string; semantic: TrackSemantic }>
  feedbackRows: TrackFeedback[]
  profileEvents: ProfileTrackEvent[]
  feedbackByKey: Map<string, TrackFeedback>
  semanticByKey: Map<string, TrackSemantic>
  eventsByKey: Map<string, ProfileTrackEvent[]>
  genreCounts: Map<string, number>
  genreBehaviorCounts: Map<string, number>
  moodCounts: Map<string, number>
  moodBehaviorCounts: Map<string, number>
  eraCounts: Map<string, number>
  eraImportedCounts: Map<string, number>
  eraBehaviorCounts: Map<string, number>
  genreArtists: Map<string, Map<string, number>>
  artistStats: Map<string, ArtistStats>
}

function emptyArtistStats(): ArtistStats {
  return { imported: 0, played: 0, skipped: 0, looped: 0, favorited: 0, explicitLiked: 0, explicitMissed: 0, scenes: [], score: 0 }
}

function shouldIncludeArtistCandidate(stats: ArtistStats): boolean {
  const hasStrongPositiveSignal = stats.favorited > 0 || stats.looped > 0 || stats.explicitLiked > 0
  const hasDominantExplicitMiss = stats.explicitMissed >= 2 && !hasStrongPositiveSignal
  const hasDominantSkipSignal = stats.skipped >= 3 && stats.played < stats.skipped && !hasStrongPositiveSignal
  return stats.score > 0 && !hasDominantExplicitMiss && !hasDominantSkipSignal
}

function isPositiveProfileEvent(event: Pick<ProfileTrackEvent, 'source' | 'queueStatus'>): boolean {
  if (event.queueStatus === 'skipped' || event.queueStatus === 'pending') return false
  if (event.queueStatus === 'completed' || event.queueStatus === 'playing') return true
  return isExternalListeningSource(event.source)
}

function statsFor(context: ProfileBuildContext, artist: string): ArtistStats {
  const stats = context.artistStats.get(artist) ?? emptyArtistStats()
  context.artistStats.set(artist, stats)
  return stats
}

function addGenreArtistWeight(context: ProfileBuildContext, genre: string, artist: string, weight: number): void {
  const genreArtistMap = context.genreArtists.get(genre) ?? new Map<string, number>()
  genreArtistMap.set(artist, (genreArtistMap.get(artist) ?? 0) + weight)
  context.genreArtists.set(genre, genreArtistMap)
}

function addGenreBehaviorEvidence(context: ProfileBuildContext, genre: string, weight: number): void {
  if (!genre || weight <= 0) return
  context.genreBehaviorCounts.set(genre, (context.genreBehaviorCounts.get(genre) ?? 0) + weight)
}

function addMoodBehaviorEvidence(context: ProfileBuildContext, mood: string, weight: number): void {
  const tag = mood.trim()
  if (!tag || weight <= 0) return
  context.moodBehaviorCounts.set(tag, (context.moodBehaviorCounts.get(tag) ?? 0) + weight)
}

function semanticForProfile(context: ProfileBuildContext, track: Track): TrackSemantic {
  return context.semanticByKey.get(trackKey(track)) ?? track.semantic ?? inferTrackSemanticFallback(track)
}

function groupEventsByTrack(events: ProfileTrackEvent[]): Map<string, ProfileTrackEvent[]> {
  const eventsByKey = new Map<string, ProfileTrackEvent[]>()
  for (const event of events) {
    const key = trackKey(event.track)
    eventsByKey.set(key, [...(eventsByKey.get(key) ?? []), event])
  }
  return eventsByKey
}

function filterProfileEventsByActionOutcome(events: ProfileTrackEvent[], qualifiedActionItemIds: Set<string>): ProfileTrackEvent[] {
  return events.filter((event) => (
    event.queueStatus === 'skipped'
    || !event.track.agentActionItemId
    || qualifiedActionItemIds.has(event.track.agentActionItemId)
  ))
}

function createProfileBuildContext(tracks: Track[]): ProfileBuildContext {
  const semanticTracks = listSemantics()
  const feedbackRows = listProfileTrackFeedback()
  const qualifiedActionItemIds = listQualifiedActionItemIds()
  const profileEvents = filterProfileEventsByActionOutcome(loadProfileTrackEvents(), qualifiedActionItemIds)
  const importedTrackKeys = new Set(tracks.map((track) => trackKey(track)))
  return {
    tracks,
    importedTrackKeys,
    artistSeed: readArtistSeed(),
    semanticTracks,
    feedbackRows,
    profileEvents,
    feedbackByKey: new Map(feedbackRows.map((item) => [item.trackKey, item])),
    semanticByKey: new Map(semanticTracks.map((track) => [trackKey(track), track.semantic])),
    eventsByKey: groupEventsByTrack(profileEvents),
    genreCounts: new Map<string, number>(),
    genreBehaviorCounts: new Map<string, number>(),
    moodCounts: new Map<string, number>(),
    moodBehaviorCounts: new Map<string, number>(),
    eraCounts: new Map<string, number>(),
    eraImportedCounts: new Map<string, number>(),
    eraBehaviorCounts: new Map<string, number>(),
    genreArtists: new Map<string, Map<string, number>>(),
    artistStats: new Map<string, ArtistStats>(),
  }
}

function applyImportedTrackSignals(context: ProfileBuildContext): void {
  for (const track of context.tracks) {
    const seed = context.artistSeed[track.artist]
    const semantic = context.semanticByKey.get(trackKey(track)) ?? track.semantic
    const stats = statsFor(context, track.artist)
    stats.imported += 1
    stats.score += PROFILE_WEIGHT.importedTrack
    const importedGenres = seed?.genre?.length
      ? seed.genre
      : semantic
        ? []
        : ['流行']
    const importedMoods = seed?.mood?.length
      ? seed.mood
      : semantic
        ? []
        : ['calm']
    for (const genre of importedGenres) {
      const normalized = normalizedGenre(genre)
      addWeighted(context.genreCounts, normalized, PROFILE_WEIGHT.importedTrack)
      addGenreArtistWeight(context, normalized, track.artist, PROFILE_WEIGHT.importedTrack)
    }
    for (const mood of importedMoods) context.moodCounts.set(mood, (context.moodCounts.get(mood) ?? 0) + 1)
    const era = eraForYear(track.year)
    if (era) {
      context.eraCounts.set(era, (context.eraCounts.get(era) ?? 0) + 1)
      context.eraImportedCounts.set(era, (context.eraImportedCounts.get(era) ?? 0) + 1)
    }
  }
}

function applySemanticTrackSignals(context: ProfileBuildContext): void {
  for (const track of context.semanticTracks) {
    const feedback = context.feedbackByKey.get(trackKey(track))
    const semanticWeight = semanticProfileWeight(feedback, track)
    if (semanticWeight <= 0) continue
    const behaviorWeight = Math.max(0, semanticWeight - PROFILE_WEIGHT.semanticBase)
    const hasFeedbackEvidence = Boolean(
      feedback
      && (
        feedback.playCount > 0
        || feedback.skipCount > 0
        || feedback.loopCount > 0
        || feedback.favoriteCount > 0
        || feedback.explicitLikeCount > 0
        || feedback.explicitMissCount > 0
      ),
    )
    const behaviorEvidenceWeight = hasFeedbackEvidence
      ? Math.max(0.1, Math.abs(semanticWeight - PROFILE_WEIGHT.semanticBase))
      : 0
    for (const rawGenre of track.semantic.genres) {
      const genre = normalizedGenre(rawGenre, track.semantic.language)
      addWeighted(context.genreCounts, genre, semanticWeight)
      addGenreArtistWeight(context, genre, track.artist, 1 + behaviorWeight)
      if (behaviorEvidenceWeight > 0) addGenreBehaviorEvidence(context, genre, behaviorEvidenceWeight)
    }
    for (const mood of track.semantic.moods) {
      context.moodCounts.set(mood, (context.moodCounts.get(mood) ?? 0) + semanticWeight)
      if (behaviorEvidenceWeight > 0) addMoodBehaviorEvidence(context, mood, behaviorEvidenceWeight)
    }
    statsFor(context, track.artist).score += PROFILE_WEIGHT.semanticArtistBase + behaviorWeight
  }
}

function applyFeedbackSignals(context: ProfileBuildContext): void {
  for (const feedback of context.feedbackRows) {
    const artist = feedback.track.artist
    const semantic = semanticForProfile(context, feedback.track)
    const agency = profileTrackAgencyFactor(feedback.track)
    const positiveWeight = Math.max(0, Math.min(4, feedback.score)) * agency
    const stats = statsFor(context, artist)
    stats.played += feedback.playCount * agency
    stats.skipped += feedback.skipCount
    stats.looped += feedback.loopCount
    stats.favorited += feedback.favoriteCount
    stats.explicitLiked += feedback.explicitLikeCount
    stats.explicitMissed += feedback.explicitMissCount
    stats.score += feedback.playCount * PROFILE_WEIGHT.playedFeedback * agency
      + feedback.loopCount * PROFILE_WEIGHT.loopFeedback
      + feedback.favoriteCount * PROFILE_WEIGHT.favoriteFeedback
      + feedback.skipCount * PROFILE_WEIGHT.skipFeedback
      + feedback.explicitLikeCount * 0.8
      - feedback.explicitMissCount * 1.0
    if (positiveWeight > 0) {
      for (const rawGenre of semantic.genres) {
        const genre = normalizedGenre(rawGenre, semantic.language)
        addWeighted(context.genreCounts, genre, positiveWeight * PROFILE_WEIGHT.positiveGenreFeedback)
        addGenreBehaviorEvidence(context, genre, positiveWeight)
      }
      for (const mood of semantic.moods) {
        addWeighted(context.moodCounts, mood, positiveWeight)
        addMoodBehaviorEvidence(context, mood, positiveWeight)
      }
      const era = eraForYear(feedback.track.year)
      if (era) {
        const eraWeight = positiveWeight * 0.45
        addWeighted(context.eraCounts, era, eraWeight)
        addWeighted(context.eraBehaviorCounts, era, eraWeight)
      }
    }
  }
}

function applyProfileEventSignals(context: ProfileBuildContext): void {
  for (const event of context.profileEvents) {
    const artist = event.track.artist
    const semantic = semanticForProfile(context, event.track)
    const positiveEvent = isPositiveProfileEvent(event)
    const agency = profileEventAgencyFactor(event)
    const eventWeight = (event.queueStatus === 'completed'
      ? PROFILE_WEIGHT.completedEventGenre
      : event.queueStatus === 'skipped'
        ? PROFILE_WEIGHT.skippedEventGenre
        : PROFILE_WEIGHT.neutralEventGenre) * agency
    const stats = statsFor(context, artist)
    stats.score += (event.queueStatus === 'completed'
      ? PROFILE_WEIGHT.completedEventArtist
      : event.queueStatus === 'skipped'
        ? PROFILE_WEIGHT.skippedEventArtist
        : PROFILE_WEIGHT.neutralEventArtist) * agency
    if (positiveEvent) {
      if (agency >= 0.5) stats.scenes.push(...(event.track.profileEvidence?.scenes ?? []))
      for (const mood of event.track.profileEvidence?.moods ?? []) {
        const moodWeight = PROFILE_WEIGHT.eventMood * agency
        context.moodCounts.set(mood, (context.moodCounts.get(mood) ?? 0) + moodWeight)
        addMoodBehaviorEvidence(context, mood, moodWeight)
      }
    }
    if (eventWeight > 0) {
      for (const rawGenre of semantic.genres) {
        const genre = normalizedGenre(rawGenre, semantic.language)
        addWeighted(context.genreCounts, genre, eventWeight * PROFILE_WEIGHT.eventGenreSemantic)
        if (positiveEvent) addGenreBehaviorEvidence(context, genre, eventWeight)
      }
      for (const mood of semantic.moods) {
        addWeighted(context.moodCounts, mood, eventWeight)
        if (positiveEvent) addMoodBehaviorEvidence(context, mood, eventWeight)
      }
      const era = eraForYear(event.track.year)
      if (era && positiveEvent) {
        const eraWeight = sceneEventWeight(event) * 0.6
        addWeighted(context.eraCounts, era, eraWeight)
        addWeighted(context.eraBehaviorCounts, era, eraWeight)
      }
    }
  }
}

function applyProfileSignals(context: ProfileBuildContext): void {
  applyImportedTrackSignals(context)
  applySemanticTrackSignals(context)
  applyFeedbackSignals(context)
  applyProfileEventSignals(context)
}

function buildTopArtists(context: ProfileBuildContext): TasteProfile['artists'] {
  const candidates = Array.from(context.artistStats.entries()).filter(([, stats]) => shouldIncludeArtistCandidate(stats))
  const maxArtistScore = Math.max(1, ...candidates.map(([, stats]) => stats.score))
  return candidates.sort((a, b) => b[1].score - a[1].score).slice(0, 8).map(([name, stats]) => {
    const evidence = artistEvidence(stats, context.artistSeed[name])
    return {
      name,
      affinity: clamp(Math.max(0.08, stats.score / maxArtistScore)),
      notes: evidence.text,
    }
  })
}

function normalizedProfileLabel(value: string): string {
  return value.trim().toLowerCase()
}

function artistNameCandidates(value: string): string[] {
  const full = value.trim()
  if (!full) return []
  return [
    full,
    ...full.split(/\s*(?:\/|、|,|，|&|和)\s*/g),
  ].map(normalizedProfileLabel).filter(Boolean)
}

function profileArtistNameSet(context: ProfileBuildContext): Set<string> {
  const names = [
    ...Array.from(context.artistStats.keys()),
    ...context.tracks.map((track) => track.artist),
    ...context.semanticTracks.map((track) => track.artist),
    ...context.feedbackRows.map((feedback) => feedback.track.artist),
    ...context.profileEvents.map((event) => event.track.artist),
    ...Object.keys(context.artistSeed),
  ]
  return new Set(names.flatMap(artistNameCandidates))
}

function shouldKeepGenreName(name: string, artistNames: Set<string>): boolean {
  const cleanName = normalizedProfileLabel(name)
  return Boolean(cleanName) && !artistNames.has(cleanName)
}

function buildTopGenres(context: ProfileBuildContext, previous: TasteProfile | null, totalGenre: number): TasteProfile['genres'] {
  const artistNames = profileArtistNameSet(context)

  return topEntries(context.genreCounts, 16)
    .filter(([, count]) => count > 0)
    .filter(([name]) => shouldKeepGenreName(name, artistNames))
    .slice(0, 8)
    .map(([name, count]) => {
      const trend = (() => {
        const last = previous?.genres.find((genre) => genre.name === name)?.weight ?? 0
        const next = count / totalGenre
        if (next - last > 0.03) return 'up' as const
        if (last - next > 0.03) return 'down' as const
        return 'steady' as const
      })()
      return {
        name,
        weight: clamp(count / totalGenre),
        trend,
      }
    })
}

function buildMoodItems(context: ProfileBuildContext, totalMood: number, topArtists: TasteProfile['artists']): TasteProfile['moods'] {
  return topEntries(context.moodCounts, 8).map(([tag, count]) => ({
    tag,
    frequency: clamp(count / totalMood),
    signature_artists: topArtists.slice(0, 3).map((artist) => artist.name),
  }))
}

function sceneEventWeight(event: ProfileTrackEvent): number {
  if (!isPositiveProfileEvent(event)) return 0
  const completionWeight = event.queueStatus === 'completed' ? 1 : event.queueStatus === 'playing' ? 0.8 : 0.55
  return completionWeight * profileEventAgencyFactor(event)
}

function sceneItemsFromEvents(
  events: ProfileTrackEvent[],
  semanticForEvent: (event: ProfileTrackEvent) => TrackSemantic,
): NonNullable<TasteProfile['scenes']> {
  const counts = new Map<string, number>()
  for (const event of events) {
    const scenes = event.track.profileEvidence?.scenes?.length
      ? event.track.profileEvidence.scenes
      : semanticForEvent(event).scenes
    const weight = sceneEventWeight(event)
    if (weight <= 0) continue
    for (const scene of scenes) {
      const tag = scene.trim()
      if (!tag) continue
      counts.set(tag, (counts.get(tag) ?? 0) + weight)
    }
  }
  const total = Array.from(counts.values()).reduce((sum, value) => sum + value, 0)
  if (total <= 0) return []
  return topEntries(counts, 8).map(([tag, count]) => ({
    tag,
    frequency: clamp(count / total),
  }))
}

function buildSceneItems(context: ProfileBuildContext): NonNullable<TasteProfile['scenes']> {
  return sceneItemsFromEvents(context.profileEvents, (event) => semanticForProfile(context, event.track))
}

function feedbackBehaviorWeight(feedback: TrackFeedback | undefined): number {
  if (!feedback) return 0
  const agency = profileTrackAgencyFactor(feedback.track)
  const positive =
    feedback.playCount * 0.45 * agency +
    feedback.loopCount * 1.2 +
    feedback.favoriteCount * 1.5 +
    feedback.explicitLikeCount * 1.2
  const negative = feedback.skipCount * 0.4 + feedback.explicitMissCount * 0.9
  return Math.max(0, Math.min(5, positive - negative))
}

function positiveEventBehaviorWeight(event: ProfileTrackEvent): number {
  if (!isPositiveProfileEvent(event)) return 0
  return sceneEventWeight(event)
}

function buildSonicPreferences(context: ProfileBuildContext): SonicPreferenceBuildResult {
  const tempo: TempoPreference = { slow: 0, medium: 0, fast: 0 }
  let energyTotal = 0
  let totalWeight = 0
  let energyImportedCount = 0
  let energyBehaviorCount = 0
  let tempoImportedCount = 0
  let tempoBehaviorCount = 0

  for (const track of context.semanticTracks) {
    const key = trackKey(track)
    const feedback = context.feedbackByKey.get(key)
    const events = context.eventsByKey.get(key) ?? []
    const importedWeight = context.importedTrackKeys.has(key) ? PROFILE_WEIGHT.importedTrack : 0
    const behaviorWeight =
      feedbackBehaviorWeight(feedback) +
      events.reduce((sum, event) => sum + positiveEventBehaviorWeight(event), 0)
    const weight = importedWeight + behaviorWeight
    if (weight <= 0) continue

    energyTotal += track.semantic.energy * weight
    tempo[track.semantic.tempo] += weight
    totalWeight += weight
    if (importedWeight > 0) {
      energyImportedCount += 1
      tempoImportedCount += 1
    }
    if (behaviorWeight > 0) {
      energyBehaviorCount += 1
      tempoBehaviorCount += 1
    }
  }

  return {
    energy: totalWeight > 0 ? clamp(energyTotal / totalWeight) : undefined,
    tempo: totalWeight > 0 ? tempo : undefined,
    energyImportedCount,
    energyBehaviorCount,
    tempoImportedCount,
    tempoBehaviorCount,
  }
}

function countPositiveSceneEvents(context: ProfileBuildContext): number {
  return context.profileEvents.reduce((sum, event) => {
    if (!isPositiveProfileEvent(event)) return sum
    const semantic = semanticForProfile(context, event.track)
    const hasScene = (event.track.profileEvidence?.scenes?.length ?? 0) > 0 || semantic.scenes.length > 0
    return sum + (hasScene ? profileEventAgencyFactor(event) : 0)
  }, 0)
}

function buildProfileStatsEvidence(context: ProfileBuildContext, sonic: SonicPreferenceBuildResult): ProfileStatsEvidence {
  return {
    importedTrackCount: context.tracks.length,
    semanticTrackCount: context.semanticTracks.length,
    feedbackTrackCount: context.feedbackRows.filter((feedback) => feedbackBehaviorWeight(feedback) > 0).length,
    positiveEventCount: context.profileEvents.filter(isPositiveProfileEvent).reduce((sum, event) => sum + profileEventAgencyFactor(event), 0),
    eraImportedCount: Array.from(context.eraImportedCounts.values()).reduce((sum, value) => sum + value, 0),
    eraBehaviorCount: Array.from(context.eraBehaviorCounts.values()).reduce((sum, value) => sum + value, 0),
    energyImportedCount: sonic.energyImportedCount,
    energyBehaviorCount: sonic.energyBehaviorCount,
    tempoImportedCount: sonic.tempoImportedCount,
    tempoBehaviorCount: sonic.tempoBehaviorCount,
    sceneEventCount: countPositiveSceneEvents(context),
  }
}

function contextHasBehaviorEvidence(context: ProfileBuildContext): boolean {
  return (
    context.feedbackRows.some((feedback) => feedbackBehaviorWeight(feedback) > 0)
    || context.profileEvents.filter(isPositiveProfileEvent).reduce((sum, event) => sum + profileEventAgencyFactor(event), 0) >= 1
  )
}

function genreHasBehaviorEvidence(context: Pick<ProfileBuildContext, 'genreBehaviorCounts'>, genre: string): boolean {
  return (context.genreBehaviorCounts.get(genre) ?? 0) > 0
}

function moodHasBehaviorEvidence(context: Pick<ProfileBuildContext, 'moodBehaviorCounts'>, mood: string): boolean {
  return (context.moodBehaviorCounts.get(mood) ?? 0) > 0
}

function hasStatsEvidenceSignal(stats: ProfileStatsEvidence | undefined, kind: 'energy' | 'tempo' | 'scene'): boolean {
  if (!stats) return false
  if (kind === 'energy') return stats.energyImportedCount + stats.energyBehaviorCount > 0
  if (kind === 'tempo') return stats.tempoImportedCount + stats.tempoBehaviorCount > 0
  return stats.sceneEventCount > 0
}

function mergeCarriedStatsEvidence(rebuilt: TasteProfile, previous: TasteProfile | null): void {
  const previousStats = previous?.profile_meta?.statsEvidence
  const nextStats = rebuilt.profile_meta?.statsEvidence
  if (!previousStats || !nextStats) return
  const merged: ProfileStatsEvidence = { ...nextStats }
  if (!hasStatsEvidenceSignal(nextStats, 'energy') && hasStatsEvidenceSignal(previousStats, 'energy')) {
    merged.energyImportedCount = previousStats.energyImportedCount
    merged.energyBehaviorCount = previousStats.energyBehaviorCount
  }
  if (!hasStatsEvidenceSignal(nextStats, 'tempo') && hasStatsEvidenceSignal(previousStats, 'tempo')) {
    merged.tempoImportedCount = previousStats.tempoImportedCount
    merged.tempoBehaviorCount = previousStats.tempoBehaviorCount
  }
  if (!hasStatsEvidenceSignal(nextStats, 'scene') && hasStatsEvidenceSignal(previousStats, 'scene')) {
    merged.sceneEventCount = previousStats.sceneEventCount
  }
  rebuilt.profile_meta = {
    ...(rebuilt.profile_meta ?? {}),
    statsEvidence: merged,
  }
}

function shouldIncludeSignatureCandidate(
  feedback: TrackFeedback | undefined,
  events: ProfileTrackEvent[],
  score: number,
  evidence: { imported?: boolean } = {},
): boolean {
  const positiveEventCount = events.filter(isPositiveProfileEvent).reduce((sum, event) => sum + profileEventAgencyFactor(event), 0)
  const sceneCounts = new Map<string, number>()
  for (const event of events) {
    if (!isPositiveProfileEvent(event)) continue
    for (const scene of event.track.profileEvidence?.scenes ?? []) {
      const tag = scene.trim()
      if (!tag) continue
      sceneCounts.set(tag, (sceneCounts.get(tag) ?? 0) + profileEventAgencyFactor(event))
    }
  }
  const hasRepeatedSceneEvidence = Array.from(sceneCounts.values()).some((count) => count >= 2)
  const hasStrongPositive = Boolean(
    (feedback?.favoriteCount ?? 0) > 0
    || (feedback?.explicitLikeCount ?? 0) > 0
    || (feedback?.loopCount ?? 0) > 0
    || (feedback?.playCount ?? 0) * profileTrackAgencyFactor(feedback?.track ?? {}) >= 2
    || positiveEventCount >= 2
    || hasRepeatedSceneEvidence
  )
  const hasNegativeFeedback = (feedback?.skipCount ?? 0) > 0 || (feedback?.explicitMissCount ?? 0) > 0
  if (hasNegativeFeedback && !hasStrongPositive && (feedback?.score ?? 0) <= 0) return false
  if (hasStrongPositive) return score > 0
  return Boolean(evidence.imported && score > 0)
}

function buildSignatureTracks(context: ProfileBuildContext): Track[] {
  const candidateMap = new Map<string, Track>()
  for (const track of [...context.tracks, ...context.semanticTracks, ...context.feedbackRows.map((item) => item.track), ...context.profileEvents.map((event) => event.track)]) {
    if (track.title && track.artist && !track.title.includes('待补充')) candidateMap.set(trackKey(track), track)
  }
  return Array.from(candidateMap.values())
    .map((track) => {
      const key = trackKey(track)
      const feedback = context.feedbackByKey.get(key)
      const events = context.eventsByKey.get(key) ?? []
      const semantic = context.semanticByKey.get(key)
      const evidence = signatureEvidence(feedback, events, semantic?.moods[0])
      const score =
        (feedback?.score ?? 0) * PROFILE_WEIGHT.signatureFeedback +
        events.reduce((sum, event) => sum + profileEventAgencyFactor(event), 0) * PROFILE_WEIGHT.signatureEvent +
        (feedback?.favoriteCount ? PROFILE_WEIGHT.signatureFavorite : 0) +
        (feedback?.loopCount ?? 0) * PROFILE_WEIGHT.signatureLoop +
        (semantic?.confidence ?? 0) +
        (context.tracks.some((item) => trackKey(item) === key) ? PROFILE_WEIGHT.importedTrack : 0)
      const imported = context.importedTrackKeys.has(key)
      return {
        track: {
          ...track,
          reason: evidence.text,
        },
        score,
        feedback,
        events,
        imported,
        evidenceSource: evidence.source,
      }
    })
    .filter((item) => item.evidenceSource !== 'explicit_miss')
    .filter((item) => shouldIncludeSignatureCandidate(item.feedback, item.events, item.score, { imported: item.imported }))
    .sort((a, b) => b.score - a.score)
    .slice(0, 7)
    .map((item) => item.track)
}

function buildProfileDisplay(context: ProfileBuildContext, signatureTracks: Track[], topArtists: TasteProfile['artists'], topGenres: TasteProfile['genres'], moods: TasteProfile['moods']): ProfileDisplayModel {
  const hasBehaviorEvidence = contextHasBehaviorEvidence(context)
  return {
    signatureItems: signatureTracks.map((track) => {
      const key = trackKey(track)
      const evidence = signatureEvidence(context.feedbackByKey.get(key), context.eventsByKey.get(key) ?? [], context.semanticByKey.get(key)?.moods[0])
      return {
        track: { ...track, reason: evidence.text },
        note: evidence.text,
        count: evidence.count,
        evidenceLevel: evidence.evidenceLevel,
        source: evidence.source,
      }
    }),
    genreItems: topGenres.map((genre) => {
      const representativeArtists = topEntries(context.genreArtists.get(genre.name) ?? new Map<string, number>(), 3).map(([artist]) => artist)
      const evidence = genreNote(genre.name, genre.weight, genre.trend, representativeArtists, {
        hasBehaviorEvidence: hasBehaviorEvidence && genreHasBehaviorEvidence(context, genre.name),
      })
      return {
        name: genre.name,
        weight: genre.weight,
        trend: genre.trend,
        representativeArtists,
        note: evidence.note,
        evidenceLevel: evidence.evidenceLevel,
        source: evidence.source,
      }
    }),
    artistItems: topArtists.map((artist) => {
      const stats = context.artistStats.get(artist.name) ?? emptyArtistStats()
      const evidence = artistEvidence(stats, context.artistSeed[artist.name])
      return {
        name: artist.name,
        affinity: artist.affinity,
        note: evidence.text,
        evidenceLevel: evidence.evidenceLevel,
        source: evidence.source,
      }
    }),
    moodItems: moods.slice(0, 6).map((mood) => {
      const hasBehaviorEvidenceForMood = moodHasBehaviorEvidence(context, mood.tag)
      return {
        tag: mood.tag,
        frequency: mood.frequency,
        evidenceLevel: hasBehaviorEvidenceForMood || mood.frequency >= 0.18 ? 'medium' : 'weak',
        source: hasBehaviorEvidenceForMood ? 'played' : 'semantic',
      }
    }),
  }
}

function buildFallbackPortrait(topArtists: string[], topGenres: string[], signatureTracks: Track[]): string {
  const artists = topArtists.slice(0, 3).join('、') || '这些歌'
  const genres = topGenres.slice(0, 2).join('和') || '旋律性强的流行歌'
  const firstTrack = signatureTracks[0]
  const anchor = firstTrack ? `《${firstTrack.title}》` : '那些旋律先到、情绪后到的歌'
  return `我先从歌单里认出几个坐标: ${artists}。你可能会靠近${genres}附近的声音,旋律要顺,情绪也要能留一会儿。${anchor}暂时只是入口,等你开始点歌、收藏和跳过,我会把这些粗线条慢慢改细。`
}

function profileBehaviorEvidenceCount(profile: TasteProfile): number {
  const evidence = profile.profile_meta?.statsEvidence
  if (!evidence) return 0
  return Math.max(
    evidence.feedbackTrackCount,
    evidence.positiveEventCount,
    evidence.energyBehaviorCount,
    evidence.tempoBehaviorCount,
    evidence.sceneEventCount,
  )
}

function buildLocalPortraitFallback(profile: TasteProfile): PortraitResponse & { portrait: string } {
  const artist = profile.artists[0]?.name || profile.signature_tracks[0]?.artist || '熟悉的声音'
  const genre = profile.genres[0]?.name || '旋律舒服的歌'
  const mood = profile.moods[0]?.tag || '陪伴'
  const hasBehaviorEvidence = profileBehaviorEvidenceCount(profile) >= 3
  const portrait = hasBehaviorEvidence
    ? `我可能还没完全看清你，但最近的播放已经露出一点方向：你会靠近${artist}和${genre}这类声音，旋律要顺，情绪也要能留一会儿。${mood}像是这阵子的线索，我还想再看你会反复回到哪里，哪些歌会被你留下来。`
    : `我可能还没完全看清你。从歌单里先看见${artist}和${genre}：你像是会靠近旋律顺、情绪能停一会儿的歌。${mood}现在只能算一个线索，等你开始点歌、收藏和跳过，我还想继续认识你真实会回头听的部分，再把判断改细。`
  return {
    portrait,
    summary: `偏好线索：${artist}、${genre}、${mood}。还需要更多播放、收藏和跳过来校准。`,
    suggested_questions: [],
  }
}

function clampDiscoveryAppetite(value: number): number {
  return Math.max(0.25, Math.min(0.8, Number(value.toFixed(2))))
}

interface DiscoveryAppetiteTotals {
  plays: number
  skips: number
  loops: number
  favorites: number
  explicitLikes: number
  explicitMisses: number
  completion: number
  completionCount: number
}

function discoveryAppetiteFromTotals(totals: DiscoveryAppetiteTotals): number {
  const signalCount = totals.plays
    + totals.skips
    + totals.loops
    + totals.favorites
    + totals.explicitLikes
    + totals.explicitMisses
  if (signalCount < 8) return 0.5

  const negativeSignals = totals.skips + totals.explicitMisses
  const positiveSignals = totals.plays + totals.explicitLikes
  const skipRate = negativeSignals / Math.max(1, positiveSignals + negativeSignals)
  const strongAffinityRate = (totals.loops + totals.favorites + totals.explicitLikes) / Math.max(1, signalCount)
  const completionAvg = totals.completionCount > 0 ? totals.completion / totals.completionCount : 0.65
  const settledListeningPenalty = completionAvg >= 0.82 ? 0.04 : 0
  return clampDiscoveryAppetite(0.5 + skipRate * 0.32 - strongAffinityRate * 0.18 - settledListeningPenalty)
}

function buildDiscoveryAppetite(): number {
  const feedback = listTrackFeedback(200)
  const totals = feedback.reduce<DiscoveryAppetiteTotals>(
    (acc, item) => ({
      plays: acc.plays + item.playCount,
      skips: acc.skips + item.skipCount,
      loops: acc.loops + item.loopCount,
      favorites: acc.favorites + item.favoriteCount,
      explicitLikes: acc.explicitLikes + item.explicitLikeCount,
      explicitMisses: acc.explicitMisses + item.explicitMissCount,
      completion: acc.completion + (item.lastCompletion ?? 0),
      completionCount: acc.completionCount + (typeof item.lastCompletion === 'number' ? 1 : 0),
    }),
    { plays: 0, skips: 0, loops: 0, favorites: 0, explicitLikes: 0, explicitMisses: 0, completion: 0, completionCount: 0 },
  )
  return discoveryAppetiteFromTotals(totals)
}

function shiftDiscoveryAppetite(profile: TasteProfile, delta: number): void {
  profile.discovery_appetite = clampDiscoveryAppetite((profile.discovery_appetite ?? 0.5) + delta)
}

function buildProfileFromTracks(tracks: Track[]): TasteProfile {
  const previous = getTasteProfile()
  const context = createProfileBuildContext(tracks)
  applyProfileSignals(context)
  const totalGenre = Math.max(1, Array.from(context.genreCounts.values()).reduce((sum, value) => sum + value, 0))
  const totalMood = Math.max(1, Array.from(context.moodCounts.values()).reduce((sum, value) => sum + value, 0))
  const totalEra = Math.max(1, Array.from(context.eraCounts.values()).reduce((sum, value) => sum + value, 0))
  const topArtists = buildTopArtists(context)
  const topGenres = buildTopGenres(context, previous, totalGenre)
  const moods = buildMoodItems(context, totalMood, topArtists)
  const signatureTracks = buildSignatureTracks(context)
  const sonic = buildSonicPreferences(context)
  const statsEvidence = buildProfileStatsEvidence(context, sonic)
  const topArtistNames = topArtists.map((artist) => artist.name)
  const topGenreNames = topGenres.map((genre) => genre.name)
  const display = buildProfileDisplay(context, signatureTracks, topArtists, topGenres, moods)
  const recentInsights = buildRecentProfileInsights(
    loadProfileTrackEventsBetween(7, 0, 1200),
    loadProfileTrackEventsBetween(28, 7, 3000),
    (track) => semanticForProfile(context, track),
  )
  const profile: TasteProfile = {
    genres: topGenres,
    artists: topArtists,
    moods,
    era_preference: Object.fromEntries(Array.from(context.eraCounts.entries()).map(([era, count]) => [era, clamp(count / totalEra)])),
    discovery_appetite: buildDiscoveryAppetite(),
    anti_patterns: [] as string[],
    signature_tracks: signatureTracks,
    display,
    insights: {
      ...recentInsights,
      recentChanges: filterAcknowledgedProfileInsights(recentInsights.recentChanges, listActiveProfileInsightFeedbackIds()),
      generatedAt: new Date().toISOString(),
    },
    echo_portrait: previous?.echo_portrait ?? buildFallbackPortrait(topArtistNames, topGenreNames, signatureTracks),
    work_summary: previous?.work_summary,
    energy_preference: sonic.energy,
    tempo_preference: sonic.tempo,
    profile_meta: {
      ...(previous?.profile_meta ?? {}),
      structuredUpdatedAt: new Date().toISOString(),
      updatedAt: previous?.profile_meta?.updatedAt ?? new Date().toISOString(),
      signalCount: getFeedbackSignalCount(),
      structuredSignalRevision: previous?.profile_meta?.signalRevision ?? 0,
      statsEvidence,
    },
    scenes: buildSceneItems(context),
  }

  return profile
}

function shouldCarryPreviousSignatureTrack(track: Track, now = Date.now()): boolean {
  if (track.source === 'favorite') return false
  if (track.source !== 'chat') return true
  const recordedAt = track.recommendedAt ? new Date(track.recommendedAt).getTime() : Number.NaN
  return Number.isFinite(recordedAt) && now - recordedAt <= CHAT_SIGNATURE_MAX_AGE_MS
}

type PositiveSignalScope =
  | { kind: 'like_artist' | 'like_genre' | 'reinforce_vibe'; target: string }
  | { kind: 'like_track'; artist?: string; title: string }

type IncrementalSignal = NonNullable<NonNullable<TasteProfile['profile_meta']>['incrementalSignals']>[number]

function normalizeMemoryPattern(value: string): string {
  return value.toLowerCase().replace(/[《》“”"'‘’\s:：]/g, '')
}

function antiPatternBody(pattern: string): string {
  return pattern.replace(/^(?:跳过|不喜欢歌手|不喜欢|不爱听|少推|别推)[:：]/, '')
}

function shouldForgetAntiPattern(pattern: string, scope: PositiveSignalScope): boolean {
  const patternKey = normalizeMemoryPattern(pattern)
  const bodyKey = normalizeMemoryPattern(antiPatternBody(pattern))
  if (!patternKey || !bodyKey) return false
  if (scope.kind === 'like_track') {
    const titleKey = normalizeMemoryPattern(scope.title)
    const trackKey = normalizeMemoryPattern([scope.artist, scope.title].filter(Boolean).join(' '))
    if (!titleKey) return false
    return Boolean(bodyKey === titleKey || (trackKey && bodyKey === trackKey))
  }
  const targetKey = normalizeMemoryPattern(scope.target)
  if (!targetKey) return false
  return patternKey === targetKey || bodyKey === targetKey
}

function filterAntiPatternsForPositiveSignal(patterns: string[], scope: PositiveSignalScope): string[] {
  return patterns.filter((pattern) => !shouldForgetAntiPattern(pattern, scope))
}

function shouldKeepIncrementalSignal(signal: IncrementalSignal, now = Date.now()): boolean {
  const recordedAt = new Date(signal.updatedAt).getTime()
  if (!Number.isFinite(recordedAt)) return false
  if (recordedAt > now + 5 * 60 * 1000) return false
  return now - recordedAt <= CHAT_SIGNATURE_MAX_AGE_MS && Boolean(signal.target.trim())
}

function recordIncrementalSignal(profile: TasteProfile, signal: Omit<IncrementalSignal, 'updatedAt'>): void {
  const next: IncrementalSignal = {
    ...signal,
    updatedAt: new Date().toISOString(),
  }
  const key = (item: IncrementalSignal) => [
    item.kind,
    normalizeMemoryPattern(item.target),
    normalizeMemoryPattern(item.artist ?? ''),
    normalizeMemoryPattern(item.title ?? ''),
  ].join('::')
  const retained = (profile.profile_meta?.incrementalSignals ?? [])
    .filter(shouldKeepIncrementalSignal)
    .filter((item) => key(item) !== key(next))
  profile.profile_meta = {
    ...(profile.profile_meta ?? {}),
    incrementalSignals: [next, ...retained].slice(0, 24),
  }
}

function upsertMoodPreference(
  profile: TasteProfile,
  target: string,
  strength: number,
  options: { baseFrequency?: number; signatureArtists?: string[] } = {},
): void {
  const tag = target.trim()
  if (!tag) return
  const existing = profile.moods.find((mood) => normalizeMemoryPattern(mood.tag) === normalizeMemoryPattern(tag))
  if (existing) {
    existing.frequency = clamp(existing.frequency + Math.min(strength, 0.08))
    if (!existing.signature_artists?.length && options.signatureArtists?.length) {
      existing.signature_artists = options.signatureArtists
    }
    return
  }
  profile.moods.unshift({
    tag,
    frequency: clamp((options.baseFrequency ?? 0.5) + strength),
    signature_artists: options.signatureArtists,
  })
}

function rememberLikedTrackOnProfile(
  profile: TasteProfile,
  input: { title: string; artist?: string; strength?: number; reason?: string; updatedAt?: string },
): void {
  const title = input.title.trim()
  const artist = (input.artist ?? '').trim()
  if (!title) return
  const updatedAt = input.updatedAt ?? new Date().toISOString()
  const reason = input.reason?.trim() || '对话里有过主动喜欢的线索，先作为轻量偏好观察。'
  const existingTrack = profile.signature_tracks.find((track) => track.title === title && track.artist === artist)
  if (existingTrack) {
    existingTrack.recommendedAt = updatedAt
    if (existingTrack.source !== 'favorite') existingTrack.source = 'chat'
    if (!existingTrack.reason || hasWeakChatEvidence(existingTrack.reason)) existingTrack.reason = reason
  } else {
    profile.signature_tracks = [
      {
        title,
        artist: artist || '未知艺人',
        source: 'chat',
        recommendedAt: updatedAt,
        reason,
      },
      ...profile.signature_tracks,
    ].slice(0, 10)
  }
  if (!artist) return
  const boost = Math.min((input.strength ?? 0.08) / 2, 0.04)
  const existingArtist = profile.artists.find((item) => item.name === artist)
  if (existingArtist) {
    existingArtist.affinity = clamp(existingArtist.affinity + boost)
    if (!existingArtist.notes) existingArtist.notes = '对话里有过主动喜欢这首歌的线索。'
  } else {
    profile.artists.push({
      name: artist,
      affinity: clamp(0.44 + boost),
      notes: '对话里有过主动喜欢这首歌的线索。',
    })
  }
}

function shouldRemoveIncrementalSignal(signal: IncrementalSignal, scope: PositiveSignalScope): boolean {
  if (!shouldKeepIncrementalSignal(signal)) return true
  if (scope.kind === 'like_artist') {
    if (signal.kind === 'like_artist' && normalizeMemoryPattern(signal.target) === normalizeMemoryPattern(scope.target)) return true
    if (signal.kind === 'like_track' && normalizeMemoryPattern(signal.artist ?? '') === normalizeMemoryPattern(scope.target)) return true
  }
  if (scope.kind === 'like_genre') {
    return signal.kind === 'like_genre' && normalizeMemoryPattern(signal.target) === normalizeMemoryPattern(scope.target)
  }
  if (scope.kind === 'reinforce_vibe') {
    return signal.kind === 'reinforce_vibe' && normalizeMemoryPattern(signal.target) === normalizeMemoryPattern(scope.target)
  }
  if (scope.kind === 'like_track') {
    const signalTitle = normalizeMemoryPattern(signal.title ?? signal.target)
    const signalArtist = normalizeMemoryPattern(signal.artist ?? '')
    const title = normalizeMemoryPattern(scope.title)
    const artist = normalizeMemoryPattern(scope.artist ?? '')
    if (signal.kind !== 'like_track') return false
    if (signalTitle !== title && !signalTitle.includes(title) && !title.includes(signalTitle)) return false
    return !artist || !signalArtist || signalArtist === artist
  }
  return false
}

function removeIncrementalSignalsFor(profile: TasteProfile, scope: PositiveSignalScope): void {
  const signals = profile.profile_meta?.incrementalSignals ?? []
  if (signals.length === 0) return
  const retained = signals.filter((signal) => !shouldRemoveIncrementalSignal(signal, scope))
  profile.profile_meta = {
    ...(profile.profile_meta ?? {}),
    incrementalSignals: retained,
  }
}

function hasWeakChatEvidence(note?: string): boolean {
  return !note || /对话|主动表达|明确说过喜欢|想多听|提到喜欢|弱偏好|还在观察/.test(note)
}

function isWeakPositiveDisplayItem(item: { source: ProfileEvidenceSource; note?: string; track?: Track }): boolean {
  return item.source === 'explicit_like' && hasWeakChatEvidence(item.note ?? item.track?.reason)
}

function cleanupWeakPositiveDisplayEvidence(profile: TasteProfile, scope: PositiveSignalScope): void {
  const display = profile.display
  if (!display) return
  if (scope.kind === 'like_artist') {
    const target = normalizeMemoryPattern(scope.target)
    display.artistItems = display.artistItems.filter((item) => (
      normalizeMemoryPattern(item.name) !== target || !isWeakPositiveDisplayItem(item)
    ))
    display.signatureItems = display.signatureItems.filter((item) => (
      normalizeMemoryPattern(item.track.artist) !== target || !isWeakPositiveDisplayItem(item)
    ))
  }
  if (scope.kind === 'like_genre') {
    const target = normalizeMemoryPattern(scope.target)
    display.genreItems = display.genreItems.filter((item) => (
      normalizeMemoryPattern(item.name) !== target || !isWeakPositiveDisplayItem(item)
    ))
  }
  if (scope.kind === 'reinforce_vibe') {
    const target = normalizeMemoryPattern(scope.target)
    display.moodItems = display.moodItems.filter((item) => (
      normalizeMemoryPattern(item.tag) !== target || item.source !== 'explicit_like'
    ))
  }
  if (scope.kind === 'like_track') {
    const title = normalizeMemoryPattern(scope.title)
    const artist = normalizeMemoryPattern(scope.artist ?? '')
    display.signatureItems = display.signatureItems.filter((item) => {
      const sameTitle = normalizeMemoryPattern(item.track.title) === title
      const sameArtist = !artist || normalizeMemoryPattern(item.track.artist) === artist
      return !(sameTitle && sameArtist && isWeakPositiveDisplayItem(item))
    })
  }
}

function removeWeakPositiveProfileEvidence(profile: TasteProfile, scope: PositiveSignalScope): void {
  cleanupWeakPositiveDisplayEvidence(profile, scope)
  if (scope.kind === 'like_artist') {
    const target = normalizeMemoryPattern(scope.target)
    profile.artists = profile.artists.filter((artist) => (
      normalizeMemoryPattern(artist.name) !== target
      || (!hasWeakChatEvidence(artist.notes) && artist.affinity > 0.5)
    ))
    profile.signature_tracks = profile.signature_tracks.filter((track) => (
      normalizeMemoryPattern(track.artist) !== target
      || track.source !== 'chat'
    ))
  }
  if (scope.kind === 'like_genre') {
    const target = normalizeMemoryPattern(scope.target)
    profile.genres = profile.genres.filter((genre) => (
      normalizeMemoryPattern(genre.name) !== target
      || (!hasWeakChatEvidence(genre.note) && genre.weight > 0.5)
    ))
  }
  if (scope.kind === 'reinforce_vibe') {
    const target = normalizeMemoryPattern(scope.target)
    profile.moods = profile.moods.filter((mood) => normalizeMemoryPattern(mood.tag) !== target || mood.frequency > 0.62)
  }
  if (scope.kind === 'like_track') {
    const title = normalizeMemoryPattern(scope.title)
    const artist = normalizeMemoryPattern(scope.artist ?? '')
    profile.signature_tracks = profile.signature_tracks.filter((track) => {
      const sameTitle = normalizeMemoryPattern(track.title) === title
      const sameArtist = !artist || normalizeMemoryPattern(track.artist) === artist
      return !(sameTitle && sameArtist && track.source === 'chat')
    })
  }
}

function downgradeStaleFavoriteDisplay(profile: TasteProfile, artist: string): void {
  const display = profile.display
  if (!display || !artist) return
  const normalizedArtist = normalizeMemoryPattern(artist)
  const hasRemainingFavoriteTrack = profile.signature_tracks.some((track) => (
    track.source === 'favorite' && normalizeMemoryPattern(track.artist) === normalizedArtist
  ))
  if (hasRemainingFavoriteTrack) return
  display.artistItems = display.artistItems.map((item) => {
    if (normalizeMemoryPattern(item.name) !== normalizedArtist || item.source !== 'favorite') return item
    return {
      ...item,
      note: '取消收藏后继续校准。',
      evidenceLevel: 'weak',
      source: 'fallback',
    }
  })
}

function applyIncrementalSignals(rebuilt: TasteProfile, previous: TasteProfile | null, now = Date.now()): void {
  const previousSignals = previous?.profile_meta?.incrementalSignals ?? []
  const signals = previousSignals.filter((signal) => shouldKeepIncrementalSignal(signal, now))
  if (previousSignals.length > 0) {
    rebuilt.profile_meta = {
      ...(rebuilt.profile_meta ?? {}),
      incrementalSignals: signals,
    }
  }
  if (signals.length === 0) return
  for (const signal of signals) {
    const strength = clamp(signal.strength ?? 0.08)
    if (signal.kind === 'like_artist') {
      const existing = rebuilt.artists.find((artist) => artist.name === signal.target)
      if (existing) {
        existing.affinity = clamp(existing.affinity + Math.min(strength, 0.08))
        if (!existing.notes) existing.notes = '对话里有过主动喜欢的线索。'
      } else {
        rebuilt.artists.push({ name: signal.target, affinity: clamp(0.46 + strength), notes: '对话里有过主动喜欢的线索。' })
      }
    }
    if (signal.kind === 'like_genre') {
      const existing = rebuilt.genres.find((genre) => genre.name === signal.target)
      if (existing) {
        existing.weight = clamp(existing.weight + Math.min(strength, 0.08))
        existing.trend = 'up'
      } else {
        rebuilt.genres.push({ name: signal.target, weight: clamp(0.3 + strength), trend: 'up', note: '对话里出现过想多听的线索。' })
      }
    }
    if (signal.kind === 'soften_genre') {
      const existing = rebuilt.genres.find((genre) => genre.name === signal.target)
      if (existing) {
        existing.weight = clamp(existing.weight - Math.max(0.02, strength / 2))
        existing.trend = 'down'
      }
    }
    if (signal.kind === 'reinforce_vibe') {
      upsertMoodPreference(rebuilt, signal.target, strength, {
        baseFrequency: 0.32,
        signatureArtists: rebuilt.artists.slice(0, 3).map((artist) => artist.name),
      })
    }
    if (signal.kind === 'soften_vibe') {
      const existing = rebuilt.moods.find((mood) => mood.tag === signal.target)
      if (existing) existing.frequency = clamp(existing.frequency - Math.max(0.02, strength / 2))
    }
    if (signal.kind === 'raise_energy' || signal.kind === 'lower_energy') {
      const direction = signal.kind === 'raise_energy' ? 1 : -1
      rebuilt.energy_preference = clamp((rebuilt.energy_preference ?? 0.5) + direction * strength)
    }
    if (signal.kind === 'reinforce_scene' || signal.kind === 'soften_scene') {
      const direction = signal.kind === 'reinforce_scene' ? 1 : -1
      const scenes = rebuilt.scenes ?? []
      const existing = scenes.find((scene) => scene.tag === signal.target)
      if (existing) existing.frequency = clamp(existing.frequency + direction * strength)
      else if (direction > 0) scenes.unshift({ tag: signal.target, frequency: clamp(0.35 + strength) })
      rebuilt.scenes = scenes.filter((scene) => scene.frequency > 0).slice(0, 8)
    }
    if (signal.kind === 'like_track' && signal.title) {
      rememberLikedTrackOnProfile(rebuilt, {
        title: signal.title,
        artist: signal.artist,
        strength,
        updatedAt: signal.updatedAt,
      })
    }
  }
  rebuilt.artists = rebuilt.artists.sort((a, b) => b.affinity - a.affinity).slice(0, 12)
  rebuilt.genres = rebuilt.genres.sort((a, b) => b.weight - a.weight).slice(0, 12)
  rebuilt.moods = rebuilt.moods.sort((a, b) => b.frequency - a.frequency).slice(0, 10)
  rebuilt.signature_tracks = rebuilt.signature_tracks.slice(0, 10)
  rebuilt.profile_meta = {
    ...(rebuilt.profile_meta ?? {}),
    incrementalSignals: signals,
  }
}

function evidenceFromNote(note?: string): EvidenceNote {
  if (hasLegacyProfileNote(note)) return { text: '来自导入歌单的稳定坐标。', evidenceLevel: 'weak', source: 'imported' }
  if (!note) return { text: '还在观察', evidenceLevel: 'weak', source: 'fallback' }
  if (isWeakChatEvidenceNote(note)) return { text: note, evidenceLevel: 'medium', source: 'explicit_like' }
  if (note.includes('收藏')) return { text: note, evidenceLevel: 'strong', source: 'favorite' }
  if (note.includes('循环')) return { text: note, evidenceLevel: 'strong', source: 'loop' }
  if (note.includes('想多听') || note.includes('明确说过喜欢') || note.includes('主动喜欢') || note.includes('轻量偏好')) return { text: note, evidenceLevel: 'strong', source: 'explicit_like' }
  if (note.includes('不太合适') || note.includes('不合适')) return { text: note, evidenceLevel: 'medium', source: 'explicit_miss' }
  if (note.includes('完整听过') || note.includes('播放') || note.includes('跳过')) return { text: note, evidenceLevel: 'strong', source: 'played' }
  if (note.includes('场景') || note.includes('时常')) return { text: note, evidenceLevel: 'strong', source: 'scene' }
  if (note.includes('导入')) return { text: note, evidenceLevel: 'weak', source: 'imported' }
  if (note.includes('线索')) return { text: note, evidenceLevel: 'medium', source: 'semantic' }
  return { text: note, evidenceLevel: 'weak', source: 'fallback' }
}

function isWeakChatEvidenceNote(note?: string): boolean {
  return Boolean(note && /对话|提到喜欢|主动喜欢|想多听|轻量偏好|弱偏好/.test(note))
}

function buildFallbackDisplay(profile: TasteProfile): ProfileDisplayModel {
  const reinforcedVibes = new Set(
    (profile.profile_meta?.incrementalSignals ?? [])
      .filter((signal) => signal.kind === 'reinforce_vibe' && shouldKeepIncrementalSignal(signal))
      .map((signal) => normalizeMemoryPattern(signal.target)),
  )
  return {
    signatureItems: profile.signature_tracks.slice(0, 7).flatMap((track) => {
      const evidence = evidenceFromNote(track.reason)
      if (evidence.source === 'explicit_miss') return []
      return {
        track: { ...track, reason: evidence.text },
        note: evidence.text,
        evidenceLevel: evidence.evidenceLevel,
        source: evidence.source,
      }
    }),
    genreItems: profile.genres.map((genre) => {
      if (genre.note) {
        const evidence = evidenceFromNote(genre.note)
        return {
          name: genre.name,
          weight: genre.weight,
          trend: genre.trend,
          representativeArtists: [],
          note: evidence.text,
          evidenceLevel: evidence.evidenceLevel,
          source: evidence.source,
        }
      }
      const evidence = genreNote(genre.name, genre.weight, genre.trend, [])
      return {
        name: genre.name,
        weight: genre.weight,
        trend: genre.trend,
        representativeArtists: [],
        note: evidence.note,
        evidenceLevel: evidence.evidenceLevel,
        source: evidence.source,
      }
    }),
    artistItems: profile.artists.map((artist) => {
      const evidence = evidenceFromNote(artist.notes)
      return {
        name: artist.name,
        affinity: artist.affinity,
        note: evidence.text,
        evidenceLevel: evidence.evidenceLevel,
        source: evidence.source,
      }
    }),
    moodItems: profile.moods.slice(0, 6).map((mood) => {
      const reinforced = reinforcedVibes.has(normalizeMemoryPattern(mood.tag))
      return {
        tag: mood.tag,
        frequency: mood.frequency,
        evidenceLevel: reinforced || mood.frequency >= 0.18 ? 'medium' : 'weak',
        source: reinforced ? 'explicit_like' : 'semantic',
      }
    }),
  }
}

const evidenceLevelRank: Record<ProfileEvidenceLevel, number> = {
  weak: 1,
  medium: 2,
  strong: 3,
}

function strongerEvidenceLevel(current: ProfileEvidenceLevel, previous?: ProfileEvidenceLevel): ProfileEvidenceLevel {
  if (!previous) return current
  return evidenceLevelRank[previous] > evidenceLevelRank[current] ? previous : current
}

function mergedEvidenceLevel(
  current: ProfileEvidenceLevel,
  previous: ProfileEvidenceLevel | undefined,
  currentSource: ProfileEvidenceSource,
): ProfileEvidenceLevel {
  if (currentSource === 'explicit_miss') return current
  return strongerEvidenceLevel(current, previous)
}

function effectiveEvidenceLevel(level: ProfileEvidenceLevel, note?: string): ProfileEvidenceLevel {
  if (level === 'strong' && isWeakChatEvidenceNote(note)) return 'medium'
  return level
}

function betterEvidenceSource(current: ProfileEvidenceSource, previous?: ProfileEvidenceSource): ProfileEvidenceSource {
  if (!previous) return current
  if (current === 'explicit_miss') return current
  return evidenceSourceRank(previous) > evidenceSourceRank(current) ? previous : current
}

function evidenceSourceRank(source: ProfileEvidenceSource): number {
  switch (source) {
    case 'favorite':
      return 7
    case 'loop':
    case 'explicit_like':
      return 6
    case 'explicit_miss':
      return 5
    case 'played':
    case 'scene':
      return 4
    case 'semantic':
      return 2
    case 'imported':
      return 1
    case 'fallback':
    default:
      return 0
  }
}

function betterEvidenceNote(
  current: string | undefined,
  currentLevel: ProfileEvidenceLevel,
  currentSource: ProfileEvidenceSource,
  previous?: string,
  previousLevel?: ProfileEvidenceLevel,
  previousSource?: ProfileEvidenceSource,
): string | undefined {
  if (!previous) return current
  if (!current) return previous
  if (currentSource === 'explicit_miss') return current
  if (previousSource && evidenceSourceRank(previousSource) > evidenceSourceRank(currentSource)) return previous
  if (previousLevel && evidenceLevelRank[previousLevel] > evidenceLevelRank[currentLevel]) return previous
  return current
}

function mergeProfileDisplay(profile: TasteProfile, previous?: ProfileDisplayModel): ProfileDisplayModel {
  const fallback = buildFallbackDisplay(profile)
  if (!previous) return fallback

  const previousSignatures = new Map(previous.signatureItems.map((item) => [trackKey(item.track), item]))
  const previousGenres = new Map(previous.genreItems.map((item) => [item.name, item]))
  const previousArtists = new Map(previous.artistItems.map((item) => [item.name, item]))
  const previousMoods = new Map(previous.moodItems.map((item) => [item.tag, item]))

  return {
    signatureItems: fallback.signatureItems.map((item) => {
      const previousItem = previousSignatures.get(trackKey(item.track))
      if (!previousItem) return item
      const currentLevel = effectiveEvidenceLevel(item.evidenceLevel, item.note ?? item.track.reason)
      const previousLevel = effectiveEvidenceLevel(previousItem.evidenceLevel, previousItem.note ?? previousItem.track.reason)
      const evidenceLevel = mergedEvidenceLevel(currentLevel, previousLevel, item.source)
      return {
        ...item,
        track: {
          ...previousItem.track,
          ...item.track,
          reason: betterEvidenceNote(item.track.reason, currentLevel, item.source, previousItem.track.reason, previousLevel, previousItem.source),
        },
        note: betterEvidenceNote(item.note, currentLevel, item.source, previousItem.note, previousLevel, previousItem.source),
        count: item.count ?? previousItem.count,
        evidenceLevel,
        source: betterEvidenceSource(item.source, previousItem.source),
      }
    }),
    genreItems: fallback.genreItems.map((item) => {
      const previousItem = previousGenres.get(item.name)
      if (!previousItem) return item
      const currentLevel = effectiveEvidenceLevel(item.evidenceLevel, item.note)
      const previousLevel = effectiveEvidenceLevel(previousItem.evidenceLevel, previousItem.note)
      const evidenceLevel = mergedEvidenceLevel(currentLevel, previousLevel, item.source)
      return {
        ...item,
        representativeArtists: item.representativeArtists.length ? item.representativeArtists : previousItem.representativeArtists,
        note: betterEvidenceNote(item.note, currentLevel, item.source, previousItem.note, previousLevel, previousItem.source),
        evidenceLevel,
        source: betterEvidenceSource(item.source, previousItem.source),
      }
    }),
    artistItems: fallback.artistItems.map((item) => {
      const previousItem = previousArtists.get(item.name)
      if (!previousItem) return item
      const currentLevel = effectiveEvidenceLevel(item.evidenceLevel, item.note)
      const previousLevel = effectiveEvidenceLevel(previousItem.evidenceLevel, previousItem.note)
      const evidenceLevel = mergedEvidenceLevel(currentLevel, previousLevel, item.source)
      return {
        ...item,
        note: betterEvidenceNote(item.note, currentLevel, item.source, previousItem.note, previousLevel, previousItem.source),
        evidenceLevel,
        source: betterEvidenceSource(item.source, previousItem.source),
      }
    }),
    moodItems: fallback.moodItems.map((item) => {
      const previousItem = previousMoods.get(item.tag)
      if (!previousItem) return item
      const evidenceLevel = strongerEvidenceLevel(item.evidenceLevel, previousItem.evidenceLevel)
      return {
        ...item,
        evidenceLevel,
        source: betterEvidenceSource(item.source, previousItem.source),
      }
    }),
  }
}

function ensureProfileDisplay(profile: TasteProfile | null): TasteProfile | null {
  if (!profile) return null
  const display = profile.display
  const hasLegacyDisplayNote = Boolean(display?.signatureItems.some((item) => hasLegacyProfileNote(item.note ?? item.track.reason)) || display?.artistItems.some((item) => hasLegacyProfileNote(item.note)))
  if (display?.signatureItems && display.genreItems && display.artistItems && display.moodItems && !hasLegacyDisplayNote) {
    return { ...profile, display: mergeProfileDisplay(profile, display) }
  }
  return { ...profile, display: buildFallbackDisplay(profile) }
}

function extractJsonObjectCandidates(text: string): string[] {
  const candidates = new Set<string>()
  const trimmed = text.trim()
  if (trimmed.startsWith('{') && trimmed.endsWith('}')) candidates.add(trimmed)

  const fencePattern = /```(?:json)?\s*([\s\S]*?)```/gi
  let fenceMatch: RegExpExecArray | null
  while ((fenceMatch = fencePattern.exec(text))) {
    const block = fenceMatch[1]?.trim()
    if (block?.startsWith('{') && block.endsWith('}')) candidates.add(block)
  }

  let start = -1
  let depth = 0
  let inString = false
  let escaped = false
  for (let index = 0; index < text.length; index += 1) {
    const char = text[index]
    if (start < 0) {
      if (char === '{') {
        start = index
        depth = 1
        inString = false
        escaped = false
      }
      continue
    }

    if (inString) {
      if (escaped) {
        escaped = false
      } else if (char === '\\') {
        escaped = true
      } else if (char === '"') {
        inString = false
      }
      continue
    }

    if (char === '"') {
      inString = true
    } else if (char === '{') {
      depth += 1
    } else if (char === '}') {
      depth -= 1
      if (depth === 0) {
        candidates.add(text.slice(start, index + 1))
        start = -1
      }
    }
  }

  return Array.from(candidates).sort((a, b) => a.length - b.length)
}

function parseJsonObjects<T>(text: string): T[] {
  const parsed: T[] = []
  for (const candidate of extractJsonObjectCandidates(text)) {
    try {
      parsed.push(JSON.parse(candidate) as T)
    } catch {
      // Try the next candidate.
    }
  }
  return parsed
}

function asPlainObject(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null
}

function firstStringField(record: Record<string, unknown>, keys: string[]): string | undefined {
  for (const key of keys) {
    const value = record[key]
    if (typeof value === 'string' && value.trim()) return value.trim()
  }
  return undefined
}

function normalizeSuggestedQuestions(value: unknown): PortraitResponse['suggested_questions'] {
  if (!Array.isArray(value)) return []
  const questions: NonNullable<PortraitResponse['suggested_questions']> = []
  for (const item of value.slice(0, 4)) {
    if (typeof item === 'string') {
      const content = item.trim()
      if (content) questions.push({ kind: 'curiosity', content, context: {} })
      continue
    }
    const record = asPlainObject(item)
    if (!record) continue
    const content = firstStringField(record, ['content', 'question', '问题'])
    if (!content) continue
    questions.push({
      kind: firstStringField(record, ['kind', 'type', '类型']) ?? 'curiosity',
      content,
      context: asPlainObject(record.context) ?? {},
    })
  }
  return questions
}

function stripLlmScaffolding(text: string): string {
  return text
    .replace(/```(?:json)?/gi, '')
    .replace(/```/g, '')
    .replace(/^\s*(portrait|画像|画像文案|echo_portrait)\s*[:：]\s*/i, '')
    .trim()
}

function parsePortraitResponse(text: string): PortraitResponse | null {
  const parsedCandidates = parseJsonObjects<Record<string, unknown>>(text)
  for (const parsed of parsedCandidates) {
    const portrait = firstStringField(parsed, ['portrait', 'echo_portrait', 'profile', '画像', '画像文案'])
    if (portrait) {
      return {
        portrait,
        summary: firstStringField(parsed, ['summary', 'work_summary', '备忘', '摘要']),
        suggested_questions: normalizeSuggestedQuestions(parsed.suggested_questions ?? parsed.questions ?? parsed['问题']),
      }
    }
  }

  const plain = stripLlmScaffolding(text)
  const compactLength = Array.from(plain.replace(/\s+/g, '')).length
  if (/你/.test(plain) && compactLength >= 70 && compactLength <= 180) {
    return {
      portrait: plain,
      summary: plain.slice(0, 150),
      suggested_questions: [],
    }
  }
  return null
}

function readPortraitPrompt(): string {
  const latest = readRootFile('prompts/portrait-writer-v2.md') || readRootFile('prompts/portrait-writer.md')
  const systemStart = latest.indexOf('## System')
  const fewShotStart = latest.indexOf('\n## Few-shot')
  const userStartMatch = latest.match(/\n## User[（(]/)
  const start = systemStart >= 0 ? systemStart : 0
  const possibleEnds = [fewShotStart, userStartMatch?.index ?? -1].filter((index) => index > start)
  const end = possibleEnds.length ? Math.min(...possibleEnds) : latest.length
  return latest.slice(start, end).trim()
}

function compactLine(text: string, limit = 180): string {
  const normalized = text.replace(/\s+/g, ' ').trim()
  return normalized.length > limit ? `${normalized.slice(0, limit)}...` : normalized
}

function normalizeEvidenceText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, '').replace(/[《》"'“”·.,，。!！?？()（）\-–—]/g, '')
}

function topCountLabels(items: string[], limit: number): string {
  const entries = topEntries(countBy(items.filter(Boolean)), limit)
  return entries.length ? entries.map(([name, count]) => `${name}(${count})`).join('、') : '暂无'
}

const MUSIC_INTENT_TEXT_PATTERN = /歌|音乐|听|推荐|来一首|换一首|播放|放一首|找一首|分享|歌单|曲子|旋律|节奏|摇滚|民谣|说唱|电子|爵士|r&b|rb|粤语|英文|英语|韩语|日语|华语|激情|激昂|热血|澎湃|清醒|提神|安静|舒缓|放松/i
const USER_STATE_TEXT_PATTERN = /困|累|睡|失眠|疲惫|倦|冷|烦|烦躁|压力|焦虑|崩|麻|难受|低落|心情|开心|高兴|轻松|伤心|难过|孤独|emo|想哭/i

const GENRE_INTENT_PATTERNS: Array<[RegExp, string]> = [
  [/摇滚|rock/i, '偏摇滚'],
  [/民谣|folk/i, '偏民谣'],
  [/说唱|rap|hip\s*hop/i, '偏说唱'],
  [/电子|edm|techno|house/i, '偏电子'],
  [/爵士|jazz/i, '偏爵士'],
  [/r&b|rb|节奏布鲁斯/i, '偏 R&B'],
  [/古典|classical/i, '偏古典'],
  [/粤语|广东/i, '偏粤语'],
  [/英文|英语|欧美|english/i, '偏英文'],
  [/韩语|韩国|韩文|kpop|k-pop/i, '偏韩语'],
  [/日语|日本|日文|jpop|j-pop/i, '偏日语'],
]

function uniqueStrings(items: string[]): string[] {
  return Array.from(new Set(items.filter(Boolean)))
}

function isPortraitIntentEvidenceText(text: string): boolean {
  return MUSIC_INTENT_TEXT_PATTERN.test(text) || USER_STATE_TEXT_PATTERN.test(text)
}

function trendLevel(count: number): string {
  if (count >= 3) return '主要'
  if (count === 2) return '反复出现'
  return '偶尔出现'
}

function collectMusicIntentLabels(intent: RecommendationIntent, text: string): string[] {
  const labels: string[] = []
  if (intent.energy === 'high' || intent.tempo === 'fast' || intent.moods.some((mood) => /清醒|热烈|轻快/.test(mood))) {
    labels.push('想把状态提起来')
  }
  if (intent.energy === 'low' || intent.tempo === 'slow' || intent.moods.some((mood) => /放松|松弛|治愈/.test(mood))) {
    labels.push('想放慢一点')
  }
  if (/烦|烦躁|压力|焦虑|崩|麻|难受/.test(text)) {
    labels.push('在杂乱或压力里找出口')
  }
  if (/累|疲惫|倦|困|睡|失眠/.test(text)) {
    labels.push('需要休息和放慢')
  }
  if (/开心|高兴|轻松|心情不错|状态不错/.test(text)) {
    labels.push('状态更轻快')
  }
  if (/伤心|难过|孤独|emo|想哭|失眠|陪我|陪伴|有点冷/.test(text) || intent.moods.some((mood) => /孤独/.test(mood))) {
    labels.push('在情绪低处找陪伴')
  }
  if (/不好听|不对|换一首|别放|不要这首|不喜欢/.test(text)) {
    labels.push('会主动修正不合适的歌')
  }
  if (intent.familiarity === 'safe') labels.push('会回到熟悉声音')
  if (intent.familiarity === 'explore') labels.push('愿意试新声音')
  for (const scene of intent.scenes.slice(0, 2)) labels.push(`${scene}场景`)
  if (intent.language) labels.push(`偏${intent.language}`)
  for (const [pattern, label] of GENRE_INTENT_PATTERNS) {
    if (pattern.test(text)) labels.push(label)
  }
  return uniqueStrings(labels).slice(0, 5)
}

function summarizeMusicIntentMessages(messages: ReturnType<typeof loadRecentConversations>): { total: number; labels: string[] } {
  const counts = new Map<string, number>()
  for (const message of messages) {
    if (message.role !== 'user') continue
    const text = message.content.trim()
    if (!text || !isPortraitIntentEvidenceText(text)) continue
    const labels = collectMusicIntentLabels(parseIntent(text, { inferEntities: false }), text)
    if (labels.length === 0) continue
    for (const label of labels) counts.set(label, (counts.get(label) ?? 0) + 1)
  }
  const labels = Array.from(counts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([label, count]) => `${trendLevel(count)}：${label}`)
  const total = Array.from(counts.values()).reduce((sum, count) => sum + count, 0)
  return { total, labels }
}

function formatPortraitIntentTrend(today: { total: number; labels: string[] }, recent: { total: number; labels: string[] }): string {
  if (today.total === 0 && recent.total === 0) {
    return [
      '近期情绪/找歌线索不足,画像以播放、收藏、切歌和长期偏好为主。',
      '写 portrait 时可以坦诚还在观察,避免写成稳定结论。',
    ].join('\n')
  }
  return [
    `今日情绪/找歌线索: ${today.labels.join('、') || '暂无明显方向'}`,
    `近期情绪/找歌线索: ${recent.labels.join('、') || '暂无明显方向'}`,
    '这些趋势来自用户原话、情绪表达和推荐意图解析,已转成结构化证据。写 portrait 时用人的状态和变化来表达,避免直接写次数、占比、标签名。',
  ].join('\n')
}

function buildRecentMusicIntentTrend(): string {
  const today = summarizeMusicIntentMessages(loadTodayConversations(80))
  const recent = summarizeMusicIntentMessages(loadRecentConversations(160))
  return formatPortraitIntentTrend(today, recent)
}

function trackLabel(track: Track): string {
  return `《${track.title}》-${track.artist}`
}

function formatPortraitFeedbackEvidence(item: TrackFeedback): string {
  const parts: string[] = []
  if (item.playCount > 0) parts.push(`完整听过 ${item.playCount} 次`)
  if (item.skipCount > 0) parts.push(`跳过 ${item.skipCount} 次`)
  if (item.loopCount > 0) parts.push(`循环 ${item.loopCount} 次`)
  if (item.favoriteCount > 0) parts.push(`收藏 ${item.favoriteCount} 次`)
  if (item.explicitLikeCount > 0) parts.push(`明确喜欢 ${item.explicitLikeCount} 次`)
  if (item.explicitMissCount > 0) parts.push(`明确不合适 ${item.explicitMissCount} 次`)
  return `${trackLabel(item.track)}(${parts.join('、') || '有过接触'})`
}

function semanticForWindowTrack(track: Track, semanticByKey: Map<string, TrackSemantic>): TrackSemantic {
  return semanticByKey.get(trackKey(track)) ?? track.semantic ?? inferTrackSemanticFallback(track)
}

function buildEventWindowSignals(events: ProfileTrackEvent[], semanticByKey: Map<string, TrackSemantic>): {
  artists: string[]
  genres: string[]
  moods: string[]
  tracks: Track[]
  completed: number
  skipped: number
} {
  const artists: string[] = []
  const genres: string[] = []
  const moods: string[] = []
  let completed = 0
  let skipped = 0
  for (const event of events) {
    if (event.queueStatus === 'completed') completed += 1
    if (event.queueStatus === 'skipped') skipped += 1
    if (!isPositiveProfileEvent(event)) continue
    artists.push(event.track.artist)
    const semantic = semanticForWindowTrack(event.track, semanticByKey)
    genres.push(...semantic.genres.map((genre) => normalizedGenre(genre, semantic.language)))
    moods.push(...semantic.moods)
  }
  return { artists, genres, moods, tracks: events.filter(isPositiveProfileEvent).map((event) => event.track), completed, skipped }
}

function buildRelationshipContextText(firstUsedAt: string, yinyiCount: number, hasWrittenPortrait: boolean, now = Date.now()): string {
  const date = new Date(firstUsedAt)
  if (Number.isNaN(date.getTime())) return '(首次使用时间未知)'
  const days = Math.max(1, Math.ceil((now - date.getTime()) / 86400000))
  if (days <= 3) {
    return hasWrittenPortrait
      ? `你刚认识用户 — 才第 ${days} 天。已经写过一版画像,这次要保留"还在观察"的分寸。`
      : `你刚认识用户 — 才第 ${days} 天。这是第一次写画像,坦诚"我只看到了粗线条"。`
  }
  if (days <= 14) return `你认识用户 ${days} 天了,${hasWrittenPortrait ? '至少写过一版' : '还没写过'}画像。还处在"慢慢认识"的阶段。`
  if (days <= 60) return `你们已经相处 ${days} 天,${yinyiCount > 0 ? `写过 ${yinyiCount} 篇风信` : '还在熟悉中'}。你应该开始看到一些稳定的模式了。`
  return `你已经陪用户 ${days} 天了,${yinyiCount > 0 ? `${yinyiCount} 篇风信` : ''}。你看着用户的口味在变,应该有能力写出有分量的观察。`
}

function hasWrittenPortrait(profile: TasteProfile): boolean {
  return Boolean(
    profile.profile_meta?.portraitUpdatedAt
    || typeof profile.profile_meta?.portraitSignalCount === 'number',
  )
}

function buildRelationshipContext(profile: TasteProfile): string {
  const settings = getSettings()
  return buildRelationshipContextText(settings.meta.firstUsedAt, getYinyiRange(500).length, hasWrittenPortrait(profile))
}

function buildMusicRoleSummary(): string {
  const feedback = listTrackFeedback(200)
  if (feedback.length < 3) return '(行为数据还太少,无法判断音乐角色)'
  const totalPlays = feedback.reduce((sum, item) => sum + item.playCount, 0)
  const totalSkips = feedback.reduce((sum, item) => sum + item.skipCount, 0)
  const totalLoops = feedback.reduce((sum, item) => sum + item.loopCount, 0)
  const totalFavorites = feedback.reduce((sum, item) => sum + item.favoriteCount, 0)
  const explicitLikes = feedback.reduce((sum, item) => sum + item.explicitLikeCount, 0)
  const explicitMisses = feedback.reduce((sum, item) => sum + item.explicitMissCount, 0)
  const positiveSignals = totalPlays + explicitLikes
  const negativeSignals = totalSkips + explicitMisses
  const totalEncounters = positiveSignals + negativeSignals
  const skipRate = totalEncounters > 0 ? negativeSignals / totalEncounters : 0
  const loopRate = totalPlays > 0 ? totalLoops / totalPlays : 0
  const favoriteRate = positiveSignals > 0 ? (totalFavorites + explicitLikes) / positiveSignals : 0
  const events = loadProfileTrackEvents(200)
  const nightEvents = events.filter((event) => {
    const hour = new Date(event.listenedAt).getHours()
    return hour >= 22 || hour < 5
  })
  const nightRatio = events.length > 0 ? nightEvents.length / events.length : 0

  const signals: string[] = []
  if (skipRate > 0.35) signals.push('切歌和修正偏多,总在找"对的那首"')
  if (loopRate > 0.15) signals.push('循环行为明显,会回到同一首歌')
  if (nightRatio > 0.45) signals.push('深夜听歌更集中')
  if (favoriteRate > 0.2) signals.push('喜欢标记比较主动')
  if (signals.length === 0) signals.push('播放行为比较均匀,没有极端的倾向')

  if (skipRate > 0.35 && loopRate > 0.15) return signals.join('; ') + '。音乐对用户来说既是挑剔的陪伴,也是会反复确认的熟悉声音。'
  if (skipRate > 0.35) return signals.join('; ') + '。音乐对用户来说是挑剔的陪伴——总在找刚好对的那首。'
  if (loopRate > 0.15) return signals.join('; ') + '。用户会回到同一首歌,像回到一个熟悉的地方。'
  if (nightRatio > 0.45) return signals.join('; ') + '。用户用音乐消化深夜的情绪。'
  return signals.join('; ') + '。'
}

const LOW_MOOD_SIGNALS = ['sad', 'melancholic', '忧郁', '伤感', '孤独', '失眠', '疲惫', '沉思', '怀旧', '孤独感']
const HIGH_MOOD_SIGNALS = ['energetic', 'upbeat', '欢快', '激昂', '热血', '有劲', '活力', '振奋', '阳光', '嗨']
const CALM_MOOD_SIGNALS = ['calm', 'relaxing', '舒缓', '放松', '治愈', '温柔', '轻柔', '安静', '平静', '冥想']
const CONTEXT_EVENT_TTL_HOURS = 6

function moodDirection(mood: string): 'low' | 'high' | 'calm' | 'neutral' {
  const tag = mood.toLowerCase()
  if (LOW_MOOD_SIGNALS.some((signal) => tag.includes(signal))) return 'low'
  if (HIGH_MOOD_SIGNALS.some((signal) => tag.includes(signal))) return 'high'
  if (CALM_MOOD_SIGNALS.some((signal) => tag.includes(signal))) return 'calm'
  return 'neutral'
}

function buildMoodTrendSignal(profile: TasteProfile, semanticByKey: Map<string, TrackSemantic>, semanticCount: number): string {
  const events = loadProfileTrackEvents(100)
  if (events.length < 3 && semanticCount < 5) return '(情绪信号还太少)'

  const recentCutoff = Date.now() - 7 * 86400000
  const recentEvents = events.filter((event) => new Date(event.listenedAt).getTime() > recentCutoff)

  const recentMoods: string[] = []
  let recentEnergy = 0
  let recentEnergyCount = 0

  for (const event of recentEvents) {
    if (!isPositiveProfileEvent(event)) continue
    const key = semanticTrackKey(event.track)
    const semantic = semanticByKey.get(key) ?? event.track.semantic
    if (semantic) {
      recentMoods.push(...semantic.moods)
      if (semantic.energy > 0) {
        recentEnergy += semantic.energy
        recentEnergyCount += 1
      }
    }
  }

  if (recentMoods.length < 3 && recentEnergyCount < 3) {
    if (semanticCount >= 5) return `(有 ${semanticCount} 首歌的语义数据,但近一周播放记录不足,情绪趋势判断受限)`
    return '(近一周情绪信号不足)'
  }

  const moodCounts = new Map<string, number>()
  for (const mood of recentMoods) moodCounts.set(mood, (moodCounts.get(mood) ?? 0) + 1)
  const topMoods = Array.from(moodCounts.entries()).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([tag]) => tag)

  let lowCount = 0
  let highCount = 0
  let calmCount = 0
  for (const [mood, count] of moodCounts) {
    const dir = moodDirection(mood)
    if (dir === 'low') lowCount += count
    if (dir === 'high') highCount += count
    if (dir === 'calm') calmCount += count
  }
  const total = lowCount + highCount + calmCount || 1
  const avgEnergy = recentEnergyCount > 0 ? recentEnergy / recentEnergyCount : 0.5
  const baseEnergy = profile.energy_preference ?? 0.5

  const lines: string[] = []
  lines.push(`近一周高频 mood: ${topMoods.join('、') || '无明确标签'}`)

  if (lowCount / total > 0.45) {
    lines.push('情绪色调偏低落')
    if (baseEnergy > 0.4 && avgEnergy < baseEnergy - 0.1) lines.push('能量明显比平时低')
  } else if (highCount / total > 0.4) {
    lines.push('情绪色调偏高涨')
  } else if (calmCount / total > 0.4) {
    lines.push('情绪色调偏平静/收敛')
  }

  if (Math.abs(avgEnergy - baseEnergy) > 0.12) {
    lines.push(avgEnergy < baseEnergy ? `音乐能量在下降(最近 ${avgEnergy.toFixed(1)} vs 平时 ${baseEnergy.toFixed(1)})` : `音乐能量在上升(最近 ${avgEnergy.toFixed(1)} vs 平时 ${baseEnergy.toFixed(1)})`)
  }

  return lines.join('。')
}

function buildEchoShouldAsk(profile: TasteProfile): string {
  const seed = readArtistSeed()
  const lines = profile.artists
    .filter((artist) => seed[artist.name]?.echo_should_ask)
    .slice(0, 6)
    .map((artist) => `- ${artist.name}: ${seed[artist.name]?.signature_vibe ?? 'Echo 需要继续问清楚'}`)
  return lines.length ? lines.join('\n') : '(暂无)'
}

function buildKpopUndetermined(profile: TasteProfile): string {
  const haystack = [...profile.genres.map((genre) => genre.name), ...profile.artists.map((artist) => artist.name)].join(' ')
  if (!/k-?pop|blackpink|twice|seventeen|stray kids|newjeans|bts|exo|韩国|韩团/i.test(haystack)) return '(暂无)'
  return '用户资料里出现 K-pop / 韩团线索,但偏好的具体组合、时期、成员取向仍需要 Echo 在问题里问清楚。'
}

function buildRecentYinyiSummaries(): string {
  const entries = getYinyiRange(7)
  if (!entries.length) return '(暂无)'
  return entries.map((entry) => `- ${entry.date}: ${compactLine(entry.content, 120)}`).join('\n')
}

function buildThisWeekSignals(profile: TasteProfile, semanticByKey: Map<string, TrackSemantic>): string {
  const recentEvents = loadProfileTrackEventsBetween(7, 0, 1200)
  const recentFeedback = listTrackFeedbackUpdatedSince(7, 500)
  const windowSignals = buildEventWindowSignals(recentEvents, semanticByKey)
  const tracks = windowSignals.tracks.slice(0, 5).map((track) => `${trackLabel(track)}${track.year ? `(${track.year})` : ''}`).join('、') || '暂无'
  const feedbackSignals = recentFeedback
    .slice(0, 5)
    .map(formatPortraitFeedbackEvidence)
    .join('、') || '暂无'

  if (recentEvents.length === 0 && recentFeedback.length === 0) {
    return [
      '近 7 天新增播放/反馈信号不足。',
      `累计 top artists: ${profile.artists.slice(0, 5).map((artist) => `${artist.name}(${artist.affinity})`).join('、') || '暂无'}`,
      `累计 top genres: ${profile.genres.slice(0, 4).map((genre) => `${genre.name}(${genre.weight}, ${genre.trend})`).join('、') || '暂无'}`,
      '写 portrait 时把这些当作背景,避免写成最近变化。',
    ].join('\n')
  }

  return [
    `近 7 天行为线索: ${recentEvents.length > 0 || recentFeedback.length > 0 ? '有新的播放或反馈' : '暂无'}`,
    `recent artists: ${topCountLabels(windowSignals.artists, 5)}`,
    `recent genres: ${topCountLabels(windowSignals.genres, 4)}`,
    `recent moods: ${topCountLabels(windowSignals.moods, 5)}`,
    `recent status: 完整听过 ${windowSignals.completed}, 放下或跳过 ${windowSignals.skipped}`,
    `recent tracks: ${tracks}`,
    `recent feedback: ${feedbackSignals}`,
    `avoidance evidence: ${portraitAvoidedPatterns(profile).map((item) => `${item.scope}:${item.value}`).join('、') || '暂无'}`,
  ].join('\n')
}

function portraitAvoidedPatterns(profile: TasteProfile): Array<{ scope: 'track' | 'direction' | 'soft_direction'; value: string }> {
  return profile.anti_patterns
    .slice(0, 8)
    .map(formatAvoidedPattern)
    .filter((item): item is NonNullable<typeof item> => Boolean(item))
}

function buildPortraitProfileSnapshot(profile: TasteProfile): Record<string, unknown> {
  return {
    recent_insights: profile.insights?.recentChanges ?? [],
    artists: profile.artists.slice(0, 8).map((artist) => ({
      name: artist.name,
      affinity: artist.affinity,
      evidence: artist.notes,
    })),
    genres: profile.genres.slice(0, 8).map((genre) => ({
      name: genre.name,
      weight: genre.weight,
      trend: genre.trend,
      evidence: genre.note,
    })),
    moods: profile.moods.slice(0, 8).map((mood) => ({
      tag: mood.tag,
      frequency: mood.frequency,
      signature_artists: mood.signature_artists?.slice(0, 3),
    })),
    scenes: profile.scenes?.slice(0, 6),
    energy_preference: profile.energy_preference,
    tempo_preference: profile.tempo_preference,
    discovery_appetite: profile.discovery_appetite,
    avoided_patterns: portraitAvoidedPatterns(profile),
    signature_tracks: profile.signature_tracks.slice(0, 8).map((track) => ({
      title: track.title,
      artist: track.artist,
      source: track.source,
      reason: track.reason,
    })),
    evidence_counts: profile.profile_meta?.statsEvidence,
    updated_at: profile.profile_meta?.portraitUpdatedAt ?? profile.profile_meta?.updatedAt ?? profile.profile_meta?.structuredUpdatedAt,
  }
}

function buildThisMonthSignals(profile: TasteProfile, semanticByKey: Map<string, TrackSemantic>): string {
  const current = buildEventWindowSignals(loadProfileTrackEventsBetween(30, 0, 5000), semanticByKey)
  const previous = buildEventWindowSignals(loadProfileTrackEventsBetween(60, 30, 5000), semanticByKey)

  const genreDelta = (() => {
    const currentCounts = countBy(current.genres)
    const previousCounts = countBy(previous.genres)
    const currentTotal = Math.max(1, current.genres.length)
    const previousTotal = Math.max(1, previous.genres.length)
    return Array.from(new Set([...currentCounts.keys(), ...previousCounts.keys()]))
      .map((name) => ({
        name,
        delta: (currentCounts.get(name) ?? 0) / currentTotal - (previousCounts.get(name) ?? 0) / previousTotal,
      }))
      .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))
  })()
  const rising = genreDelta.filter((item) => item.delta > 0.08).slice(0, 4).map((item) => `${item.name}(+${Math.round(item.delta * 100)}%)`)
  const falling = genreDelta.filter((item) => item.delta < -0.08).slice(0, 4).map((item) => `${item.name}(${Math.round(item.delta * 100)}%)`)

  if (current.tracks.length < 5 && previous.tracks.length < 5) {
    return [
      '近 60 天播放事件不足,月度对照暂时不稳。',
      `当前探索倾向: ${profile.discovery_appetite}`,
      '写 portrait 时可以提“还在观察”,避免写成稳定变化。',
    ].join('\n')
  }

  return [
    `近 30 天播放事件: ${current.tracks.length}; 前 30 天播放事件: ${previous.tracks.length}`,
    `current month artists: ${topCountLabels(current.artists, 5)}`,
    `current month genres: ${topCountLabels(current.genres, 5)}`,
    `rising genres vs previous window: ${rising.join('、') || '暂无明显上升'}`,
    `falling genres vs previous window: ${falling.join('、') || '暂无明显下降'}`,
    `当前探索倾向: ${profile.discovery_appetite}`,
  ].join('\n')
}

function buildPortraitUserPrompt(profile: TasteProfile): string {
  const semantics = listSemantics()
  const semanticByKey = new Map(semantics.map((item) => [semanticTrackKey(item), item.semantic]))
  return `<relationship>
${escapePromptData(buildRelationshipContext(profile))}
</relationship>

<music_role>
${escapePromptData(buildMusicRoleSummary())}
</music_role>

<mood_trend>
${escapePromptData(buildMoodTrendSignal(profile, semanticByKey, semantics.length))}
</mood_trend>

<recent_music_intent_trend>
${escapePromptData(buildRecentMusicIntentTrend())}
</recent_music_intent_trend>

<current_profile>
${safePromptJson(buildPortraitProfileSnapshot(profile))}
</current_profile>

${buildMemoryEvidencePrompt(profile, { includeAudit: true })}

<last_portrait>
${escapePromptData(profile.echo_portrait)}
</last_portrait>

<this_week_signals>
${escapePromptData(buildThisWeekSignals(profile, semanticByKey))}
</this_week_signals>

<this_month_signals>
${escapePromptData(buildThisMonthSignals(profile, semanticByKey))}
</this_month_signals>

<echo_should_ask>
${escapePromptData(buildEchoShouldAsk(profile))}
</echo_should_ask>

<kpop_undetermined>
${escapePromptData(buildKpopUndetermined(profile))}
</kpop_undetermined>

<recent_yinyi_summaries>
${escapePromptData(buildRecentYinyiSummaries())}
</recent_yinyi_summaries>

${buildHistoricalPortraitContract()}

请严格返回 JSON,字段只包含 portrait、summary、suggested_questions。portrait 100-120 字。直接对用户说“你”,像熟悉的人写的一段观察。内部证据可以藏在表达背后,不要写成报告。`
}

function buildHistoricalPortraitContract(): string {
  return `<historical_portrait_contract>
last_portrait 和 recent_yinyi_summaries 是历史文案材料,只用于延续表达和避免重复; 与 user_corrections 冲突时,以 user_corrections 为准。
</historical_portrait_contract>`
}

interface PortraitTrackMention {
  title: string
  artist?: string
}

interface PortraitEvidence {
  trackPairs: Array<{ title: string; artist: string }>
  titles: Set<string>
  artists: Set<string>
}

function buildPortraitEvidence(profile?: TasteProfile): PortraitEvidence {
  const tracks = [
    ...(profile?.signature_tracks ?? []),
    ...(profile?.display?.signatureItems ?? []).map((item) => item.track),
    ...loadProfileTrackEventsBetween(60, 0, 2000).map((event) => event.track),
    ...listProfileTrackFeedback(300, 300)
      .filter((item) => item.favoriteCount > 0 || item.loopCount > 0 || item.playCount >= 2)
      .map((item) => item.track),
  ]
  return {
    trackPairs: tracks
      .map((track) => ({
        title: normalizeEvidenceText(track.title),
        artist: normalizeEvidenceText(track.artist),
      }))
      .filter((track) => track.title && track.artist),
    titles: new Set(tracks.map((track) => normalizeEvidenceText(track.title)).filter(Boolean)),
    artists: new Set([
      ...(profile?.artists ?? []).map((artist) => normalizeEvidenceText(artist.name)),
      ...tracks.map((track) => normalizeEvidenceText(track.artist)),
    ].filter(Boolean)),
  }
}

function mentionFromPortraitSongBlock(portrait: string, block: string): PortraitTrackMention {
  const inner = block.slice(1, -1).trim()
  const dashMatch = inner.match(/^(.+?)\s+[-–—]\s+(.+)$/)
  if (dashMatch) return { artist: dashMatch[1].trim(), title: dashMatch[2].trim() }
  const blockIndex = portrait.indexOf(block)
  const before = blockIndex > 0 ? portrait.slice(Math.max(0, blockIndex - 20), blockIndex) : ''
  const artistBeforeMatch = before.match(/([一-鿿\w]{2,15})[的]$/)
  return { title: inner, artist: artistBeforeMatch?.[1]?.trim() }
}

function isKnownTrackMention(mention: PortraitTrackMention, evidence: PortraitEvidence): boolean {
  const title = normalizeEvidenceText(mention.title)
  const artist = normalizeEvidenceText(mention.artist ?? '')
  if (!title) return true
  const pairMatches = evidence.trackPairs.some((item) => {
    const titleMatches = item.title === title || (title.length >= 3 && item.title.length >= 3 && (item.title.includes(title) || title.includes(item.title)))
    const artistMatches = !artist || item.artist === artist || (artist.length >= 2 && item.artist.length >= 2 && (item.artist.includes(artist) || artist.includes(item.artist)))
    return titleMatches && artistMatches
  })
  if (pairMatches) return true
  if (artist) return false
  return evidence.titles.has(title) || (title.length >= 3 && Array.from(evidence.titles).some((known) => known.length >= 3 && (known.includes(title) || title.includes(known))))
}

function hasPortraitBehaviorEvidence(profile?: TasteProfile): boolean {
  if (!profile) return false
  return profileBehaviorEvidenceCount(profile) >= 3
}

function overstatesRecentBehaviorWithoutEvidence(portrait: string, profile?: TasteProfile): boolean {
  if (!profile) return false
  if (hasPortraitBehaviorEvidence(profile)) return false
  return /最近(?:的)?播放|最近(?:常|总|反复)?听|最近.*反复回到|这几天(?:一直|总|反复)?听|这阵子(?:一直|总|反复)?听|今天(?:听|放)/.test(portrait)
}

function portraitV2Issues(portrait: string, profile?: TasteProfile, evidence = buildPortraitEvidence(profile)): string[] {
  const compact = portrait.replace(/\s+/g, '')
  const issues: string[] = []
  if (Array.from(compact).length < 90 || Array.from(compact).length > 140) issues.push('portrait 字数需要接近 100-120 字')
  if (!/你/.test(portrait)) issues.push('portrait 需要直接对用户说“你”')
  if (!/(可能|也许|大概|猜|说不准|不确定|拿不准|没看清|不知道|不太[确准]|感觉[像是]?好像|或许)/.test(portrait)) {
    issues.push('缺少不确定或猜测的表达,画像不应该全知')
  }
  if (!/(最近|这阵子|这几天|今天|好像|像是|有点|开始|还会|愿意|需要|想听|想找|靠近|躲开|安静|舒缓|放松|亮一点|更有劲|更有精神|低落|难过|开心|轻快|清醒|疲惫|累|困|睡|冷|陪伴|换心情|换状态|动起来)/.test(portrait)) {
    issues.push('缺少通过音乐看到人的状态观察')
  }
  if (!/(还想|想看清|没看清|想知道|想再确认|继续认识|再多听|再观察)/.test(portrait)) {
    issues.push('缺少 Echo 还想继续认识的点')
  }
  if (/(根据数据|画像显示|轨迹表明|从占比看|数据|占比|画像|算法|标签|模型|用户|profile|mood|energy|tempo|play:|skip:|fav:|不喜欢:|少推:|跳过:|\d+%)/i.test(portrait)) {
    issues.push('把内部证据直接写给用户了')
  }
  if (overstatesRecentBehaviorWithoutEvidence(portrait, profile)) {
    issues.push('把导入或语义证据写成了近期听歌行为')
  }
  if (/(分寸感|续航感|底色|光谱|底韵|往里收|接住你|稳稳的|太满|太猛|上头|燃爆)/.test(portrait)) issues.push('出现禁用表达')
  if (/(你其实|你总是|你一直|说明你|潜意识|人格|诊断)/.test(portrait)) issues.push('出现过度判断表达')
  if (evidence.titles.size > 0) {
    const songBlocks = portrait.match(/《([^》]+)》/g) ?? []
    const unknownTitles = new Set<string>()
    for (const block of songBlocks) {
      const mention = mentionFromPortraitSongBlock(portrait, block)
      if (!isKnownTrackMention(mention, evidence)) unknownTitles.add(mention.artist ? `${mention.artist} - ${mention.title}` : mention.title)
    }
    for (const title of unknownTitles) issues.push(`画像中提到的歌名「${title}」不在代表曲证据中,可能是编造的`)
  }
  if (evidence.artists.size > 0) {
    const songBlocks = portrait.match(/《([^》]+)》/g) ?? []
    const reportedArtists = new Set<string>()
    for (const block of songBlocks) {
      const mention = mentionFromPortraitSongBlock(portrait, block)
      const artist = normalizeEvidenceText(mention.artist ?? '')
      if (artist && !evidence.artists.has(artist) && !reportedArtists.has(artist)) {
        issues.push(`画像中提到的歌手「${mention.artist}」不在用户口味档案中,可能是编造的`)
        reportedArtists.add(artist)
      }
    }
  }
  return issues
}

function isHardPortraitIssue(issue: string): boolean {
  return /没有返回 portrait|需要直接对用户|把内部证据直接写给用户|把导入或语义证据写成了近期听歌行为|出现禁用表达|出现过度判断表达|可能是编造的/.test(issue)
}

function hasHardPortraitIssues(issues: string[]): boolean {
  return issues.some(isHardPortraitIssue)
}

function portraitIssueScore(issues: string[]): number {
  return issues.reduce((score, issue) => score + (isHardPortraitIssue(issue) ? 100 : 1), 0)
}

function shouldUseRetryPortrait(originalIssues: string[], retryIssues: string[]): boolean {
  const originalHasHardIssue = hasHardPortraitIssues(originalIssues)
  const retryHasHardIssue = hasHardPortraitIssues(retryIssues)
  if (originalHasHardIssue && !retryHasHardIssue) return true
  if (!originalHasHardIssue && retryHasHardIssue) return false
  return portraitIssueScore(retryIssues) < portraitIssueScore(originalIssues)
}

function shouldKeepPublishedPortrait(profile: TasteProfile, issues: string[]): boolean {
  return hasHardPortraitIssues(issues) && hasWrittenPortrait(profile) && Boolean(profile.echo_portrait.trim())
}

function portraitRegenerationResult(profile: TasteProfile, outcome: 'published' | 'retained', reason?: string): TasteProfile {
  return {
    ...profile,
    profile_meta: {
      ...(profile.profile_meta ?? {}),
      portraitRefreshOutcome: outcome,
      portraitRefreshReason: reason,
    },
  }
}

export const tasteTestHelpers = {
  effectiveProfilePlayCount,
  profileTrackAgencyFactor,
  shouldKeepPublishedPortrait,
  portraitRegenerationResult,
  buildRelationshipContextText,
  discoveryAppetiteFromTotals,
  semanticProfileWeight,
  artistEvidence,
  applyImportedTrackSignals,
  applySemanticTrackSignals,
  shouldIncludeArtistCandidate,
  isPositiveProfileEvent,
  filterProfileEventsByActionOutcome,
  hasWrittenPortrait,
  shouldIncludeSignatureCandidate,
  shouldCarryPreviousSignatureTrack,
  filterAntiPatternsForPositiveSignal,
  removeIncrementalSignalsFor,
  removeWeakPositiveProfileEvidence,
  shouldKeepGenreName,
  upsertMoodPreference,
  sceneItemsFromEvents,
  buildSonicPreferences,
  genreHasBehaviorEvidence,
  moodHasBehaviorEvidence,
  genreNote,
  buildProfileStatsEvidence,
  buildEventWindowSignals,
  formatPortraitFeedbackEvidence,
  buildPortraitProfileSnapshot,
  escapePromptData,
  safePromptJson,
  hasPortraitBehaviorEvidence,
  buildThisWeekSignals,
  buildLocalPortraitFallback,
  formatPortraitIntentTrend,
  buildRecentMusicIntentTrend,
  summarizeMusicIntentMessages,
  buildPortraitUserPrompt,
  buildHistoricalPortraitContract,
  portraitV2Issues,
  hasHardPortraitIssues,
  persistPortraitBaseProfile,
  portraitRegenerationErrorFor,
  shouldRefreshStructuredProfile,
  mergeProfileDisplay,
  ensureProfileDisplay,
  mergeIncrementalSignals,
  shouldKeepIncrementalSignal,
  downgradeStaleFavoriteDisplay,
  rememberLikedTrackOnProfile,
  CONTEXT_EVENT_TTL_HOURS,
}

export async function buildInitialProfile(tracks: Track[]): Promise<TasteProfile> {
  const base = buildProfileFromTracks(tracks)
  base.profile_meta = {
    ...(base.profile_meta ?? {}),
    refreshReason: 'import',
    updatedAt: new Date().toISOString(),
    structuredUpdatedAt: new Date().toISOString(),
    signalCount: getFeedbackSignalCount(),
    structuredSignalRevision: base.profile_meta?.signalRevision ?? 0,
  }
  const saved = saveTasteProfile(base, base.echo_portrait)

  for (const artist of saved.artists.slice(0, 5)) {
    const seed = readArtistSeed()[artist.name]
    if (seed?.echo_should_ask) {
      addTasteQuestion('unknown_artist', `${artist.name}我还不太熟,你怎么形容他的歌?`, { artist: artist.name })
    }
  }

  if (saved.artists.some((artist) => /blackpink|twice|seventeen|stray kids|newjeans|bts|exo|k-pop/i.test(artist.name))) {
    addTasteQuestion('kpop_detail', '你喜欢的韩国组合里,哪个是最稳的那个?', { source: 'initial_playlist' })
  }

  const regenerated = await regeneratePortrait().catch(() => saved)
  return regenerated ?? saved
}

export function refreshStructuredProfile(reason = 'manual'): TasteProfile | null {
  const next = buildStructuredProfileDraft(reason)
  return next ? saveTasteProfile(next, next.echo_portrait) : null
}

function mergeIncrementalSignals(rebuilt: TasteProfile, previous: TasteProfile | null, now = Date.now()): TasteProfile {
  if (!previous) return rebuilt
  const antiPatternMaxAgeMs = 90 * 24 * 60 * 60 * 1000
  const rebuiltAntiSet = new Set(rebuilt.anti_patterns)
  for (const pattern of previous.anti_patterns) {
    const recordedAt = previous.anti_pattern_meta?.[pattern]
    const recordedTime = recordedAt ? new Date(recordedAt).getTime() : now
    if (Number.isFinite(recordedTime) && now - recordedTime <= antiPatternMaxAgeMs && !rebuiltAntiSet.has(pattern)) {
      rebuilt.anti_patterns.push(pattern)
      rebuilt.anti_pattern_meta = {
        ...(rebuilt.anti_pattern_meta ?? {}),
        [pattern]: recordedAt ?? new Date(now).toISOString(),
      }
    }
  }
  const rebuiltSigKeys = new Set(rebuilt.signature_tracks.map((t) => `${t.title}::${t.artist}`))
  for (const track of previous.signature_tracks) {
    if (!shouldCarryPreviousSignatureTrack(track, now)) continue
    if (!rebuiltSigKeys.has(`${track.title}::${track.artist}`)) rebuilt.signature_tracks.push(track)
  }
  rebuilt.signature_tracks = rebuilt.signature_tracks.slice(0, 10)
  if (previous.energy_preference != null) {
    rebuilt.energy_preference = rebuilt.energy_preference == null
      ? previous.energy_preference
      : clamp(rebuilt.energy_preference * 0.7 + previous.energy_preference * 0.3)
  }
  if (previous.tempo_preference) {
    rebuilt.tempo_preference = rebuilt.tempo_preference
      ? {
          slow: clamp(rebuilt.tempo_preference.slow * 0.7 + previous.tempo_preference.slow * 0.3),
          medium: clamp(rebuilt.tempo_preference.medium * 0.7 + previous.tempo_preference.medium * 0.3),
          fast: clamp(rebuilt.tempo_preference.fast * 0.7 + previous.tempo_preference.fast * 0.3),
        }
      : previous.tempo_preference
  }
  if ((!rebuilt.scenes || rebuilt.scenes.length === 0) && previous.scenes) rebuilt.scenes = previous.scenes
  mergeCarriedStatsEvidence(rebuilt, previous)
  applyIncrementalSignals(rebuilt, previous, now)
  // A structured rebuild is the evidence authority. Incremental signals have
  // already been reapplied above, so stale display ranks must be allowed to fall.
  rebuilt.display = mergeProfileDisplay(rebuilt)
  return rebuilt
}

function buildStructuredProfileDraft(reason = 'manual'): TasteProfile | null {
  const tracks = getAllImportedTracks()
  const current = getTasteProfile()
  if (!current && tracks.length === 0) return null
  const next = mergeIncrementalSignals(buildProfileFromTracks(tracks), current)
  next.echo_portrait = current?.echo_portrait ?? next.echo_portrait
  next.profile_meta = {
    ...(next.profile_meta ?? {}),
    updatedAt: current?.profile_meta?.updatedAt ?? new Date().toISOString(),
    structuredUpdatedAt: new Date().toISOString(),
    refreshReason: reason,
    signalCount: getFeedbackSignalCount(),
    structuredSignalRevision: next.profile_meta?.signalRevision ?? 0,
  }
  return next
}

function persistPortraitBaseProfile(
  profile: TasteProfile | null,
  refreshStructured: boolean,
  persist: typeof saveTasteProfile = saveTasteProfile,
): TasteProfile | null {
  if (!profile || !refreshStructured) return profile
  return persist(profile, profile.echo_portrait)
}

function shouldRefreshStructuredProfile(profile: TasteProfile | null): boolean {
  if (!profile) return true
  const signalRevision = profile.profile_meta?.signalRevision ?? 0
  const structuredSignalRevision = profile.profile_meta?.structuredSignalRevision ?? 0
  return signalRevision > structuredSignalRevision
}

export function maybeRefreshStructuredProfile(reason = 'signal'): TasteProfile | null {
  const profile = getTasteProfile()
  if (!profile) return refreshStructuredProfile(reason)
  if (shouldRefreshStructuredProfile(profile)) {
    return refreshStructuredProfile(reason) ?? ensureProfileDisplay(profile)
  }
  return ensureProfileDisplay(profile)
}

export function getProfileWithQuestions(): { profile: TasteProfile | null; questions: ReturnType<typeof getPendingQuestions> } {
  return {
    profile: ensureProfileDisplay(getTasteProfile()),
    questions: getPendingQuestions(3),
  }
}

export async function regeneratePortrait(options: RegeneratePortraitOptions = {}): Promise<TasteProfile | null> {
  assertPortraitActive(options.signal)
  const refreshStructured = options.refreshStructured ?? true
  options.report?.({ phase: 'structured-profile', current: 0, total: 3, message: '' })
  const profileDraft = ensureProfileDisplay((refreshStructured ? buildStructuredProfileDraft('portrait') : null) ?? getTasteProfile())
  const profile = persistPortraitBaseProfile(profileDraft, refreshStructured)
  if (!profile) return null
  assertPortraitActive(options.signal)

  const prompt = readPortraitPrompt()
  const userPrompt = buildPortraitUserPrompt(profile)
  const portraitEvidence = buildPortraitEvidence(profile)
  const settings = getSettings()
  try {
    options.report?.({ phase: 'portrait', current: 1, total: 3, message: '' })
    const messages: LlmMessage[] = [
      { role: 'system', content: `${buildSoulPolicyPrompt('portrait')}\n\n${prompt}` },
      { role: 'user', content: userPrompt },
    ]
    const response = await completeChat(settings, messages, { temperature: 0.9, signal: options.signal, maxTokens: 800 })
    assertPortraitActive(options.signal)
    let parsed = parsePortraitResponse(response)
    const issues = parsed?.portrait ? portraitV2Issues(parsed.portrait, profile, portraitEvidence) : ['没有返回 portrait']
    if (issues.length) {
      options.report?.({ phase: 'portrait-retry', current: 2, total: 3, message: '' })
      const artistHint = issues.some((i) => i.includes('不在用户口味档案中'))
        ? `\n用户口味档案中的歌手: ${profile.artists.map((a) => a.name).join('、')}。画像中提到的歌手必须来自这个列表。`
        : ''
      const retryResponse = await completeChat(settings, [
        ...messages,
        { role: 'assistant', content: response },
        {
          role: 'user',
          content: `上一版没有通过画像 checklist: ${issues.join('；')}${artistHint}
请重写一次。只输出一个 JSON 对象,不要 Markdown,不要解释。字段只包含 portrait、summary、suggested_questions。`,
        },
      ], { temperature: 0.9, signal: options.signal, maxTokens: 800 })
      assertPortraitActive(options.signal)
      const retryParsed = parsePortraitResponse(retryResponse)
      if (retryParsed?.portrait) {
        const retryIssues = portraitV2Issues(retryParsed.portrait, profile, portraitEvidence)
        if (shouldUseRetryPortrait(issues, retryIssues)) parsed = retryParsed
      }
    }
    let finalParsed = parsed?.portrait ? parsed as PortraitResponse & { portrait: string } : buildLocalPortraitFallback(profile)
    const finalIssues = portraitV2Issues(finalParsed.portrait, profile, portraitEvidence)
    if (hasHardPortraitIssues(finalIssues)) {
      if (shouldKeepPublishedPortrait(profile, finalIssues)) {
        return portraitRegenerationResult(profile, 'retained', '新画像没有通过质量检查，已保留原画像。')
      }
      finalParsed = buildLocalPortraitFallback(profile)
    }
    options.report?.({ phase: 'save', current: 2, total: 3, message: '' })

    const next: TasteProfile = {
      ...profile,
      echo_portrait: finalParsed.portrait,
      work_summary: finalParsed.summary ?? profile.work_summary ?? finalParsed.portrait,
      display: profile.display ?? buildFallbackDisplay(profile),
      profile_meta: {
        ...(profile.profile_meta ?? {}),
        updatedAt: new Date().toISOString(),
        portraitUpdatedAt: new Date().toISOString(),
        structuredUpdatedAt: profile.profile_meta?.structuredUpdatedAt ?? new Date().toISOString(),
        portraitSignalCount: getFeedbackSignalCount(),
        portraitSignalRevision: profile.profile_meta?.signalRevision ?? 0,
      },
    }
    const publishedSummary = finalParsed.summary ?? finalParsed.portrait
    publishTasteProfile(next, publishedSummary, options.refreshStructured === false ? 'scheduled' : 'manual')
    for (const question of finalParsed.suggested_questions ?? []) {
      if (question.content) addTasteQuestion(question.kind ?? 'observation', question.content, question.context ?? {})
    }
    return portraitRegenerationResult(next, 'published')
  } catch (error) {
    assertPortraitActive(options.signal)
    if (options.fallbackOnError) return profile
    throw portraitRegenerationErrorFor(error)
  }
}

function applySemanticBoost(profile: TasteProfile, semantic: TrackSemantic, moodBoost: number, energyWeight: number): void {
  for (const mood of semantic.moods) {
    const existing = profile.moods.find((m) => m.tag === mood)
    if (existing) existing.frequency = clamp(existing.frequency + moodBoost)
  }
  const alpha = 0.15 / energyWeight
  const currentEnergy = profile.energy_preference ?? 0.5
  profile.energy_preference = clamp(currentEnergy * (1 - alpha) + semantic.energy * alpha)
  if (!profile.tempo_preference) profile.tempo_preference = { slow: 0, medium: 0, fast: 0 }
  profile.tempo_preference[semantic.tempo] = (profile.tempo_preference[semantic.tempo] ?? 0) + energyWeight
  profile.profile_meta = {
    ...(profile.profile_meta ?? {}),
    statsEvidence: {
      importedTrackCount: profile.profile_meta?.statsEvidence?.importedTrackCount ?? 0,
      semanticTrackCount: profile.profile_meta?.statsEvidence?.semanticTrackCount ?? 0,
      feedbackTrackCount: profile.profile_meta?.statsEvidence?.feedbackTrackCount ?? 0,
      positiveEventCount: profile.profile_meta?.statsEvidence?.positiveEventCount ?? 0,
      eraImportedCount: profile.profile_meta?.statsEvidence?.eraImportedCount ?? 0,
      eraBehaviorCount: profile.profile_meta?.statsEvidence?.eraBehaviorCount ?? 0,
      energyImportedCount: profile.profile_meta?.statsEvidence?.energyImportedCount ?? 0,
      energyBehaviorCount: (profile.profile_meta?.statsEvidence?.energyBehaviorCount ?? 0) + 1,
      tempoImportedCount: profile.profile_meta?.statsEvidence?.tempoImportedCount ?? 0,
      tempoBehaviorCount: (profile.profile_meta?.statsEvidence?.tempoBehaviorCount ?? 0) + 1,
      sceneEventCount: profile.profile_meta?.statsEvidence?.sceneEventCount ?? 0,
    },
  }
}

function applyContextEventStart(target: string, payload: Record<string, unknown>, strength: number): void {
  const eventConfidence = typeof payload.confidence === 'number' ? clamp(payload.confidence) : 0.7
  const eventWeight = typeof payload.weight === 'number'
    ? clamp(payload.weight)
    : Math.max(0.25, Math.min(0.8, strength))
  const content = target || String(payload.note ?? '用户表达了当前状态')
  const updated = getDb()
    .prepare(`
      UPDATE events
      SET confidence = ?,
          weight = ?,
          started_at = CURRENT_TIMESTAMP,
          expected_end_at = datetime('now', 'localtime', '+${CONTEXT_EVENT_TTL_HOURS} hours')
      WHERE user_id = current_user_id()
        AND kind = 'context'
        AND content = ?
        AND COALESCE(expected_end_at, datetime(COALESCE(started_at, created_at), '+${CONTEXT_EVENT_TTL_HOURS} hours')) > datetime('now', 'localtime')
    `)
    .run(eventConfidence, eventWeight, content)
  if (updated.changes === 0) {
    getDb()
      .prepare(`
        INSERT INTO events (user_id, kind, content, confidence, weight, started_at, expected_end_at)
        VALUES (current_user_id(), 'context', ?, ?, ?, CURRENT_TIMESTAMP, datetime('now', 'localtime', '+${CONTEXT_EVENT_TTL_HOURS} hours'))
      `)
      .run(content, eventConfidence, eventWeight)
  }
}

function applyContextEventEnd(target: string): void {
  getDb()
    .prepare(
      `UPDATE events
       SET expected_end_at = CURRENT_TIMESTAMP, weight = 0.1
       WHERE user_id = current_user_id()
         AND kind = 'context'
         AND content LIKE ?
         AND (expected_end_at IS NULL OR expected_end_at > datetime('now', 'localtime'))`,
    )
    .run(`%${target}%`)
}

export async function applySignal(kind: string, payload: Record<string, unknown>): Promise<TasteProfile | null> {
  const target = String(payload.target ?? payload.artist ?? payload.genre ?? payload.vibe ?? '').trim()
  const strength = typeof payload.strength === 'number' ? clamp(payload.strength) : 0.2

  if (kind === 'event_started') {
    applyContextEventStart(target, payload, strength)
    return getTasteProfile()
  }

  if (kind === 'event_ended') {
    applyContextEventEnd(target)
    return getTasteProfile()
  }

  const profile = ensureProfileDisplay(getTasteProfile() ?? buildProfileFromTracks(getAllImportedTracks()))
  if (!profile) return null

  if (!target && !kind.startsWith('event_')) return saveTasteProfile({ ...profile, display: mergeProfileDisplay(profile, profile.display) }, profile.echo_portrait)

  const rawTrackId = payload.trackId ?? payload.neteaseId
  const trackLookup = {
    title: String(payload.title ?? ''),
    artist: String(payload.artist ?? target ?? ''),
    id: rawTrackId != null ? String(rawTrackId) : undefined,
  }
  const semantic = (trackLookup.title && trackLookup.artist) ? getTrackSemantic(trackLookup) : null
  const rememberAntiPattern = (value: string) => {
    const pattern = value.trim()
    if (!pattern) return
    profile.anti_patterns = [
      pattern,
      ...profile.anti_patterns.filter((item) => item !== pattern),
    ].slice(0, 32)
    profile.anti_pattern_meta = {
      ...(profile.anti_pattern_meta ?? {}),
      [pattern]: new Date().toISOString(),
    }
    const retained = new Set(profile.anti_patterns)
    for (const key of Object.keys(profile.anti_pattern_meta)) {
      if (!retained.has(key)) delete profile.anti_pattern_meta[key]
    }
  }
  const pruneAntiPatternMeta = () => {
    if (profile.anti_pattern_meta) {
      const retained = new Set(profile.anti_patterns)
      for (const pattern of Object.keys(profile.anti_pattern_meta)) {
        if (!retained.has(pattern)) delete profile.anti_pattern_meta[pattern]
      }
    }
  }
  const forgetAntiPatternsFor = (scope: PositiveSignalScope) => {
    profile.anti_patterns = filterAntiPatternsForPositiveSignal(profile.anti_patterns, scope)
    pruneAntiPatternMeta()
  }

  if (kind === 'like_artist') {
    forgetAntiPatternsFor({ kind: 'like_artist', target })
    recordIncrementalSignal(profile, { kind: 'like_artist', target, strength })
    const existing = profile.artists.find((artist) => artist.name === target)
    if (existing) existing.affinity = clamp(existing.affinity + strength)
    else profile.artists.unshift({ name: target, affinity: clamp(0.5 + strength), notes: String(payload.note ?? '对话里有过主动喜欢的线索。') })
    if (semantic) applySemanticBoost(profile, semantic, 0.07, 3)
  }

  if (kind === 'unlike_artist') {
    const scope: PositiveSignalScope = { kind: 'like_artist', target }
    removeIncrementalSignalsFor(profile, scope)
    removeWeakPositiveProfileEvidence(profile, scope)
    const existing = profile.artists.find((artist) => artist.name === target)
    if (existing) existing.affinity = clamp(existing.affinity - strength)
    rememberAntiPattern(`不喜欢歌手:${target}`)
    shiftDiscoveryAppetite(profile, 0.04)
  }

  if (kind === 'like_track') {
    const title = String(payload.title ?? '').trim()
    const artist = String(payload.artist ?? '').trim()
    if (title) forgetAntiPatternsFor({ kind: 'like_track', artist, title })
    if (title) recordIncrementalSignal(profile, { kind: 'like_track', target: [artist, title].filter(Boolean).join(' / ') || title, artist, title, strength })
    if (title) {
      rememberLikedTrackOnProfile(profile, {
        title,
        artist,
        strength,
        reason: typeof payload.reason === 'string' ? payload.reason : undefined,
      })
    }
  }

  if (kind === 'unlike_track') {
    const title = String(payload.title ?? '').trim()
    const artist = String(payload.artist ?? '').trim()
    if (title) {
      const scope: PositiveSignalScope = { kind: 'like_track', artist, title }
      removeIncrementalSignalsFor(profile, scope)
      removeWeakPositiveProfileEvidence(profile, scope)
    }
    const marker = [artist, title].filter(Boolean).join(' ')
    if (marker) {
      rememberAntiPattern(`不喜欢:${marker}`)
    }
    profile.signature_tracks = profile.signature_tracks.filter((track) => (
      track.title !== title || (artist && track.artist !== artist)
    ))
    shiftDiscoveryAppetite(profile, 0.02)
  }

  if (kind === 'like_genre') {
    forgetAntiPatternsFor({ kind: 'like_genre', target })
    recordIncrementalSignal(profile, { kind: 'like_genre', target, strength })
    const existing = profile.genres.find((genre) => genre.name === target)
    if (existing) {
      existing.weight = clamp(existing.weight + strength)
      existing.trend = 'up'
    } else {
      profile.genres.unshift({ name: target, weight: clamp(0.4 + strength), trend: 'up' })
    }
  }

  if (kind === 'unlike_genre') {
    const scope: PositiveSignalScope = { kind: 'like_genre', target }
    removeIncrementalSignalsFor(profile, scope)
    removeWeakPositiveProfileEvidence(profile, scope)
    const existing = profile.genres.find((genre) => genre.name === target)
    if (existing) {
      existing.weight = clamp(existing.weight - strength)
      existing.trend = 'down'
    }
    rememberAntiPattern(target)
    shiftDiscoveryAppetite(profile, 0.04)
  }

  if (kind === 'soften_genre' && target) {
    recordIncrementalSignal(profile, { kind: 'soften_genre', target, strength })
    const scope: PositiveSignalScope = { kind: 'like_genre', target }
    removeWeakPositiveProfileEvidence(profile, scope)
    const existing = profile.genres.find((genre) => genre.name === target)
    if (existing) {
      existing.weight = clamp(existing.weight - Math.max(0.02, strength / 2))
      existing.trend = 'down'
    }
    rememberAntiPattern(`少推:${target}`)
    shiftDiscoveryAppetite(profile, 0.015)
  }

  if (kind === 'reinforce_vibe' && target) {
    forgetAntiPatternsFor({ kind: 'reinforce_vibe', target })
    recordIncrementalSignal(profile, { kind: 'reinforce_vibe', target, strength })
    upsertMoodPreference(profile, target, strength, {
      baseFrequency: 0.5,
      signatureArtists: profile.artists.slice(0, 3).map((artist) => artist.name),
    })
    profile.moods = profile.moods.slice(0, 10)
  }

  if (kind === 'unlike_vibe' && target) {
    const scope: PositiveSignalScope = { kind: 'reinforce_vibe', target }
    removeIncrementalSignalsFor(profile, scope)
    removeWeakPositiveProfileEvidence(profile, scope)
    const existing = profile.moods.find((mood) => mood.tag === target)
    if (existing) existing.frequency = clamp(existing.frequency - Math.max(0.04, strength))
    rememberAntiPattern(target)
    shiftDiscoveryAppetite(profile, 0.04)
  }

  if (kind === 'soften_vibe' && target) {
    recordIncrementalSignal(profile, { kind: 'soften_vibe', target, strength })
    const scope: PositiveSignalScope = { kind: 'reinforce_vibe', target }
    removeWeakPositiveProfileEvidence(profile, scope)
    const existing = profile.moods.find((mood) => mood.tag === target)
    if (existing) existing.frequency = clamp(existing.frequency - Math.max(0.02, strength / 2))
    rememberAntiPattern(`少推:${target}`)
    shiftDiscoveryAppetite(profile, 0.015)
  }

  if ((kind === 'raise_energy' || kind === 'lower_energy') && target) {
    recordIncrementalSignal(profile, { kind, target, strength })
    const direction = kind === 'raise_energy' ? 1 : -1
    profile.energy_preference = clamp((profile.energy_preference ?? 0.5) + direction * strength)
  }

  if ((kind === 'reinforce_scene' || kind === 'soften_scene') && target) {
    recordIncrementalSignal(profile, { kind, target, strength })
    const direction = kind === 'reinforce_scene' ? 1 : -1
    const scenes = profile.scenes ?? []
    const existing = scenes.find((scene) => scene.tag === target)
    if (existing) existing.frequency = clamp(existing.frequency + direction * strength)
    else if (direction > 0) scenes.unshift({ tag: target, frequency: clamp(0.35 + strength) })
    profile.scenes = scenes.filter((scene) => scene.frequency > 0).slice(0, 8)
  }

  if (kind === 'played') {
    const artist = String(payload.artist ?? target).trim()
    if (artist) {
      const existing = profile.artists.find((item) => item.name === artist)
      if (existing) {
        existing.affinity = clamp(existing.affinity + strength)
        existing.notes = `最近完整听过 ${String(payload.title ?? '一首歌')}`
      } else {
        profile.artists.unshift({ name: artist, affinity: clamp(0.53 + strength), notes: '最近完整听过' })
      }
    }
    if (semantic) applySemanticBoost(profile, semantic, Math.max(0.01, strength), 1)
  }

  if (kind === 'skipped') {
    const artist = String(payload.artist ?? target).trim()
    if (artist) {
      const existing = profile.artists.find((item) => item.name === artist)
      if (existing) existing.affinity = clamp(existing.affinity - strength)
      const title = String(payload.title ?? '').trim()
      const scope: PositiveSignalScope = title
        ? { kind: 'like_track', artist, title }
        : { kind: 'like_artist', target: artist }
      removeIncrementalSignalsFor(profile, scope)
      removeWeakPositiveProfileEvidence(profile, scope)
      if (title) {
        const marker = `跳过:${[artist, title].filter(Boolean).join(' ')}`
        rememberAntiPattern(marker)
      }
    }
    if (semantic) {
      for (const mood of semantic.moods) {
        const existing = profile.moods.find((m) => m.tag === mood)
        if (existing) existing.frequency = clamp(existing.frequency - Math.max(0.005, strength / 2))
      }
    }
    shiftDiscoveryAppetite(profile, 0.03)
  }

  if (kind === 'looped') {
    const artist = String(payload.artist ?? target).trim()
    if (artist) {
      const existing = profile.artists.find((item) => item.name === artist)
      if (existing) {
        existing.affinity = clamp(existing.affinity + strength)
        existing.notes = `24 小时内循环过 ${String(payload.title ?? '一首歌')}`
      } else {
        profile.artists.unshift({ name: artist, affinity: clamp(0.58 + strength), notes: '最近循环过' })
      }
    }
    if (semantic) applySemanticBoost(profile, semantic, Math.max(0.03, strength), 3)
    shiftDiscoveryAppetite(profile, -0.02)
  }

  if (kind === 'favorited') {
    const artist = String(payload.artist ?? target).trim()
    const title = String(payload.title ?? '').trim()
    const favoritedAt = new Date().toISOString()
    if (title) forgetAntiPatternsFor({ kind: 'like_track', artist, title })
    if (artist) {
      const existing = profile.artists.find((item) => item.name === artist)
      if (existing) {
        existing.affinity = clamp(existing.affinity + strength)
        existing.notes = `刚收藏过 ${String(payload.title ?? '一首歌')}`
      } else {
        profile.artists.unshift({ name: artist, affinity: clamp(0.6 + strength), notes: '刚收藏过' })
      }
    }
    if (title) {
      const existingTrack = profile.signature_tracks.find((track) => track.title === title && track.artist === artist)
      if (existingTrack) {
        existingTrack.source = 'favorite'
        existingTrack.recommendedAt = favoritedAt
        existingTrack.reason = '你主动收藏过，Echo 会把它当作更强的口味信号。'
      } else {
        profile.signature_tracks = [
          {
            title,
            artist,
            source: 'favorite',
            recommendedAt: favoritedAt,
            reason: '你主动收藏过，Echo 会把它当作更强的口味信号。',
          },
          ...profile.signature_tracks,
        ].slice(0, 10)
      }
    }
    if (semantic) applySemanticBoost(profile, semantic, Math.max(0.05, strength), 4)
    shiftDiscoveryAppetite(profile, -0.03)
  }

  if (kind === 'unfavorited') {
    const artist = String(payload.artist ?? target).trim()
    const title = String(payload.title ?? '').trim()
    if (title) {
      const scope: PositiveSignalScope = { kind: 'like_track', artist, title }
      removeIncrementalSignalsFor(profile, scope)
      removeWeakPositiveProfileEvidence(profile, scope)
    }
    profile.signature_tracks = profile.signature_tracks.filter((track) => (
      track.title !== title || (artist && track.artist !== artist) || track.source !== 'favorite'
    ))
    downgradeStaleFavoriteDisplay(profile, artist)
    if (artist) {
      const existing = profile.artists.find((item) => item.name === artist)
      if (existing) {
        existing.affinity = clamp(existing.affinity - Math.min(strength, 0.09))
        if (existing.notes?.startsWith('刚收藏过')) existing.notes = '后续继续校准'
      }
    }
    shiftDiscoveryAppetite(profile, 0.03)
  }

  if (kind === 'correct_assumption') {
    const eventConfidence = typeof payload.confidence === 'number' ? clamp(payload.confidence) : 0.7
    const eventWeight = typeof payload.weight === 'number' ? clamp(payload.weight) : 0.8
    const content = target || String(payload.note ?? '用户修正了 Echo 的判断')
    getDb()
      .prepare('INSERT INTO events (user_id, kind, content, confidence, weight, started_at) VALUES (current_user_id(), ?, ?, ?, ?, CURRENT_TIMESTAMP)')
      .run('correction', content, eventConfidence, eventWeight)
    clearRecommendationCache()
  }

  profile.artists = profile.artists.sort((a, b) => b.affinity - a.affinity).slice(0, 12)
  profile.genres = profile.genres.sort((a, b) => b.weight - a.weight).slice(0, 12)
  profile.display = mergeProfileDisplay(profile, profile.display)
  profile.profile_meta = {
    ...(profile.profile_meta ?? {}),
    signalUpdatedAt: new Date().toISOString(),
    signalRevision: (profile.profile_meta?.signalRevision ?? 0) + 1,
  }
  return saveTasteProfile(profile, profile.echo_portrait)
}

export async function respondToProfileInsight(insight: ProfileInsight, action: ProfileInsightFeedbackAction): Promise<TasteProfile | null> {
  let profile = getTasteProfile()
  if (action === 'confirm') {
    const signal = profileInsightConfirmationSignal(insight)
    profile = await applySignal(signal.kind, signal.payload)
  } else if (action === 'temporary') {
    profile = await applySignal('event_started', {
      target: insight.statement,
      confidence: 0.72,
      weight: 0.45,
    })
  }
  saveProfileInsightFeedback(insight, action)
  if (profile?.insights) {
    profile = {
      ...profile,
      insights: {
        ...profile.insights,
        recentChanges: profile.insights.recentChanges.filter((item) => item.id !== insight.id),
      },
    }
    profile = saveTasteProfile(profile, profile.echo_portrait)
  }
  return profile
}

export async function answerQuestion(id: number, answer: string): Promise<{ ok: boolean }> {
  saveTasteQuestionAnswer(id, answer)
  return { ok: true }
}
