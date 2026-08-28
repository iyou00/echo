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

  // —— 第一优先：LLM 生成的 searchQuery ——
  // 路由器已将用户的情绪/场景翻译为搜索友好的关键词，直接消费
  if (intent.searchQuery && intent.searchQuery.trim().length >= 2) {
    return unique([intent.searchQuery.trim(), languageKeyword].filter(Boolean)).join(' ')
  }

  // —— 第二优先：硬编码情绪→关键词映射（LLM 失败时的兜底） ——
  // 同时检查 intent.moods（被 ALLOWED_MOODS 过滤）和 intent.query（用户原话）
  const moodKeywords = moodSearchKeywords(intent)

  // 如果情绪关键词已命中，不再拼入用户原话——原话里的情绪表述
  // （"当心情烦躁的时候"）对搜索引擎是噪音，会稀释匹配
  const rawTextFallback = moodKeywords.length > 0
    ? ''
    : compactIntentQuery(intent.query)

  const parts = [
    sceneKeyword(intent, determinism, context),
    context.similarityArtistQuery ?? '',
    intent.artistQuery ?? '',
    languageKeyword,
    ...moodKeywords,
    intent.scenes.includes('雨天') ? '雨天' : '',
    intent.scenes.includes('夜晚') || intent.scenes.includes('睡前') ? '夜晚' : '',
    rawTextFallback,
  ].filter(Boolean)
  return parts.join(' ') || '华语流行'
}

/**
 * 情绪 → 搜索关键词映射（兜底层，LLM 的 searchQuery 优先消费）。
 * 覆盖 ALLOWED_MOODS 词表中的全部 10 个情绪 + 常见负面/复合情绪表达。
 * 返回去重后的关键词组（最多 2 组，避免搜索词过长稀释匹配）。
 */
function moodSearchKeywords(intent: RecommendationIntent): string[] {
  const keywords: string[] = []
  // 同时搜索 moods（结构化标签）和 query（用户原话）——
  // LLM 路由器可能把「烦躁」放进 moods 但 ALLOWED_MOODS 过滤掉了，
  // 但原始 query 文本里始终有这个词
  const haystack = `${intent.moods.join(' ')} ${intent.query}`
  const has = (pattern: RegExp) => pattern.test(haystack)

  // —— 正向情绪（ALLOWED_MOODS 中的 10 个全覆盖） ——
  if (intent.moods.includes('放松') || intent.moods.includes('松弛') || intent.tempo === 'slow') {
    keywords.push('慢歌 舒缓')
  }
  if (intent.moods.includes('清醒') || intent.moods.includes('热烈') || intent.energy === 'high') {
    keywords.push('激昂 节奏 热血')
  }
  if (has(/轻快/)) keywords.push('轻快 活力')
  if (has(/治愈/)) keywords.push('治愈 温暖')
  if (has(/怀旧/)) keywords.push('经典 老歌')
  if (has(/陪伴/)) keywords.push('日常 轻松')
  if (has(/孤独/)) keywords.push('深夜 舒缓')
  if (has(/发呆/)) keywords.push('轻音乐 氛围')

  // —— 负面情绪（用户想要的是对应的舒缓/宣泄，不是搜「烦躁」） ——
  if (has(/烦躁|焦虑|压力大|生气|郁闷|压抑|烦(?!躁)/)) keywords.push('安静 舒缓 轻音乐')
  if (has(/难过|伤心|低落|想哭|哭泣|哭(?!泣)/)) keywords.push('治愈 温暖 轻柔')
  if (has(/孤独|寂寞|空虚|一个人/)) keywords.push('陪伴 轻松 日常')
  if (has(/累|疲惫|困(?!难)|没精神|没力气/)) keywords.push('提神 轻快 活力')
  if (has(/愤怒|气愤|火大|暴躁/)) keywords.push('宣泄 摇滚 节奏')

  // —— 场景衍生 ——
  if (intent.scenes.includes('运动') || intent.scenes.includes('通勤')) keywords.push('节奏 动感')
  if (intent.scenes.includes('午休') || intent.scenes.includes('独处')) keywords.push('安静 氛围')

  return unique(keywords).slice(0, 2)
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

/** 本地库按歌手找歌：导入的、收藏的、听过的——不需要网络 */
export function localLibraryArtistTracks(artistQuery: string, targetCount: number, pool?: Track[]): Track[] {
  const searchPool = pool ?? uniqueTracks([...listFavorites(), ...loadRecentRecommendedTracks(100), ...getAllImportedTracks()])
  const needle = normalizeText(artistQuery)
  if (!needle) return []
  const matched = searchPool.filter((track) => {
    const artist = normalizeText(track.artist)
    return artist.includes(needle) || needle.includes(artist)
  })
  // 按 publishedAt/year 降序——「最新歌曲」的语义尽量满足
  return matched
    .sort((a, b) => {
      const aTime = a.publishedAt ?? (a.year ? String(a.year) : '')
      const bTime = b.publishedAt ?? (b.year ? String(b.year) : '')
      return bTime.localeCompare(aTime)
    })
    .slice(0, Math.max(targetCount, 5))
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
      intent.ranking === 'default'
        ? netease.artist_top_song({ id, cookie })
        : netease.artist_songs({
            id,
            order: intent.ranking === 'latest' ? 'time' : 'hot',
            limit: Math.max(30, intent.targetCount * 4),
            offset: 0,
            cookie,
          }),
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

  // —— 本地库优先（artist_request 场景）——
  // 用户点名要某个歌手时，先查本地（导入/收藏/听过的），本地有就直接用。
  // 云端搜索是补充，不是唯一来源——陈默之在本地有歌但云端搜索偶发失败时，
  // 不应该整条链路报废。
  if (intent.artistQuery) {
    const localArtistTracks = localLibraryArtistTracks(intent.artistQuery, intent.targetCount)
    if (localArtistTracks.length >= Math.min(intent.targetCount, 2)) {
      candidates.push(...localArtistTracks)
    }
  }

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
    ...(intent.artistQuery ? [timed(fetchArtistCandidates(intent, cookie, context, signal), NET_CALL_TIMEOUT_MS + 2000, [] as Track[])] : []),
    ...languageSearchCalls(intent, cookie),
    ...sceneCalls,
    ...(intent.seedTitle ? [netCall(netease.cloudsearch({ keywords: keyword, type: 1, limit: 10, offset: 0, cookie }), 'search')] : []),
    ...personalizedCalls,
    netCall(netease.cloudsearch({ keywords: keyword, type: 1, limit: 30, offset: searchOffset, cookie }), 'search'),
    netCall(netease.personalized_newsong({ limit: 20, cookie }), 'new_song'),
    ...(!intent.artistQuery ? [timed(fetchArtistCandidates(intent, cookie, context, signal), NET_CALL_TIMEOUT_MS + 2000, [] as Track[])] : []),
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
