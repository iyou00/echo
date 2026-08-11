import { createRequire } from 'node:module'
import type { RecommendationSource, TasteProfile, Track } from '../../../types/ipc'
import { getAllImportedTracks } from '../../db/playlists'
import { listSemantics } from '../../db/semantics'
import { getTasteProfile } from '../../db/taste'
import { listFavorites } from '../favorites'
import { loadRecentRecommendedTracks } from '../../db/tracks'
import { titleMatchesConstraint } from '../../skills/music/verifier'
import { asArray, asObject, normalizeNeteaseTrack } from '../../netease/music'
import { readNeteaseCookie } from '../../netease/auth'
import {
  GENERIC_GENRE_KEYWORDS,
  GENERIC_MOOD_KEYWORDS,
  type RecommendationIntent,
} from './intent'
import { normalizeText, unique, uniqueTracks } from './text'
import { NeteaseAuthRequiredError } from './errors'
import { allowsArtistFromCorrection, buildRecommendationMemoryConstraints } from './memoryConstraints'
import { createRecommendationDeterminismContext, stableInt, stableShuffle, type RecommendationDeterminismContext } from './deterministic'
import { inferTrackSemanticFallback } from '../semantics'
import {
  musicLanguageGenre,
  musicLanguageSearchTerms,
  stripMusicLanguageCues,
  type MusicLanguage,
} from './language'

const require = createRequire(import.meta.url)
const netease = require('@neteasecloudmusicapienhanced/api') as Record<string, (query: Record<string, unknown>) => Promise<ApiResponse>>

type ApiResponse = {
  body?: Record<string, unknown>
}

export interface RecommendationRecallContext {
  profile?: TasteProfile | null
  similarityReference?: Track
  similarityArtistQuery?: string
  similarityArtistId?: string
}

const NET_CALL_TIMEOUT_MS = 6000
const FETCH_CANDIDATES_TIMEOUT_MS = 9000

function assertRecallActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('任务已取消', 'AbortError')
}

function timed<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise<T>((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms)
    promise
      .then((value) => {
        clearTimeout(timer)
        resolve(value)
      })
      .catch(() => {
        clearTimeout(timer)
        resolve(fallback)
      })
  })
}

function withSource(track: Track | null, source: RecommendationSource): Track | null {
  return track ? { ...track, source: 'netease', recommendSource: source } : null
}

function extractTracks(response: ApiResponse, source: RecommendationSource): Track[] {
  const body = asObject(response.body)
  const data = body.data
  const result = asObject(body.result)
  const candidates = [
    ...asArray(asObject(data).dailySongs),
    ...asArray(asObject(data).list),
    ...asArray(data),
    ...asArray(body.recommend),
    ...asArray(body.songs),
    ...asArray(result.songs),
    ...asArray(result),
  ]
  return candidates.map((item) => withSource(normalizeNeteaseTrack(item), source)).filter((track): track is Track => Boolean(track))
}

function extractArtistIds(response: ApiResponse): string[] {
  const result = asObject(response.body?.result)
  return asArray(result.artists)
    .map((artist) => String(asObject(artist).id ?? ''))
    .filter(Boolean)
    .slice(0, 3)
}

function extractSimilarArtistIds(response: ApiResponse, excludedId?: string): string[] {
  const body = asObject(response.body)
  const result = asObject(body.result)
  const data = asObject(body.data)
  return unique([
    ...asArray(body.artists),
    ...asArray(result.artists),
    ...asArray(data.artists),
  ]
    .map((artist) => String(asObject(artist).id ?? ''))
    .filter((id) => Boolean(id) && id !== excludedId))
    .slice(0, 6)
}

export const recommendationRecallTestHelpers = {
  extractSimilarArtistIds,
  buildLanguageSearchQueries,
  compactIntentQuery,
  keywordFromIntent,
}

function extractPlaylistIds(response: ApiResponse): string[] {
  const result = asObject(response.body?.result)
  return asArray(result.playlists)
    .map((playlist) => String(asObject(playlist).id ?? ''))
    .filter(Boolean)
    .slice(0, 2)
}

function extractTopPlaylistIds(response: ApiResponse, limit: number): string[] {
  const body = asObject(response.body)
  const result = asObject(body.result)
  return [
    ...asArray(body.playlists),
    ...asArray(result.playlists),
    ...asArray(asObject(body.data).playlists),
  ]
    .map((playlist) => String(asObject(playlist).id ?? ''))
    .filter(Boolean)
    .slice(0, limit)
}

function shuffleItems<T>(items: T[], seed: string): T[] {
  return stableShuffle(items, seed, (item) => String(item))
}

function profileForRecall(context: RecommendationRecallContext): TasteProfile | null {
  return context.profile ?? getTasteProfile()
}

function pickWeightedKeywords(determinism: RecommendationDeterminismContext, context: RecommendationRecallContext): string[] {
  const profile = profileForRecall(context)
  const semanticTracks = listSemantics()
  const pool: string[] = []
  const { daySeed } = determinism

  const moodKeywords = (profile?.moods ?? []).flatMap((mood) => GENERIC_MOOD_KEYWORDS[mood.tag] ?? [mood.tag])
  const profileSeed = [
    ...(profile?.moods ?? []).map((mood) => `${mood.tag}:${mood.frequency}`),
    ...(profile?.genres ?? []).map((genre) => `${genre.name}:${genre.weight}`),
  ].join('|') || 'empty-profile'
  const shuffledMoods = shuffleItems(unique(moodKeywords), `${daySeed}:profile:moods:${profileSeed}`)
  pool.push(...shuffledMoods.slice(0, 3))

  const genreKeywords = (profile?.genres ?? []).flatMap((genre) => GENERIC_GENRE_KEYWORDS[genre.name] ?? [genre.name])
  const shuffledGenres = shuffleItems(unique(genreKeywords), `${daySeed}:profile:genres:${profileSeed}`)
  pool.push(...shuffledGenres.slice(0, 3))

  const semanticMoodCounts = new Map<string, number>()
  const semanticGenreCounts = new Map<string, number>()
  for (const track of semanticTracks) {
    for (const mood of track.semantic.moods) semanticMoodCounts.set(mood, (semanticMoodCounts.get(mood) ?? 0) + 1)
    for (const genre of track.semantic.genres) semanticGenreCounts.set(genre, (semanticGenreCounts.get(genre) ?? 0) + 1)
  }
  const semanticMoodKeywords = Array.from(semanticMoodCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .flatMap(([mood]) => GENERIC_MOOD_KEYWORDS[mood] ?? [mood])
  pool.push(...shuffleItems(unique(semanticMoodKeywords), `${daySeed}:semantic:moods:${semanticMoodKeywords.join('|')}`).slice(0, 2))
  const semanticGenreKeywords = Array.from(semanticGenreCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .flatMap(([genre]) => GENERIC_GENRE_KEYWORDS[genre] ?? [genre])
  pool.push(...shuffleItems(unique(semanticGenreKeywords), `${daySeed}:semantic:genres:${semanticGenreKeywords.join('|')}`).slice(0, 2))

  return unique(pool)
}

function sceneKeyword(intent: RecommendationIntent, determinism: RecommendationDeterminismContext, context: RecommendationRecallContext): string {
  switch (intent.sceneKey) {
    case 'focus':
      return '安静 轻音乐 舒缓'
    case 'sleepy':
      return '提神 节奏 轻快'
    case 'relax':
      return '放松 舒缓 治愈'
    case 'irritated':
      return '放松 降噪 舒缓'
    case 'random': {
      const profile = pickWeightedKeywords(determinism, context)
      const picked = shuffleItems(profile, `${determinism.daySeed}:scene:random:${profile.join('|')}`).slice(0, 3)
      return picked.join(' ') || '华语流行'
    }
    default:
      return ''
  }
}

function compactIntentQuery(query: string): string {
  return stripMusicLanguageCues(query)
    .replace(/(?:适合|合适|贴合|配|根据|按照|按|结合|对应|应景)?(?:今天|今日|现在|当前|当地|外面|这边)?(?:的)?(?:天气|气温|温度)(?:情况)?/gi, ' ')
    .replace(/(?:帮我|给我|我要|我想|想要|想听|要听|播放|推荐|推|挑|选|来|找|放|整|安排|搞|弄)(?:一首|几首|\d+首|点|些)?/g, ' ')
    .replace(/歌曲|音乐|作品|曲子|单曲|歌单|歌/g, ' ')
    .replace(/(?:^|\s)(?:的|呢|吗|吧|呀|啊)(?=\s|$)/g, ' ')
    .replace(/[，。！？,.!?、:：;；“”"'‘’（）()《》]/g, ' ')
    .replace(/(?:^|\s)(?:的|呢|吗|吧|呀|啊)(?=\s|$)/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function languageMoodHint(intent: RecommendationIntent): string {
  if (intent.moods.includes('轻快')) return '轻快'
  if (intent.moods.includes('治愈')) return '治愈'
  if (intent.moods.includes('放松') || intent.tempo === 'slow') return '舒缓'
  if (intent.moods.includes('清醒') || intent.energy === 'high') return '节奏'
  return ''
}

function buildLanguageSearchQueries(intent: RecommendationIntent): string[] {
  const terms = musicLanguageSearchTerms(intent.language)
  if (terms.length === 0 || intent.seedTitle || intent.artistQuery) return []
  const mood = languageMoodHint(intent)
  return unique([
    ...terms,
    ...(mood ? terms.slice(0, 2).map((term) => `${term} ${mood}`) : []),
  ]).slice(0, 5)
}

function keywordFromIntent(intent: RecommendationIntent, determinism: RecommendationDeterminismContext, context: RecommendationRecallContext): string {
  if (intent.seedTitle) {
    return unique([intent.seedTitle, intent.artistQuery ?? ''].filter(Boolean)).join(' ')
  }
  const languageKeyword = musicLanguageSearchTerms(intent.language)[0] ?? ''
  const parts = [
    sceneKeyword(intent, determinism, context),
    context.similarityArtistQuery ?? '',
    intent.artistQuery ?? '',
    languageKeyword,
    intent.moods.includes('放松') || intent.tempo === 'slow' ? '慢歌' : '',
    intent.moods.includes('清醒') || intent.energy === 'high' ? '激昂 节奏 热血' : '',
    intent.scenes.includes('雨天') ? '雨天' : '',
    intent.scenes.includes('夜晚') || intent.scenes.includes('睡前') ? '夜晚' : '',
    compactIntentQuery(intent.query),
  ].filter(Boolean)
  return parts.join(' ') || '华语流行'
}

function styleTagId(intent: RecommendationIntent): number | null {
  const joined = `${intent.language ?? ''} ${intent.query}`.toLowerCase()
  return styleTagIdFromText(joined)
}

function styleTagIdFromText(text: string): number | null {
  const joined = text.toLowerCase()
  if (/r&b/.test(joined)) return 1002
  if (/说唱|rap|hip/.test(joined)) return 1001
  if (/摇滚|rock/.test(joined)) return 1000
  if (/民谣|folk/.test(joined)) return 1006
  if (/电子|edm/.test(joined)) return 1007
  return null
}

function scenePlaylistCategories(intent: RecommendationIntent, determinism: RecommendationDeterminismContext, context: RecommendationRecallContext): string[] {
  switch (intent.sceneKey) {
    case 'focus':
      return ['工作', '学习', '安静', '轻音乐']
    case 'sleepy':
      return ['兴奋', '快乐', '运动', '流行']
    case 'relax':
      return ['放松', '治愈', '下午茶', '清新']
    case 'irritated':
      return ['安静', '放松', '治愈', '轻音乐']
    case 'random': {
      const profile = pickWeightedKeywords(determinism, context)
      const categoryHints = profile.filter((keyword) => /流行|民谣|电子|说唱|摇滚|爵士|轻快|治愈|放松|清新|怀旧|安静/.test(keyword))
      return unique([...categoryHints, '流行', '清新', '治愈']).slice(0, 4)
    }
    default:
      return []
  }
}

function genericDiscoveryKeywords(determinism: RecommendationDeterminismContext, context: RecommendationRecallContext): string[] {
  const profileKeywords = pickWeightedKeywords(determinism, context).filter((keyword) => keyword.trim().length > 0)
  const fallback = ['华语流行', '轻快 流行', '治愈 华语', '舒服 华语']
  return unique([...profileKeywords, ...fallback]).slice(0, 8)
}

async function fetchScenePlaylistCandidates(intent: RecommendationIntent, cookie: string, determinism: RecommendationDeterminismContext, context: RecommendationRecallContext, signal?: AbortSignal): Promise<Track[]> {
  const categories = shuffleItems(scenePlaylistCategories(intent, determinism, context), `${determinism.daySeed}:scene-categories:${intent.query}:${intent.sceneKey ?? ''}`).slice(0, 3)
  if (categories.length === 0) return []
  const playlistIds: string[] = []

  for (const cat of categories) {
    assertRecallActive(signal)
    const offset = stableInt(`${determinism.daySeed}:scene-playlist-offset:${intent.query}:${cat}`, 3) * 6
    const response = await timed(
      netease.top_playlist({ cat, order: 'hot', limit: 6, offset, cookie }),
      NET_CALL_TIMEOUT_MS,
      null as ApiResponse | null,
    )
    assertRecallActive(signal)
    if (response) playlistIds.push(...extractTopPlaylistIds(response, 3))
  }

  const uniquePlaylistIds = unique(playlistIds).slice(0, 5)
  const groups = await Promise.all(uniquePlaylistIds.map(async (id) => {
    assertRecallActive(signal)
    const detail = await timed(
      netease.playlist_track_all({ id, limit: 24, offset: 0, cookie }),
      NET_CALL_TIMEOUT_MS,
      null as ApiResponse | null,
    )
    assertRecallActive(signal)
    return detail ? extractTracks(detail, 'playlist') : []
  }))
  assertRecallActive(signal)
  return uniqueTracks(groups.flat()).slice(0, 120)
}

export async function fetchGenericDiscoveryCandidates(intent: RecommendationIntent, signal?: AbortSignal, determinism = createRecommendationDeterminismContext(), context: RecommendationRecallContext = {}): Promise<Track[]> {
  assertRecallActive(signal)
  const cookie = readNeteaseCookie()
  if (!cookie) throw new NeteaseAuthRequiredError()
  const { daySeed } = determinism
  const keywords = shuffleItems(genericDiscoveryKeywords(determinism, context), `${daySeed}:generic-keywords:${intent.query}:${intent.targetCount}`).slice(0, Math.max(3, Math.min(5, intent.targetCount + 3)))
  const calls: Array<Promise<Track[]>> = []

  for (const keyword of keywords) {
    const offset = stableInt(`${daySeed}:generic-search-offset:${intent.query}:${keyword}`, 4) * 10
    calls.push(netCall(netease.cloudsearch({ keywords: keyword, type: 1, limit: 30, offset, cookie }), 'search'))
    const tagId = styleTagIdFromText(keyword)
    if (tagId) calls.push(netCall(netease.style_song({ tagId, size: 20, cursor: stableInt(`${daySeed}:generic-style-cursor:${intent.query}:${keyword}:${tagId}`, 3) * 20, cookie }), 'style'))
  }

  if (calls.length === 0) calls.push(netCall(netease.personalized_newsong({ limit: 30, cookie }), 'new_song'))

  const groups = await Promise.all(calls)
  assertRecallActive(signal)
  return uniqueTracks(groups.flat()).slice(0, 160)
}

function importedSeedTracks(intent: RecommendationIntent): Track[] {
  const imported = getAllImportedTracks()
  const favorites = listFavorites()
  const recommended = loadRecentRecommendedTracks(100)

  const localPool = [...favorites, ...recommended, ...imported]

  if (intent.seedTitle) {
    const seed = localPool.find((track) => {
      const titleMatch = titleMatchesConstraint(track.title, intent.seedTitle, false)
      const artistMatch = intent.artistQuery
        ? normalizeText(track.artist).includes(normalizeText(intent.artistQuery))
        : true
      return titleMatch && artistMatch
    })
    if (seed) return [seed]
  }
  const semantic = listSemantics()
    .filter((track) => intent.moods.some((mood) => track.semantic.moods.includes(mood)) || intent.scenes.some((scene) => track.semantic.scenes.includes(scene)))
    .slice(0, Math.max(4, intent.targetCount))
  return [...semantic, ...imported].filter((track) => track.id || track.neteaseId).slice(0, Math.max(3, intent.targetCount))
}

function profileArtistQueries(intent: RecommendationIntent, context: RecommendationRecallContext): string[] {
  const profile = profileForRecall(context)
  const constraints = buildRecommendationMemoryConstraints(profile)
  const semanticArtists = listSemantics()
    .filter((track) => intent.moods.some((mood) => track.semantic.moods.includes(mood)) || intent.scenes.some((scene) => track.semantic.scenes.includes(scene)))
    .map((track) => track.artist)
  const profileArtists = profile?.artists.slice(0, 6).map((artist) => artist.name) ?? []
  return unique([
    context.similarityReference?.artist ?? '',
    intent.artistQuery ?? '',
    ...semanticArtists,
    ...profileArtists,
  ].filter(Boolean))
    .filter((artist) => allowsArtistFromCorrection(artist, intent, constraints))
    .slice(0, 5)
}

async function fetchSimilarArtistCandidates(
  cookie: string,
  context: RecommendationRecallContext,
  signal?: AbortSignal,
): Promise<Track[]> {
  if (!context.similarityArtistQuery) return []
  let referenceArtistId = context.similarityArtistId
  if (!referenceArtistId) {
    const search = await timed(
      netease.cloudsearch({ keywords: context.similarityArtistQuery, type: 100, limit: 3, offset: 0, cookie }),
      3000,
      null as ApiResponse | null,
    )
    assertRecallActive(signal)
    referenceArtistId = search ? extractArtistIds(search)[0] : undefined
  }
  if (!referenceArtistId) return []
  const similar = await timed(
    netease.simi_artist({ id: referenceArtistId, cookie }),
    3000,
    null as ApiResponse | null,
  )
  assertRecallActive(signal)
  if (!similar) return []
  const relatedIds = extractSimilarArtistIds(similar, referenceArtistId)
  const topSongCalls = relatedIds.map(async (id) => {
    const topSongs = await timed(
      netease.artist_top_song({ id, cookie }),
      3500,
      null as ApiResponse | null,
    )
    assertRecallActive(signal)
    return topSongs ? extractTracks(topSongs, 'artist') : []
  })
  return uniqueTracks((await Promise.all(topSongCalls)).flat())
}

async function fetchArtistCandidates(intent: RecommendationIntent, cookie: string, context: RecommendationRecallContext, signal?: AbortSignal): Promise<Track[]> {
  const artistSearches = profileArtistQueries(intent, context).map(async (artist) => {
    assertRecallActive(signal)
    const search = await timed(
      netease.cloudsearch({ keywords: artist, type: 100, limit: 3, offset: 0, cookie }),
      NET_CALL_TIMEOUT_MS,
      null as ApiResponse | null,
    )
    assertRecallActive(signal)
    return search ? extractArtistIds(search) : []
  })
  const artistIds = unique((await Promise.all(artistSearches)).flat()).slice(0, 8)
  assertRecallActive(signal)
  const topSongCalls = artistIds.map(async (id) => {
    assertRecallActive(signal)
    const topSongs = await timed(
      netease.artist_top_song({ id, cookie }),
      NET_CALL_TIMEOUT_MS,
      null as ApiResponse | null,
    )
    assertRecallActive(signal)
    return topSongs ? extractTracks(topSongs, 'artist') : []
  })
  return uniqueTracks((await Promise.all(topSongCalls)).flat())
}

async function fetchPlaylistCandidates(intent: RecommendationIntent, cookie: string, determinism: RecommendationDeterminismContext, context: RecommendationRecallContext, signal?: AbortSignal): Promise<Track[]> {
  const keywords = `${keywordFromIntent(intent, determinism, context)} 歌单`.trim()
  const playlistOffset = stableInt(`${determinism.daySeed}:playlist-offset:${intent.query}:${keywords}`, 3) * 5
  assertRecallActive(signal)
  const search = await timed(
    netease.cloudsearch({ keywords, type: 1000, limit: 5, offset: playlistOffset, cookie }),
    NET_CALL_TIMEOUT_MS,
    null as ApiResponse | null,
  )
  assertRecallActive(signal)
  if (!search) return []
  const detailCalls = extractPlaylistIds(search).map(async (id) => {
    assertRecallActive(signal)
    const detail = await timed(
      netease.playlist_track_all({ id, limit: 24, offset: 0, cookie }),
      NET_CALL_TIMEOUT_MS,
      null as ApiResponse | null,
    )
    assertRecallActive(signal)
    return detail ? extractTracks(detail, 'playlist') : []
  })
  return uniqueTracks((await Promise.all(detailCalls)).flat())
}

function netCall(promise: Promise<ApiResponse>, source: RecommendationSource): Promise<Track[]> {
  return timed(promise, NET_CALL_TIMEOUT_MS, null as ApiResponse | null)
    .then((res) => (res ? extractTracks(res, source) : []))
    .catch(() => [])
}

function withLanguageRecallEvidence(track: Track, language: MusicLanguage): Track {
  const semantic = track.semantic ?? inferTrackSemanticFallback(track)
  const genre = musicLanguageGenre(language)
  return {
    ...track,
    semantic: {
      ...semantic,
      language,
      genres: unique([...(genre ? [genre] : []), ...semantic.genres]).slice(0, 3),
      confidence: Math.max(semantic.confidence, 0.62),
    },
  }
}

function languageSearchCalls(intent: RecommendationIntent, cookie: string): Array<Promise<Track[]>> {
  if (!intent.language) return []
  const language = intent.language as MusicLanguage
  return buildLanguageSearchQueries(intent).map((keywords) => (
    netCall(netease.cloudsearch({ keywords, type: 1, limit: 30, offset: 0, cookie }), 'search')
      .then((tracks) => tracks.map((track) => withLanguageRecallEvidence(track, language)))
  ))
}

async function fetchCandidatesInternal(intent: RecommendationIntent, signal?: AbortSignal, determinism = createRecommendationDeterminismContext(), context: RecommendationRecallContext = {}): Promise<Track[]> {
  assertRecallActive(signal)
  const cookie = readNeteaseCookie()
  if (!cookie) throw new NeteaseAuthRequiredError()
  const candidates: Track[] = []

  const keyword = keywordFromIntent(intent, determinism, context)
  const searchOffset = stableInt(`${determinism.daySeed}:search-offset:${intent.query}:${keyword}`, 4) * 10
  const sceneCalls = intent.sceneKey
    ? [timed(fetchScenePlaylistCandidates(intent, cookie, determinism, context, signal), NET_CALL_TIMEOUT_MS + 5000, [] as Track[])]
    : []
  const personalizedCalls = intent.sceneKey
    ? []
    : [
        netCall(netease.recommend_songs({ cookie }), 'daily'),
        netCall(netease.personal_fm({ cookie }), 'fm'),
      ]
  const calls: Array<Promise<Track[]>> = [
    ...languageSearchCalls(intent, cookie),
    ...sceneCalls,
    ...(intent.seedTitle ? [netCall(netease.cloudsearch({ keywords: keyword, type: 1, limit: 10, offset: 0, cookie }), 'search')] : []),
    ...personalizedCalls,
    netCall(netease.cloudsearch({ keywords: keyword, type: 1, limit: 30, offset: searchOffset, cookie }), 'search'),
    netCall(netease.personalized_newsong({ limit: 20, cookie }), 'new_song'),
    timed(fetchArtistCandidates(intent, cookie, context, signal), NET_CALL_TIMEOUT_MS + 2000, [] as Track[]),
    timed(fetchSimilarArtistCandidates(cookie, context, signal), NET_CALL_TIMEOUT_MS + 2000, [] as Track[]),
    timed(fetchPlaylistCandidates(intent, cookie, determinism, context, signal), NET_CALL_TIMEOUT_MS + 2000, [] as Track[]),
  ]

  const tagId = styleTagId(intent)
  if (tagId) {
    calls.push(netCall(netease.style_song({ tagId, size: 20, cursor: 0, cookie }), 'style'))
  }

  const similaritySeeds = context.similarityReference ? [context.similarityReference] : importedSeedTracks(intent)
  for (const seed of similaritySeeds) {
    const id = seed.neteaseId ?? seed.id
    if (id) calls.push(netCall(netease.simi_song({ id, limit: 20, offset: 0, cookie }), 'similar'))
  }

  const groups = await Promise.all(calls)
  assertRecallActive(signal)
  for (const group of groups) candidates.push(...group)
  if (intent.seedTitle) {
    candidates.unshift(...importedSeedTracks(intent))
  }
  return uniqueTracks(candidates).slice(0, 120)
}

export async function fetchCandidates(intent: RecommendationIntent, signal?: AbortSignal, determinism = createRecommendationDeterminismContext(), context: RecommendationRecallContext = {}): Promise<Track[]> {
  let authError: NeteaseAuthRequiredError | null = null
  const wrapped = fetchCandidatesInternal(intent, signal, determinism, context).catch((error) => {
    if (error instanceof NeteaseAuthRequiredError) {
      authError = error
    }
    return [] as Track[]
  })
  const result = await timed(wrapped, FETCH_CANDIDATES_TIMEOUT_MS, [] as Track[])
  assertRecallActive(signal)
  if (authError) throw authError
  return result
}
