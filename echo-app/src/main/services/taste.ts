import type { ProfileDisplayModel, ProfileEvidenceLevel, ProfileEvidenceSource, TasteProfile, Track, TrackSemantic } from '../../types/ipc'
import { trackIdentity as trackKey } from '../../shared/trackIdentity'
import { getDb } from '../db'
import { loadRecentConversations, loadTodayConversations } from '../db/conversations'
import { getFeedbackSignalCount, listTrackFeedback, listTrackFeedbackUpdatedSince, type TrackFeedback } from '../db/feedback'
import { getAllImportedTracks } from '../db/playlists'
import { clearRecommendationCache } from '../db/recommendationCache'
import { getTrackSemantic, listSemantics, semanticTrackKey } from '../db/semantics'
import { loadProfileTrackEvents, loadProfileTrackEventsBetween, type ProfileTrackEvent } from '../db/tracks'
import {
  addTasteQuestion,
  answerTasteQuestion as saveTasteQuestionAnswer,
  getPendingQuestions,
  getTasteProfile,
  saveTasteProfile,
} from '../db/taste'
import { getSettings } from '../db/settings'
import { getYinyiRange } from '../db/yinyi'
import { completeChat, LlmError, type LlmMessage } from '../llm/client'
import { readRootFile } from '../utils/paths'
import { buildSoulPolicyPrompt } from '../skills/soul/policy'
import { inferTrackSemanticFallback } from './semantics'
import { buildMemoryEvidencePrompt } from './memoryEvidence'
import { parseIntent, type RecommendationIntent } from './recommendation/intent'

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
    if (language === '粤语') return '粤语流行'
    if (language === '英语') return '欧美流行'
    if (language === '韩语') return 'K-pop'
    if (language === '日语') return '日语流行'
    return '华语流行'
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

function eventScenes(events: ProfileTrackEvent[]): string[] {
  return events.flatMap((event) => event.track.profileEvidence?.scenes ?? [])
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

function hasLegacyProfileNote(note?: string): boolean {
  return Boolean(note && LEGACY_PROFILE_NOTE_PATTERNS.some((pattern) => pattern.test(note)))
}

function signatureEvidence(feedback: TrackFeedback | undefined, events: ProfileTrackEvent[], semanticMood?: string): EvidenceNote {
  if (feedback?.favoriteCount) return { text: '你主动收藏过,Echo 会把它留在代表曲里。', evidenceLevel: 'strong', source: 'favorite', count: feedback.favoriteCount }
  if ((feedback?.loopCount ?? 0) >= 2) return { text: `你循环过 ${feedback?.loopCount} 次,属于会回头的声音。`, evidenceLevel: 'strong', source: 'loop', count: feedback?.loopCount }
  if ((feedback?.playCount ?? 0) >= 3) return { text: `你完整听过 ${feedback?.playCount} 次。`, evidenceLevel: 'strong', source: 'played', count: feedback?.playCount }
  const scene = mostFrequent(eventScenes(events))
  if (scene) return { text: `你在${scene}时,它常被 Echo 接上。`, evidenceLevel: 'strong', source: 'scene' }
  const mood = mostFrequent(eventMoods(events)) ?? semanticMood
  if (mood) return { text: `「${mood}」线索`, evidenceLevel: 'medium', source: 'semantic' }
  return { text: undefined, evidenceLevel: 'weak', source: 'imported' }
}

function genreNote(name: string, weight: number, trend: 'up' | 'down' | 'steady', artists: string[]): { note: string; evidenceLevel: ProfileEvidenceLevel; source: ProfileEvidenceSource } {
  const evidenceLevel: ProfileEvidenceLevel = (artists.length >= 2 || weight >= 0.18 || trend !== 'steady') ? 'medium' : 'weak'
  const source: ProfileEvidenceSource = artists.length > 0 ? 'semantic' : 'fallback'
  if (artists.length === 0) {
    const pct = Math.round(weight * 100)
    if (trend === 'up') return { note: `${name} 最近上来,占比 ${pct}%`, evidenceLevel, source }
    if (trend === 'down') return { note: `${name} 占比 ${pct}%,在收`, evidenceLevel, source }
    return { note: `${name} · ${pct}%`, evidenceLevel, source }
  }
  const top = artists[0]
  const pct = Math.round(weight * 100)
  if (trend === 'up') return { note: `${top} 推动 ${name} 上来 · ${pct}%`, evidenceLevel, source }
  if (trend === 'down') return { note: `${top} 还在,${name} 收了一点 · ${pct}%`, evidenceLevel, source }
  return { note: `${top} · ${pct}%`, evidenceLevel, source }
}

function artistEvidence(stats: { imported: number; played: number; skipped: number; looped: number; favorited: number; scenes: string[] }, seed?: ArtistSeed): EvidenceNote {
  if (stats.favorited > 0) return { text: `收藏过 ${stats.favorited} 首`, evidenceLevel: 'strong', source: 'favorite' }
  if (stats.looped > 0) return { text: `循环过 ${stats.looped} 次`, evidenceLevel: 'strong', source: 'loop' }
  if (stats.played >= 3) return { text: `完整听过 ${stats.played} 次`, evidenceLevel: 'strong', source: 'played' }
  const scene = mostFrequent(stats.scenes)
  if (scene) return { text: `${scene}时常出现`, evidenceLevel: 'strong', source: 'scene' }
  if (stats.skipped >= 3 && stats.played < stats.skipped) return { text: `跳过 ${stats.skipped} 次`, evidenceLevel: 'medium', source: 'played' }
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
  scenes: string[]
  score: number
}

interface ProfileBuildContext {
  tracks: Track[]
  artistSeed: Record<string, ArtistSeed>
  semanticTracks: Array<{ title: string; artist: string; semantic: TrackSemantic }>
  feedbackRows: TrackFeedback[]
  profileEvents: ProfileTrackEvent[]
  feedbackByKey: Map<string, TrackFeedback>
  semanticByKey: Map<string, TrackSemantic>
  eventsByKey: Map<string, ProfileTrackEvent[]>
  genreCounts: Map<string, number>
  moodCounts: Map<string, number>
  eraCounts: Map<string, number>
  genreArtists: Map<string, Map<string, number>>
  artistStats: Map<string, ArtistStats>
}

function emptyArtistStats(): ArtistStats {
  return { imported: 0, played: 0, skipped: 0, looped: 0, favorited: 0, scenes: [], score: 0 }
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

function createProfileBuildContext(tracks: Track[]): ProfileBuildContext {
  const semanticTracks = listSemantics()
  const feedbackRows = listTrackFeedback()
  const profileEvents = loadProfileTrackEvents()
  return {
    tracks,
    artistSeed: readArtistSeed(),
    semanticTracks,
    feedbackRows,
    profileEvents,
    feedbackByKey: new Map(feedbackRows.map((item) => [item.trackKey, item])),
    semanticByKey: new Map(semanticTracks.map((track) => [trackKey(track), track.semantic])),
    eventsByKey: groupEventsByTrack(profileEvents),
    genreCounts: new Map<string, number>(),
    moodCounts: new Map<string, number>(),
    eraCounts: new Map<string, number>(),
    genreArtists: new Map<string, Map<string, number>>(),
    artistStats: new Map<string, ArtistStats>(),
  }
}

function applyImportedTrackSignals(context: ProfileBuildContext): void {
  for (const track of context.tracks) {
    const seed = context.artistSeed[track.artist]
    const stats = statsFor(context, track.artist)
    stats.imported += 1
    stats.score += PROFILE_WEIGHT.importedTrack
    for (const genre of seed?.genre ?? ['流行']) {
      const normalized = normalizedGenre(genre)
      addWeighted(context.genreCounts, normalized, PROFILE_WEIGHT.importedTrack)
      addGenreArtistWeight(context, normalized, track.artist, PROFILE_WEIGHT.importedTrack)
    }
    for (const mood of seed?.mood ?? ['calm']) context.moodCounts.set(mood, (context.moodCounts.get(mood) ?? 0) + 1)
    const era = eraForYear(track.year)
    if (era) context.eraCounts.set(era, (context.eraCounts.get(era) ?? 0) + 1)
  }
}

function applySemanticTrackSignals(context: ProfileBuildContext): void {
  for (const track of context.semanticTracks) {
    const feedback = context.feedbackByKey.get(trackKey(track))
    const behaviorWeight = Math.max(0, Math.min(3, feedback?.score ?? 0))
    for (const rawGenre of track.semantic.genres) {
      const genre = normalizedGenre(rawGenre, track.semantic.language)
      addWeighted(context.genreCounts, genre, PROFILE_WEIGHT.semanticBase + behaviorWeight)
      addGenreArtistWeight(context, genre, track.artist, 1 + behaviorWeight)
    }
    for (const mood of track.semantic.moods) context.moodCounts.set(mood, (context.moodCounts.get(mood) ?? 0) + PROFILE_WEIGHT.semanticBase + behaviorWeight)
    statsFor(context, track.artist).score += PROFILE_WEIGHT.semanticArtistBase + behaviorWeight
  }
}

function applyFeedbackSignals(context: ProfileBuildContext): void {
  for (const feedback of context.feedbackRows) {
    const artist = feedback.track.artist
    const semantic = semanticForProfile(context, feedback.track)
    const positiveWeight = Math.max(0, Math.min(4, feedback.score))
    const stats = statsFor(context, artist)
    stats.played += feedback.playCount
    stats.skipped += feedback.skipCount
    stats.looped += feedback.loopCount
    stats.favorited += feedback.favoriteCount
    stats.score += feedback.playCount * PROFILE_WEIGHT.playedFeedback
      + feedback.loopCount * PROFILE_WEIGHT.loopFeedback
      + feedback.favoriteCount * PROFILE_WEIGHT.favoriteFeedback
      + feedback.skipCount * PROFILE_WEIGHT.skipFeedback
    if (positiveWeight > 0) {
      for (const rawGenre of semantic.genres) addWeighted(context.genreCounts, normalizedGenre(rawGenre, semantic.language), positiveWeight * PROFILE_WEIGHT.positiveGenreFeedback)
      for (const mood of semantic.moods) addWeighted(context.moodCounts, mood, positiveWeight)
    }
  }
}

function applyProfileEventSignals(context: ProfileBuildContext): void {
  for (const event of context.profileEvents) {
    const artist = event.track.artist
    const semantic = semanticForProfile(context, event.track)
    const eventWeight = event.queueStatus === 'completed'
      ? PROFILE_WEIGHT.completedEventGenre
      : event.queueStatus === 'skipped'
        ? PROFILE_WEIGHT.skippedEventGenre
        : PROFILE_WEIGHT.neutralEventGenre
    const stats = statsFor(context, artist)
    stats.score += event.queueStatus === 'completed'
      ? PROFILE_WEIGHT.completedEventArtist
      : event.queueStatus === 'skipped'
        ? PROFILE_WEIGHT.skippedEventArtist
        : PROFILE_WEIGHT.neutralEventArtist
    stats.scenes.push(...(event.track.profileEvidence?.scenes ?? []))
    for (const mood of event.track.profileEvidence?.moods ?? []) context.moodCounts.set(mood, (context.moodCounts.get(mood) ?? 0) + PROFILE_WEIGHT.eventMood)
    if (eventWeight > 0) {
      for (const rawGenre of semantic.genres) addWeighted(context.genreCounts, normalizedGenre(rawGenre, semantic.language), eventWeight * PROFILE_WEIGHT.eventGenreSemantic)
      for (const mood of semantic.moods) addWeighted(context.moodCounts, mood, eventWeight)
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
  const maxArtistScore = Math.max(1, ...Array.from(context.artistStats.values()).map((item) => item.score))
  return Array.from(context.artistStats.entries()).sort((a, b) => b[1].score - a[1].score).slice(0, 8).map(([name, stats]) => {
    const evidence = artistEvidence(stats, context.artistSeed[name])
    return {
      name,
      affinity: clamp(Math.max(0.08, stats.score / maxArtistScore)),
      notes: evidence.text,
    }
  })
}

function buildTopGenres(context: ProfileBuildContext, previous: TasteProfile | null, totalGenre: number): TasteProfile['genres'] {
  const allArtists = new Set(
    Array.from(context.artistStats.keys()).map(name => name.trim().toLowerCase())
  )
  const explicitArtists = new Set([
    '王菲', '林俊杰', '周杰伦', 'bruno mars', 'charlie puth', '蔡健雅', '海洋bo', 'justin bieber', 'taylor swift', 'adele', 'eason chan', '陈奕迅', '孙燕姿', '张杰', '邓紫棋'
  ])

  return topEntries(context.genreCounts, 16)
    .filter(([name]) => {
      const cleanName = name.trim().toLowerCase()
      if (allArtists.has(cleanName)) return false
      if (explicitArtists.has(cleanName)) return false
      return true
    })
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
        events.length * PROFILE_WEIGHT.signatureEvent +
        (feedback?.favoriteCount ? PROFILE_WEIGHT.signatureFavorite : 0) +
        (feedback?.loopCount ?? 0) * PROFILE_WEIGHT.signatureLoop +
        (semantic?.confidence ?? 0) +
        (context.tracks.some((item) => trackKey(item) === key) ? PROFILE_WEIGHT.importedTrack : 0)
      return {
        track: {
          ...track,
          reason: evidence.text,
        },
        score,
      }
    })
    .sort((a, b) => b.score - a.score)
    .slice(0, 7)
    .map((item) => item.track)
}

function buildProfileDisplay(context: ProfileBuildContext, signatureTracks: Track[], topArtists: TasteProfile['artists'], topGenres: TasteProfile['genres'], moods: TasteProfile['moods']): ProfileDisplayModel {
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
      const evidence = genreNote(genre.name, genre.weight, genre.trend, representativeArtists)
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
    moodItems: moods.slice(0, 6).map((mood) => ({
      tag: mood.tag,
      frequency: mood.frequency,
      evidenceLevel: mood.frequency >= 0.18 ? 'medium' : 'weak',
      source: 'semantic',
    })),
  }
}

function buildFallbackPortrait(topArtists: string[], topGenres: string[], signatureTracks: Track[]): string {
  const artists = topArtists.slice(0, 3).join('、') || '这些歌'
  const genres = topGenres.slice(0, 2).join('和') || '旋律性强的流行歌'
  const firstTrack = signatureTracks[0]
  const anchor = firstTrack ? `像《${firstTrack.title}》这种歌` : '那些旋律先到、情绪后到的歌'
  return `我先从歌单里认出几个坐标: ${artists}。你的安全区大概在${genres}附近,要有旋律,也要有一句能留下来的表达。${anchor}对你来说像入口,它能把白天的噪音压低一点。等你多和我聊几次,我会把这些粗线条慢慢改细。`
}

function buildLocalPortraitFallback(profile: TasteProfile): PortraitResponse & { portrait: string } {
  const artist = profile.artists[0]?.name || profile.signature_tracks[0]?.artist || '熟悉的声音'
  const genre = profile.genres[0]?.name || '旋律舒服的歌'
  const mood = profile.moods[0]?.tag || '陪伴'
  const portrait = `我可能还没完全看清你，但已经能听出一点：你会靠近${artist}和${genre}这类声音，旋律要顺，情绪也要能留一会儿。最近你像是需要一点${mood}，也想把耳朵从杂乱里带出来。再多听几次，我会把这些判断慢慢校准。`
  return {
    portrait,
    summary: `偏好线索：${artist}、${genre}、${mood}。画像由本地证据兜底生成，等待后续模型刷新。`,
    suggested_questions: [],
  }
}

function clampDiscoveryAppetite(value: number): number {
  return Math.max(0.25, Math.min(0.8, Number(value.toFixed(2))))
}

function buildDiscoveryAppetite(): number {
  const feedback = listTrackFeedback(200)
  const totals = feedback.reduce(
    (acc, item) => ({
      plays: acc.plays + item.playCount,
      skips: acc.skips + item.skipCount,
      loops: acc.loops + item.loopCount,
      favorites: acc.favorites + item.favoriteCount,
      completion: acc.completion + (item.lastCompletion ?? 0),
      completionCount: acc.completionCount + (typeof item.lastCompletion === 'number' ? 1 : 0),
    }),
    { plays: 0, skips: 0, loops: 0, favorites: 0, completion: 0, completionCount: 0 },
  )
  const signalCount = totals.plays + totals.skips + totals.loops + totals.favorites
  if (signalCount < 8) return 0.5

  const skipRate = totals.skips / Math.max(1, totals.plays + totals.skips)
  const strongAffinityRate = (totals.loops + totals.favorites) / Math.max(1, signalCount)
  const completionAvg = totals.completionCount > 0 ? totals.completion / totals.completionCount : 0.65
  const settledListeningPenalty = completionAvg >= 0.82 ? 0.04 : 0
  return clampDiscoveryAppetite(0.5 + skipRate * 0.32 - strongAffinityRate * 0.18 - settledListeningPenalty)
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
  const topArtistNames = topArtists.map((artist) => artist.name)
  const topGenreNames = topGenres.map((genre) => genre.name)
  const display = buildProfileDisplay(context, signatureTracks, topArtists, topGenres, moods)
  const profile: TasteProfile = {
    genres: topGenres,
    artists: topArtists,
    moods,
    era_preference: Object.fromEntries(Array.from(context.eraCounts.entries()).map(([era, count]) => [era, clamp(count / totalEra)])),
    discovery_appetite: buildDiscoveryAppetite(),
    anti_patterns: [] as string[],
    signature_tracks: signatureTracks,
    display,
    echo_portrait: previous?.echo_portrait ?? buildFallbackPortrait(topArtistNames, topGenreNames, signatureTracks),
    work_summary: previous?.work_summary,
    profile_meta: {
      ...(previous?.profile_meta ?? {}),
      structuredUpdatedAt: new Date().toISOString(),
      updatedAt: previous?.profile_meta?.updatedAt ?? new Date().toISOString(),
      signalCount: getFeedbackSignalCount(),
    },
  }

  return profile
}

function evidenceFromNote(note?: string): EvidenceNote {
  if (hasLegacyProfileNote(note)) return { text: '来自导入歌单的稳定坐标。', evidenceLevel: 'weak', source: 'imported' }
  if (!note) return { text: '还在观察', evidenceLevel: 'weak', source: 'fallback' }
  if (note.includes('收藏')) return { text: note, evidenceLevel: 'strong', source: 'favorite' }
  if (note.includes('循环')) return { text: note, evidenceLevel: 'strong', source: 'loop' }
  if (note.includes('完整听过') || note.includes('播放') || note.includes('跳过')) return { text: note, evidenceLevel: 'strong', source: 'played' }
  if (note.includes('场景') || note.includes('时常') || note.includes('接上')) return { text: note, evidenceLevel: 'strong', source: 'scene' }
  if (note.includes('导入')) return { text: note, evidenceLevel: 'weak', source: 'imported' }
  if (note.includes('线索') || note.includes('安全区')) return { text: note, evidenceLevel: 'medium', source: 'semantic' }
  return { text: note, evidenceLevel: 'weak', source: 'fallback' }
}

function buildFallbackDisplay(profile: TasteProfile): ProfileDisplayModel {
  return {
    signatureItems: profile.signature_tracks.slice(0, 7).map((track) => {
      const evidence = evidenceFromNote(track.reason)
      return {
        track: { ...track, reason: evidence.text },
        note: evidence.text,
        evidenceLevel: evidence.evidenceLevel,
        source: evidence.source,
      }
    }),
    genreItems: profile.genres.map((genre) => {
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
    moodItems: profile.moods.slice(0, 6).map((mood) => ({
      tag: mood.tag,
      frequency: mood.frequency,
      evidenceLevel: mood.frequency >= 0.18 ? 'medium' : 'weak',
      source: 'semantic',
    })),
  }
}

function ensureProfileDisplay(profile: TasteProfile | null): TasteProfile | null {
  if (!profile) return null
  const display = profile.display
  const hasLegacyDisplayNote = Boolean(display?.signatureItems.some((item) => hasLegacyProfileNote(item.note ?? item.track.reason)) || display?.artistItems.some((item) => hasLegacyProfileNote(item.note)))
  if (display?.signatureItems && display.genreItems && display.artistItems && display.moodItems && !hasLegacyDisplayNote) return profile
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

function buildRecentMusicIntentTrend(): string {
  const today = summarizeMusicIntentMessages(loadTodayConversations(80))
  const recent = summarizeMusicIntentMessages(loadRecentConversations(160))
  if (today.total === 0 && recent.total === 0) {
    return [
      '近期找歌/聊天意图不足,画像以播放、收藏、切歌和长期偏好为主。',
      '写 portrait 时可以坦诚还在观察,避免写成稳定结论。',
    ].join('\n')
  }
  return [
    `今日找歌方向: ${today.labels.join('、') || '暂无明显方向'}`,
    `近期找歌方向: ${recent.labels.join('、') || '暂无明显方向'}`,
    '这些趋势来自用户原话和推荐意图解析,已转成结构化证据。写 portrait 时用人的状态和变化来表达,避免直接写次数、占比、标签名。',
  ].join('\n')
}

function trackLabel(track: Track): string {
  return `《${track.title}》-${track.artist}`
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
    artists.push(event.track.artist)
    const semantic = semanticForWindowTrack(event.track, semanticByKey)
    genres.push(...semantic.genres.map((genre) => normalizedGenre(genre, semantic.language)))
    moods.push(...semantic.moods)
    if (event.queueStatus === 'completed') completed += 1
    if (event.queueStatus === 'skipped') skipped += 1
  }
  return { artists, genres, moods, tracks: events.map((event) => event.track), completed, skipped }
}

function buildRelationshipContext(profile: TasteProfile): string {
  const settings = getSettings()
  const firstUsedAt = settings.meta.firstUsedAt
  const date = new Date(firstUsedAt)
  if (Number.isNaN(date.getTime())) return '(首次使用时间未知)'
  const days = Math.max(1, Math.ceil((Date.now() - date.getTime()) / 86400000))
  const yinyiCount = getYinyiRange(500).length
  const hasWrittenPortrait = (profile.profile_meta?.portraitSignalCount ?? 0) > 0 || profile.profile_meta?.updatedAt != null
  if (days <= 3) return `你刚认识用户 — 才第 ${days} 天。这是第一次写画像,坦诚"我只看到了粗线条"。`
  if (days <= 14) return `你认识用户 ${days} 天了,${hasWrittenPortrait ? '至少写过一版' : '还没写过'}画像。还处在"慢慢认识"的阶段。`
  if (days <= 60) return `你们已经相处 ${days} 天,${yinyiCount > 0 ? `写过 ${yinyiCount} 篇风信` : '还在熟悉中'}。你应该开始看到一些稳定的模式了。`
  return `你已经陪用户 ${days} 天了,${yinyiCount > 0 ? `${yinyiCount} 篇风信` : ''}。你看着用户的口味在变,应该有能力写出有分量的观察。`
}

function buildMusicRoleSummary(): string {
  const feedback = listTrackFeedback(200)
  if (feedback.length < 3) return '(行为数据还太少,无法判断音乐角色)'
  const totalPlays = feedback.reduce((sum, item) => sum + item.playCount, 0)
  const totalSkips = feedback.reduce((sum, item) => sum + item.skipCount, 0)
  const totalLoops = feedback.reduce((sum, item) => sum + item.loopCount, 0)
  const totalFavorites = feedback.reduce((sum, item) => sum + item.favoriteCount, 0)
  const totalEncounters = totalPlays + totalSkips
  const skipRate = totalEncounters > 0 ? totalSkips / totalEncounters : 0
  const loopRate = totalPlays > 0 ? totalLoops / totalPlays : 0
  const favoriteRate = totalPlays > 0 ? totalFavorites / totalPlays : 0
  const events = loadProfileTrackEvents(200)
  const nightEvents = events.filter((event) => {
    const hour = new Date(event.listenedAt).getHours()
    return hour >= 22 || hour < 5
  })
  const nightRatio = events.length > 0 ? nightEvents.length / events.length : 0

  const signals: string[] = []
  if (skipRate > 0.35) signals.push('高频切歌(切歌率 ' + Math.round(skipRate * 100) + '%),总在找"对的那首"')
  if (loopRate > 0.15) signals.push('循环很多(循环率 ' + Math.round(loopRate * 100) + '%),会回到同一首歌')
  if (nightRatio > 0.45) signals.push('深夜集中听(夜间占比 ' + Math.round(nightRatio * 100) + '%)')
  if (favoriteRate > 0.2) signals.push('收藏率高(' + Math.round(favoriteRate * 100) + '%),会主动标记喜欢的歌')
  if (signals.length === 0) signals.push('播放行为比较均匀,没有极端的倾向')

  if (skipRate > 0.35 && loopRate > 0.15) return signals.join('; ') + '。音乐对用户来说既是挑剔的陪伴,也是安全区。'
  if (skipRate > 0.35) return signals.join('; ') + '。音乐对用户来说是挑剔的陪伴——总在找刚好对的那首。'
  if (loopRate > 0.15) return signals.join('; ') + '。音乐是用户的安全区——会回到同一首歌,像回到一个熟悉的地方。'
  if (nightRatio > 0.45) return signals.join('; ') + '。用户用音乐消化深夜的情绪。'
  return signals.join('; ') + '。'
}

const LOW_MOOD_SIGNALS = ['sad', 'melancholic', '忧郁', '伤感', '孤独', '失眠', '疲惫', '沉思', '怀旧', '孤独感']
const HIGH_MOOD_SIGNALS = ['energetic', 'upbeat', '欢快', '激昂', '热血', '有劲', '活力', '振奋', '阳光', '嗨']
const CALM_MOOD_SIGNALS = ['calm', 'relaxing', '舒缓', '放松', '治愈', '温柔', '轻柔', '安静', '平静', '冥想']

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
    .map((item) => `${trackLabel(item.track)}(play:${item.playCount}, skip:${item.skipCount}, loop:${item.loopCount}, fav:${item.favoriteCount})`)
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
    `近 7 天播放事件: ${recentEvents.length}; 近 7 天更新反馈: ${recentFeedback.length}`,
    `recent artists: ${topCountLabels(windowSignals.artists, 5)}`,
    `recent genres: ${topCountLabels(windowSignals.genres, 4)}`,
    `recent moods: ${topCountLabels(windowSignals.moods, 5)}`,
    `recent status: completed ${windowSignals.completed}, skipped ${windowSignals.skipped}`,
    `recent tracks: ${tracks}`,
    `recent feedback: ${feedbackSignals}`,
    `anti patterns: ${profile.anti_patterns.slice(0, 6).join('、') || '暂无'}`,
  ].join('\n')
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
${buildRelationshipContext(profile)}
</relationship>

<music_role>
${buildMusicRoleSummary()}
</music_role>

<mood_trend>
${buildMoodTrendSignal(profile, semanticByKey, semantics.length)}
</mood_trend>

<recent_music_intent_trend>
${buildRecentMusicIntentTrend()}
</recent_music_intent_trend>

<current_profile>
${JSON.stringify(profile, null, 2)}
</current_profile>

${buildMemoryEvidencePrompt(profile, { includeAudit: true })}

<last_portrait>
${profile.echo_portrait}
</last_portrait>

<this_week_signals>
${buildThisWeekSignals(profile, semanticByKey)}
</this_week_signals>

<this_month_signals>
${buildThisMonthSignals(profile, semanticByKey)}
</this_month_signals>

<echo_should_ask>
${buildEchoShouldAsk(profile)}
</echo_should_ask>

<kpop_undetermined>
${buildKpopUndetermined(profile)}
</kpop_undetermined>

<recent_yinyi_summaries>
${buildRecentYinyiSummaries()}
</recent_yinyi_summaries>

请严格返回 JSON,字段只包含 portrait、summary、suggested_questions。portrait 100-120 字。直接对用户说“你”,像熟悉的人写的一段观察。内部证据可以藏在表达背后,不要写成报告。`
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
    ...listTrackFeedback(300)
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
  if (/(根据数据|画像显示|轨迹表明|从占比看|数据|占比|画像|算法|标签|模型|用户|profile|mood|energy|tempo|play:|skip:|fav:|\d+%)/i.test(portrait)) {
    issues.push('把内部证据直接写给用户了')
  }
  if (/(分寸感|续航感|底色|光谱|底韵|往里收|接住你|稳稳的|太满|太猛|上头|燃爆)/.test(portrait)) issues.push('出现禁用表达')
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
  return /没有返回 portrait|需要直接对用户|把内部证据直接写给用户|出现禁用表达|可能是编造的/.test(issue)
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

export async function buildInitialProfile(tracks: Track[]): Promise<TasteProfile> {
  const base = buildProfileFromTracks(tracks)
  base.profile_meta = {
    ...(base.profile_meta ?? {}),
    refreshReason: 'import',
    updatedAt: new Date().toISOString(),
    structuredUpdatedAt: new Date().toISOString(),
    signalCount: getFeedbackSignalCount(),
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

function mergeIncrementalSignals(rebuilt: TasteProfile, previous: TasteProfile | null): TasteProfile {
  if (!previous) return rebuilt
  const rebuiltAntiSet = new Set(rebuilt.anti_patterns)
  for (const pattern of previous.anti_patterns) {
    if (!rebuiltAntiSet.has(pattern)) rebuilt.anti_patterns.push(pattern)
  }
  const rebuiltSigKeys = new Set(rebuilt.signature_tracks.map((t) => `${t.title}::${t.artist}`))
  for (const track of previous.signature_tracks) {
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
  if (previous.scenes) rebuilt.scenes = previous.scenes
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
  }
  return next
}

export function maybeRefreshStructuredProfile(reason = 'signal'): TasteProfile | null {
  const profile = getTasteProfile()
  if (!profile) return refreshStructuredProfile(reason)
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
  const profile = ensureProfileDisplay((refreshStructured ? buildStructuredProfileDraft('portrait') : null) ?? getTasteProfile())
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
        structuredUpdatedAt: profile.profile_meta?.structuredUpdatedAt ?? new Date().toISOString(),
        portraitSignalCount: getFeedbackSignalCount(),
      },
    }
    saveTasteProfile(next, finalParsed.summary ?? finalParsed.portrait)
    for (const question of finalParsed.suggested_questions ?? []) {
      if (question.content) addTasteQuestion(question.kind ?? 'observation', question.content, question.context ?? {})
    }
    return next
  } catch (error) {
    assertPortraitActive(options.signal)
    if (options.fallbackOnError) return profile
    if (error instanceof LlmError && error.kind === 'config') {
      throw new PortraitRegenerationError('模型配置还没准备好，画像文案没有刷新。')
    }
    if (error instanceof Error) throw error
    throw new PortraitRegenerationError('画像文案刷新失败。')
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
}

export async function applySignal(kind: string, payload: Record<string, unknown>): Promise<TasteProfile | null> {
  const profile = ensureProfileDisplay(getTasteProfile() ?? buildProfileFromTracks(getAllImportedTracks()))
  if (!profile) return null
  const target = String(payload.target ?? payload.artist ?? payload.genre ?? payload.vibe ?? '').trim()
  const strength = typeof payload.strength === 'number' ? clamp(payload.strength) : 0.2

  if (!target && !kind.startsWith('event_')) return saveTasteProfile({ ...profile, display: profile.display ?? buildFallbackDisplay(profile) }, profile.echo_portrait)

  const rawTrackId = payload.trackId ?? payload.neteaseId
  const trackLookup = {
    title: String(payload.title ?? ''),
    artist: String(payload.artist ?? target ?? ''),
    id: rawTrackId != null ? String(rawTrackId) : undefined,
  }
  const semantic = (trackLookup.title && trackLookup.artist) ? getTrackSemantic(trackLookup) : null

  if (kind === 'like_artist') {
    const existing = profile.artists.find((artist) => artist.name === target)
    if (existing) existing.affinity = clamp(existing.affinity + strength)
    else profile.artists.unshift({ name: target, affinity: clamp(0.5 + strength), notes: String(payload.note ?? '用户在对话中提到喜欢') })
    if (semantic) applySemanticBoost(profile, semantic, 0.07, 3)
  }

  if (kind === 'unlike_artist') {
    const existing = profile.artists.find((artist) => artist.name === target)
    if (existing) existing.affinity = clamp(existing.affinity - strength)
    if (!profile.anti_patterns.includes(target)) profile.anti_patterns.push(target)
    shiftDiscoveryAppetite(profile, 0.04)
  }

  if (kind === 'like_genre') {
    const existing = profile.genres.find((genre) => genre.name === target)
    if (existing) {
      existing.weight = clamp(existing.weight + strength)
      existing.trend = 'up'
    } else {
      profile.genres.unshift({ name: target, weight: clamp(0.4 + strength), trend: 'up' })
    }
  }

  if (kind === 'unlike_genre') {
    const existing = profile.genres.find((genre) => genre.name === target)
    if (existing) {
      existing.weight = clamp(existing.weight - strength)
      existing.trend = 'down'
    }
    if (!profile.anti_patterns.includes(target)) profile.anti_patterns.push(target)
    shiftDiscoveryAppetite(profile, 0.04)
  }

  if (kind === 'reinforce_vibe' && target) {
    profile.moods.unshift({ tag: target, frequency: clamp(0.5 + strength), signature_artists: profile.artists.slice(0, 3).map((artist) => artist.name) })
    profile.moods = profile.moods.slice(0, 10)
  }

  if (kind === 'unlike_vibe' && target) {
    const existing = profile.moods.find((mood) => mood.tag === target)
    if (existing) existing.frequency = clamp(existing.frequency - Math.max(0.04, strength))
    if (!profile.anti_patterns.includes(target)) profile.anti_patterns.push(target)
    shiftDiscoveryAppetite(profile, 0.04)
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
      if (title) {
        const marker = `跳过:${title}`
        if (!profile.anti_patterns.includes(marker)) profile.anti_patterns.push(marker)
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
    if (artist) {
      const existing = profile.artists.find((item) => item.name === artist)
      if (existing) {
        existing.affinity = clamp(existing.affinity + strength)
        existing.notes = `刚收藏过 ${String(payload.title ?? '一首歌')}`
      } else {
        profile.artists.unshift({ name: artist, affinity: clamp(0.6 + strength), notes: '刚收藏过' })
      }
    }
    const title = String(payload.title ?? '').trim()
    if (title) {
      const existingTrack = profile.signature_tracks.find((track) => track.title === title && track.artist === artist)
      if (!existingTrack) {
        profile.signature_tracks = [
          {
            title,
            artist,
            source: 'favorite',
            reason: '你主动收藏过，Echo 会把它当作更强的口味信号。',
          },
          ...profile.signature_tracks,
        ].slice(0, 10)
      }
    }
    if (semantic) applySemanticBoost(profile, semantic, Math.max(0.05, strength), 4)
    shiftDiscoveryAppetite(profile, -0.03)
  }

  if (kind === 'event_started' || kind === 'correct_assumption') {
    getDb()
      .prepare('INSERT INTO events (user_id, kind, content, confidence, weight, started_at) VALUES (current_user_id(), ?, ?, ?, ?, CURRENT_TIMESTAMP)')
      .run(kind === 'event_started' ? 'context' : 'correction', target || String(payload.note ?? '用户修正了 Echo 的判断'), 0.7, 0.8)
    if (kind === 'correct_assumption') clearRecommendationCache()
  }

  if (kind === 'event_ended') {
    getDb()
      .prepare(
        `UPDATE events
         SET expected_end_at = CURRENT_TIMESTAMP, weight = 0.1
         WHERE user_id = current_user_id() AND content LIKE ? AND expected_end_at IS NULL`,
      )
      .run(`%${target}%`)
  }

  profile.artists = profile.artists.sort((a, b) => b.affinity - a.affinity).slice(0, 12)
  profile.genres = profile.genres.sort((a, b) => b.weight - a.weight).slice(0, 12)
  profile.display = buildFallbackDisplay(profile)
  return saveTasteProfile(profile, profile.echo_portrait)
}

export async function answerQuestion(id: number, answer: string): Promise<{ ok: boolean }> {
  saveTasteQuestionAnswer(id, answer)
  return { ok: true }
}
