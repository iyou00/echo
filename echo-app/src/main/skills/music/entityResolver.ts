import { createRequire } from 'node:module'
import { readNeteaseCookie } from '../../netease/auth'
import { normalizeText, unique } from './identity'

const require = createRequire(import.meta.url)
const netease = require('@neteasecloudmusicapienhanced/api') as Record<string, (query: Record<string, unknown>) => Promise<ApiResponse>>

type ApiResponse = {
  body?: Record<string, unknown>
}

export type MusicEntityKind = 'artist' | 'title'
export type MusicEntitySource = 'rules' | 'llm' | 'memory' | 'netease'
export type MusicEntityAmbiguity = 'none' | 'artist_or_title' | 'missing_artist' | 'too_vague'

export interface MusicEntity {
  kind: MusicEntityKind
  text: string
  sourceSpan: string
  confidence: number
  source: MusicEntitySource
}

export interface MusicEntityResolution {
  artistQuery?: string
  seedTitle?: string
  targetCount?: number
  requestedCount?: number
  explicitCount: boolean
  verifiedArtistId?: string
  verifiedArtistName?: string
  verifiedTrackId?: string
  verifiedTrackTitle?: string
  verificationStatus?: 'not_needed' | 'verified' | 'unverified' | 'auth_required' | 'canceled'
  entities: MusicEntity[]
  ambiguity: MusicEntityAmbiguity
  confidence: number
  source: MusicEntitySource
}

const MAX_ENTITY_COUNT = 5
const ARTIST_ALIASES: Record<string, string> = {
  魔力红: 'Maroon 5',
  maroon5: 'Maroon 5',
  maroon: 'Maroon 5',
}

const ACTION_PREFIX_PATTERN = /^(?:我)?(?:想听|想要听|要听|我要听|我想听|播放|放一下|放首|放一首|放点|推|推荐|给我|帮我|找首|找一首|来一首|来点|点播)\s*/i
const ASSERTIVE_PREFIX_PATTERN = /^(?:的)?(?:是|就是)\s*/i
const COUNT_PREFIX_PATTERN = /^(?:(?:\d{1,2}|[一二两三四五六七八九十两几])\s*首\s*)/i
const GENERIC_TITLE_WORDS = new Set(['歌', '歌曲', '音乐', '作品', '那首', '这首', '一首', '几首', '来一首', '来几首'])
const IMPLAUSIBLE_ARTIST_TERMS = /是|最|很|挺|特别|温暖|相遇|拥抱|听|想|要|播放|放|推荐|适合|值得|天气|心情|感觉|舒缓|缓和|轻柔|安静|放松|激昂|热血|澎湃|带感|节奏|国外|外国|欧美|英文|粤语|华语|日语|韩语/

export function parseMusicRequestCount(text: string): { requestedCount: number; targetCount: number; overLimit: boolean; explicit: boolean } {
  const lower = text.toLowerCase()
  const arabic = lower.match(/(?:来|推|推荐|放|听|给我)?\s*(\d{1,2})\s*首/)
  const chineseDigits: Record<string, number> = {
    一: 1,
    两: 2,
    二: 2,
    三: 3,
    四: 4,
    五: 5,
    六: 6,
    七: 7,
    八: 8,
    九: 9,
    十: 10,
  }
  function parseChineseCount(value: string): number {
    if (value === '十') return 10
    if (value.startsWith('十')) return 10 + (chineseDigits[value[1]] ?? 0)
    if (value.endsWith('十')) return (chineseDigits[value[0]] ?? 1) * 10
    const tenIndex = value.indexOf('十')
    if (tenIndex >= 0) return (chineseDigits[value.slice(0, tenIndex)] ?? 1) * 10 + (chineseDigits[value.slice(tenIndex + 1)] ?? 0)
    return chineseDigits[value] ?? 1
  }
  const chinese = lower.match(/(?:来|推|推荐|放|听|给我)?\s*([一二两三四五六七八九十]{1,3})\s*首/)
  const vagueSeveral = /几\s*首/.test(lower)
  const requestedCount = arabic
    ? Number(arabic[1])
    : chinese?.[1]
      ? parseChineseCount(chinese[1])
      : vagueSeveral
        ? 3
        : 1
  return {
    requestedCount,
    targetCount: Math.max(1, Math.min(MAX_ENTITY_COUNT, requestedCount)),
    overLimit: requestedCount > MAX_ENTITY_COUNT,
    explicit: Boolean(arabic || chinese || vagueSeveral),
  }
}

export function normalizeMusicArtistName(value: string): string {
  const trimmed = value
    .replace(ACTION_PREFIX_PATTERN, '')
    .replace(ASSERTIVE_PREFIX_PATTERN, '')
    .replace(COUNT_PREFIX_PATTERN, '')
    .replace(/(?:的)?(?:歌|歌曲|音乐|作品|那种|那类|这种|来一首|来几首|一首|几首).*$/i, '')
    .replace(/[，。！？?！,.]/g, '')
    .trim()
  if (!trimmed) return ''
  const compact = normalizeText(trimmed)
  return ARTIST_ALIASES[compact] ?? ARTIST_ALIASES[trimmed.toLowerCase().replace(/\s+/g, '')] ?? trimmed
}

export function normalizeMusicTitle(value: string): string {
  return value
    .replace(/[，。！？?！,.].*$/, '')
    .replace(/^(?:的|那首|这首|一首)\s*/, '')
    .replace(/(?:这首|这歌|这个歌|这个首歌|这首歌|这首歌曲|这首作品|这个作品|这首音乐|这个音乐|这个曲子|这首曲子).*$/i, '')
    .trim()
}

function usableSongTitle(value: string): string | undefined {
  const title = normalizeMusicTitle(value)
  if (!title) return undefined
  const genericCandidate = normalizeText(title.replace(/[吧吗呢呀啊呗啦咯喽]$/i, ''))
  if (GENERIC_TITLE_WORDS.has(genericCandidate)) return undefined
  if (/的?(歌|歌曲|音乐|作品)$/.test(title)) return undefined
  if (title.length > 40) return undefined
  return title
}

function isPlausibleArtistName(value: string): boolean {
  const artist = normalizeText(value)
  if (!artist) return false
  if (artist.length > 24) return false
  if (IMPLAUSIBLE_ARTIST_TERMS.test(value)) return false
  return true
}

function entity(kind: MusicEntityKind, text: string, sourceSpan: string, confidence: number): MusicEntity {
  return { kind, text, sourceSpan, confidence, source: 'rules' }
}

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {}
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

function assertEntityResolverActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('任务已取消', 'AbortError')
}

function timed<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
  return new Promise((resolve) => {
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

function artistNames(raw: Record<string, unknown>): string[] {
  return asArray(raw.ar ?? raw.artists)
    .map((artist) => String(asObject(artist).name ?? ''))
    .filter(Boolean)
}

function normalizedIncludes(left: string, right: string): boolean {
  const a = normalizeText(left)
  const b = normalizeText(right)
  return Boolean(a && b && (a.includes(b) || b.includes(a)))
}

function editDistance(left: string, right: string): number {
  const a = normalizeText(left)
  const b = normalizeText(right)
  if (!a) return b.length
  if (!b) return a.length
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  const current = Array.from({ length: b.length + 1 }, () => 0)
  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      current[j] = Math.min(
        current[j - 1] + 1,
        previous[j] + 1,
        previous[j - 1] + cost,
      )
    }
    previous.splice(0, previous.length, ...current)
  }
  return previous[b.length]
}

function normalizedArtistMatches(left: string, right: string): boolean {
  if (normalizedIncludes(left, right)) return true
  const maxLength = Math.max(normalizeText(left).length, normalizeText(right).length)
  if (maxLength < 5) return false
  return editDistance(left, right) <= Math.max(1, Math.floor(maxLength * 0.16))
}

function extractArtistMatches(response: ApiResponse, artistQuery: string): Array<{ id: string; name: string; score: number }> {
  const artists = asArray(asObject(response.body?.result).artists).map(asObject)
  return artists
    .map((artist) => {
      const name = String(artist.name ?? '')
      const id = String(artist.id ?? '')
      const aliasHit = asArray(artist.alias).some((item) => normalizedArtistMatches(String(item), artistQuery))
      const score = normalizeText(name) === normalizeText(artistQuery)
        ? 1
        : normalizedArtistMatches(name, artistQuery)
          ? 0.92
          : aliasHit
            ? 0.86
            : 0
      return { id, name, score }
    })
    .filter((item) => item.id && item.name && item.score > 0)
    .sort((a, b) => b.score - a.score)
}

function extractTrackMatches(response: ApiResponse, seedTitle: string, artistQuery?: string): Array<{ id: string; title: string; artist?: string; score: number }> {
  const songs = asArray(asObject(response.body?.result).songs).map(asObject)
  return songs
    .map((song) => {
      const title = String(song.name ?? '')
      const id = String(song.id ?? '')
      const artists = artistNames(song)
      const titleScore = normalizeText(title) === normalizeText(seedTitle)
        ? 1
        : normalizedIncludes(title, seedTitle)
          ? 0.9
          : 0
      const artistMatched = artistQuery
        ? artists.some((artist) => normalizedArtistMatches(artist, artistQuery))
        : false
      const artistScore = artistQuery
        ? artistMatched
          ? 0.12
          : -0.35
        : 0
      return { id, title, artist: artists.join(' / ') || undefined, score: titleScore + artistScore, artistMatched }
    })
    .filter((item) => item.id && item.title && item.score >= (artistQuery ? 1 : 0.8))
    .sort((a, b) => b.score - a.score)
}

function addArtist(entities: MusicEntity[], sourceSpan: string, confidence: number): string | undefined {
  const artist = normalizeMusicArtistName(sourceSpan)
  if (!isPlausibleArtistName(artist)) return undefined
  entities.push(entity('artist', artist, sourceSpan.trim(), confidence))
  return artist
}

function addTitle(entities: MusicEntity[], sourceSpan: string, confidence: number): string | undefined {
  const title = usableSongTitle(sourceSpan)
  if (!title) return undefined
  entities.push(entity('title', title, sourceSpan.trim(), confidence))
  return title
}

export function resolveMusicEntitiesFromText(text: string): MusicEntityResolution {
  const trimmed = text.trim()
  const entities: MusicEntity[] = []
  const count = parseMusicRequestCount(trimmed)
  let artistQuery: string | undefined
  let seedTitle: string | undefined
  let ambiguity: MusicEntityAmbiguity = 'none'

  const quoted = trimmed.match(/《([^》]{1,40})》/)
  if (quoted?.[1]) {
    seedTitle = addTitle(entities, quoted[1], 0.96)
    const prefix = trimmed.slice(0, quoted.index).replace(ACTION_PREFIX_PATTERN, '').trim()
    if (prefix) artistQuery = addArtist(entities, prefix.replace(/的$/, ''), 0.9)
  }

  if (!seedTitle) {
    const pair = trimmed.match(/(?:我)?(?:想听|想要听|要听|我要听|我想听|播放|放|放首|放一首|找首|找一首|来一首|点播)\s*(?:的)?(?:是|就是)?\s*([^《》，。！？?！,.]{1,24})的([^《》，。！？?！,.]{1,40})/i)
    if (pair) {
      const artist = addArtist(entities, pair[1] ?? '', 0.9)
      const title = addTitle(entities, pair[2] ?? '', 0.88)
      artistQuery = artistQuery ?? artist
      seedTitle = seedTitle ?? title
    }
  }

  if (!seedTitle) {
    const preferencePair = trimmed.match(/([^《》，。！？?！,.]{1,24})的([^《》，。！？?！,.]{1,40}?)(?:这首|这歌|这个歌|这个首歌|这首歌|这首歌曲|这首作品|这个作品|这首音乐|这个音乐|这个曲子|这首曲子)/i)
    if (preferencePair) {
      const artist = addArtist(entities, preferencePair[1] ?? '', 0.84)
      const title = addTitle(entities, preferencePair[2] ?? '', 0.84)
      artistQuery = artistQuery ?? artist
      seedTitle = seedTitle ?? title
    }
  }

  if (!artistQuery) {
    const alias = Object.entries(ARTIST_ALIASES).find(([key]) => normalizeText(trimmed).includes(key))
    if (alias) {
      artistQuery = alias[1]
      entities.push(entity('artist', alias[1], alias[0], 0.94))
    }
  }

  if (!artistQuery) {
    const artistPatterns = [
      /(?:想听|来一首|来点|放首|放点|推|推荐|给我|帮我|找首|找一首)\s*(?:(?:\d{1,2}|[一二两三四五六七八九十两几])\s*首\s*)?([A-Za-z0-9 .&'’\-\u4e00-\u9fa5]{1,32}?)(?:的)?(?:歌|歌曲|音乐|作品)/i,
      /([A-Za-z0-9 .&'’\-\u4e00-\u9fa5]{1,32}?)(?:的)?(?:歌|歌曲|音乐|作品)(?:来一首|来几首|一首|几首)?/i,
      /(?:想听|想要听|要听|我要听|我想听|听|播放|放|放首|放一首|来一首|来点|推|推荐|给我|帮我|找首|找一首)\s*(?:一首|几首|[一二两三四五六七八九十两几]\s*首|\d{1,2}\s*首)?\s*([A-Za-z0-9 .&'’\-\u4e00-\u9fa5]{1,32}?)(?:的)?(?:热门|经典|代表作|流行|出名|有名|火一点|火的|好听)(?:的)?(?:歌|歌曲|音乐|作品)?/i,
      /([A-Za-z0-9 .&'’-]{2,32})\s*(?:那种|那类|这种)/i,
    ]
    for (const pattern of artistPatterns) {
      const match = trimmed.match(pattern)
      const artist = addArtist(entities, match?.[1] ?? '', 0.86)
      if (artist) {
        artistQuery = artist
        break
      }
    }
  }

  if (!seedTitle) {
    const titleOnly = trimmed.match(/(?:我)?(?:想听|想要听|要听|我要听|我想听|播放|放|放首|放一首|找首|找一首|来一首|点播)\s*([^《》，。！？?！,.]{1,40})/i)
    const title = addTitle(entities, titleOnly?.[1] ?? '', artistQuery ? 0.62 : 0.78)
    if (title && !artistQuery) {
      seedTitle = title
      ambiguity = title.length <= 6 ? 'artist_or_title' : 'missing_artist'
    }
  }

  const uniqueEntities = unique(entities.map((item) => `${item.kind}:${normalizeText(item.text)}`))
    .map((key) => entities.find((item) => `${item.kind}:${normalizeText(item.text)}` === key))
    .filter((item): item is MusicEntity => Boolean(item))
  const confidence = uniqueEntities.length
    ? Math.min(0.98, uniqueEntities.reduce((sum, item) => sum + item.confidence, 0) / uniqueEntities.length)
    : 0

  return {
    artistQuery,
    seedTitle,
    targetCount: count.targetCount,
    requestedCount: count.requestedCount,
    explicitCount: count.explicit,
    entities: uniqueEntities,
    ambiguity,
    confidence,
    source: 'rules',
  }
}

export interface MusicEntityVerificationOptions {
  signal?: AbortSignal
  timeoutMs?: number
}

export async function verifyMusicEntitiesWithNetease(
  resolution: MusicEntityResolution,
  options: MusicEntityVerificationOptions = {},
): Promise<MusicEntityResolution> {
  assertEntityResolverActive(options.signal)
  if (!resolution.artistQuery && !resolution.seedTitle) {
    return { ...resolution, verificationStatus: 'not_needed' }
  }

  const cookie = readNeteaseCookie()
  if (!cookie) return { ...resolution, verificationStatus: 'auth_required' }

  const timeoutMs = options.timeoutMs ?? 4500
  let verifiedArtistId: string | undefined
  let verifiedArtistName: string | undefined
  let verifiedTrackId: string | undefined
  let verifiedTrackTitle: string | undefined

  if (resolution.artistQuery) {
    const artistSearch = await timed(
      netease.cloudsearch({ keywords: resolution.artistQuery, type: 100, limit: 3, offset: 0, cookie }),
      timeoutMs,
      null as ApiResponse | null,
    )
    assertEntityResolverActive(options.signal)
    const artistMatch = artistSearch ? extractArtistMatches(artistSearch, resolution.artistQuery)[0] : undefined
    if (artistMatch) {
      verifiedArtistId = artistMatch.id
      verifiedArtistName = artistMatch.name
    }
  }

  if (resolution.seedTitle) {
    const keywords = [resolution.seedTitle, verifiedArtistName ?? resolution.artistQuery ?? ''].filter(Boolean).join(' ')
    const songSearch = await timed(
      netease.cloudsearch({ keywords, type: 1, limit: 8, offset: 0, cookie }),
      timeoutMs,
      null as ApiResponse | null,
    )
    assertEntityResolverActive(options.signal)
    const trackMatch = songSearch ? extractTrackMatches(songSearch, resolution.seedTitle, verifiedArtistName ?? resolution.artistQuery)[0] : undefined
    if (trackMatch) {
      verifiedTrackId = trackMatch.id
      verifiedTrackTitle = trackMatch.title
      if (!verifiedArtistName && trackMatch.artist) verifiedArtistName = trackMatch.artist.split('/')[0]?.trim()
    }
  }

  const verified = Boolean(
    (resolution.artistQuery && verifiedArtistName)
    || (resolution.seedTitle && verifiedTrackTitle),
  )
  return {
    ...resolution,
    artistQuery: verifiedArtistName ?? resolution.artistQuery,
    seedTitle: verifiedTrackTitle ?? resolution.seedTitle,
    verifiedArtistId,
    verifiedArtistName,
    verifiedTrackId,
    verifiedTrackTitle,
    verificationStatus: verified ? 'verified' : 'unverified',
    confidence: verified ? Math.max(resolution.confidence, 0.94) : Math.min(resolution.confidence, 0.72),
    source: verified ? 'netease' : resolution.source,
  }
}
