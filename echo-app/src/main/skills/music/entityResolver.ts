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

const ACTION_PREFIX_PATTERN = /^(?:我)?(?:想要听|我要听|我想听|想听|要听|听听看|听一下|播放|放一下|放一首|放首|放点|推荐|推|给我|帮我|找一首|找首|来一首|来点|点播|整一首|整首|整点|安排一首|安排首|安排点|搞一首|搞首|搞点|弄一首|弄首|弄点|安排|整|搞|弄)\s*/i
const ASSERTIVE_PREFIX_PATTERN = /^(?:的)?(?:是|就是)\s*/i
const COUNT_PREFIX_PATTERN = /^(?:(?:\d{1,2}|[一二两三四五六七八九十两几])\s*首\s*)/i
const GENERIC_TITLE_WORDS = new Set(['歌', '歌曲', '音乐', '作品', '那首', '这首', '一首', '几首', '来一首', '来几首'])
const GENERIC_TITLE_DETAIL_WORDS = new Set([
  ...GENERIC_TITLE_WORDS,
  '声音',
  '嗓音',
  '唱腔',
  '旋律',
  '歌词',
  '编曲',
  '风格',
  '气质',
  '氛围',
  '感觉',
  '味道',
  '歌声',
])
const IMPLAUSIBLE_ARTIST_TERMS = /是|最|很|挺|特别|温暖|相遇|拥抱|听|想|要|播放|放|推荐|适合|值得|天气|心情|感觉|类似|相似|像|好听|耐听|顺耳|入耳|对味|舒缓|缓和|轻柔|安静|放松|激昂|热血|澎湃|带感|节奏|国外|外国|欧美|英文|粤语|华语|日语|韩语|法语|德语|西班牙语|俄语|泰语|葡萄牙语|意大利语/
const SIMILARITY_PREFIX_PATTERN = /^(?:推荐|推|找|来|给我|帮我)?\s*(?:类似|像|相似于|相近于|和|跟)\s*/i
const CONTEXTUAL_TRACK_REFERENCE_PATTERN = /^(?:刚才|刚刚|当前|现在|上一首|这首|那首|这个|那个|这种|那种)(?:的)?(?:歌|歌曲|音乐|曲子)?$/i
const MUSIC_DESCRIPTOR_PART_PATTERN = /(?:欢快|轻快|开心|快乐|愉快|轻松|舒缓|放松|安静|温柔|治愈|热血|激昂|激情|高昂|提神|清醒|带感|动感|有劲|伤感|悲伤|难过|低落|孤独|怀旧|甜|梦幻|空灵|节奏感强|节奏|鼓点|慢歌|快歌|慢一点|快一点|慢|快|类型|风格|氛围|感觉|心情|情绪|儿歌|工作|学习|睡前|通勤|运动|粤语|英文|英语|欧美|韩语|日语|华语|法语|德语|西班牙语|俄语|泰语|葡萄牙语|意大利语|民谣|摇滚|说唱|电子|爵士|r&b|rnb)/gi
const MUSIC_DESCRIPTOR_FILLER_PATTERN = /(?:听听吧|歌曲|音乐|作品|给我|帮我|播放|推荐|想要|一首|几首|一点|一些|那种|这种|这个|其他|适合|可用|听听|听吧|我|找|来|推|放|听|想|要|[一二两三四五六七八九十两]|\d+|首|点|的|歌|给|吧|呀|啊|呢|呗|啦|咯)/gi

export function isMusicDescriptorPhrase(value: string): boolean {
  const normalized = normalizeText(value)
  if (!normalized) return false
  const remaining = normalized
    .replace(MUSIC_DESCRIPTOR_PART_PATTERN, '')
    .replace(MUSIC_DESCRIPTOR_FILLER_PATTERN, '')
  return remaining.length === 0
}

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
    .replace(/^(?:我)?(?:喜欢|爱听|蛮喜欢|挺喜欢|很喜欢|还蛮|常听|循环|不喜欢|不爱听|不太喜欢|不是很喜欢|没那么喜欢)\s*/i, '')
    .replace(ASSERTIVE_PREFIX_PATTERN, '')
    .replace(COUNT_PREFIX_PATTERN, '')
    .replace(/(?:的)?(?:歌|歌曲|音乐|作品|那种|那类|这种|来一首|来几首|一首|几首).*$/i, '')
    .replace(/(?:有哪些|哪些|有什么|有啥|哪几首)$/i, '')
    .replace(/[，。！？?！,.]/g, '')
    .replace(/(?:吧|呀|啊|呢|呗|啦|咯)$/i, '')
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

function usableSongTitle(value: string, allowDescriptor = false): string | undefined {
  const title = normalizeMusicTitle(value)
  if (!title) return undefined
  const genericCandidate = normalizeText(title.replace(/[吧吗呢呀啊呗啦咯喽]$/i, ''))
  if (GENERIC_TITLE_WORDS.has(genericCandidate)) return undefined
  if (CONTEXTUAL_TRACK_REFERENCE_PATTERN.test(title)) return undefined
  if (/的?(歌|歌曲|音乐|作品)$/.test(title)) return undefined
  if (!allowDescriptor && isMusicDescriptorPhrase(title)) return undefined
  if (title.length > 40) return undefined
  return title
}

function usablePreferenceSongTitle(value: string): string | undefined {
  const title = usableSongTitle(value)
  if (!title) return undefined
  const normalized = normalizeText(title.replace(/[吧吗呢呀啊呗啦咯喽]$/i, ''))
  if (GENERIC_TITLE_DETAIL_WORDS.has(normalized)) return undefined
  if (/^(?:声音|嗓音|唱腔|旋律|歌词|编曲|风格|气质|氛围|感觉|味道|歌声)(?:更|很|挺|比较|特别)?.*$/.test(title)) return undefined
  return title
}

function isPlausibleArtistName(value: string): boolean {
  const artist = normalizeText(value)
  if (!artist) return false
  if (artist.length > 24) return false
  if (IMPLAUSIBLE_ARTIST_TERMS.test(value)) return false
  if (isMusicDescriptorPhrase(value)) return false
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

function addTitle(entities: MusicEntity[], sourceSpan: string, confidence: number, allowDescriptor = false): string | undefined {
  const title = usableSongTitle(sourceSpan, allowDescriptor)
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
    seedTitle = addTitle(entities, quoted[1], 0.96, true)
    const prefix = trimmed.slice(0, quoted.index)
      .replace(ACTION_PREFIX_PATTERN, '')
      .replace(COUNT_PREFIX_PATTERN, '')
      .replace(SIMILARITY_PREFIX_PATTERN, '')
      .trim()
    if (prefix) artistQuery = addArtist(entities, prefix.replace(/的$/, ''), 0.9)
  }

  if (!seedTitle) {
    const similarTitlePatterns = [
      /(?:类似|像|相似于|相近于|和|跟)\s*([^《》，。！？?！,.]{1,40}?)(?:\s*(?:这首|这歌|这首歌|这首歌曲|这首曲子|这首音乐))(?:的)?(?:歌|歌曲|音乐)?/i,
      /(?:类似|像|相似于|相近于|和|跟)\s*([^《》，。！？?！,.]{1,40}?)(?:\s*(?:这样|这种|同类型|同风格|差不多|相近)(?:的)?(?:歌|歌曲|音乐))(?!手)/i,
      /(?:类似|像|相似于|相近于)\s*([^《》，。！？?！,.]{1,24}?)(?:的)?(?:歌|歌曲|音乐)(?!手)(?:推荐|来|找|听|推)?(?:下|一下)?$/i,
    ]
    for (const pattern of similarTitlePatterns) {
      const match = trimmed.match(pattern)
      const title = addTitle(entities, match?.[1] ?? '', 0.86)
      if (title) {
        seedTitle = title
        ambiguity = 'missing_artist'
        break
      }
    }
  }

  if (!seedTitle) {
    const pair = trimmed.match(/(?:我)?(?:想听|想要听|要听|我要听|我想听|播放|放|放首|放一首|找首|找一首|来一首|点播)\s*(?:的)?(?:是|就是)?\s*([^《》，。！？?！,.]{1,24})的([^《》，。！？?！,.]{1,40})/i)
    if (pair) {
      const artist = addArtist(entities, pair[1] ?? '', 0.9)
      const title = addTitle(entities, pair[2] ?? '', 0.88, true)
      artistQuery = artistQuery ?? artist
      seedTitle = seedTitle ?? title
    }
  }

  if (!seedTitle) {
    const preferencePair = trimmed.match(/([^《》，。！？?！,.]{1,24})的([^《》，。！？?！,.]{1,40}?)(?:这首|这歌|这个歌|这个首歌|这首歌|这首歌曲|这首作品|这个作品|这首音乐|这个音乐|这个曲子|这首曲子)/i)
    if (preferencePair) {
      const artist = addArtist(entities, preferencePair[1] ?? '', 0.84)
      const title = addTitle(entities, preferencePair[2] ?? '', 0.84, true)
      artistQuery = artistQuery ?? artist
      seedTitle = seedTitle ?? title
    }
  }

  if (!seedTitle) {
    const preferencePair = trimmed.match(/(?:喜欢|爱听|蛮喜欢|挺喜欢|很喜欢|还蛮|常听|循环|不喜欢|不爱听|不太喜欢|不是很喜欢|没那么喜欢|不好听|没感觉|听不下)\s*([^《》，。！？?！,.]{1,24})的([^《》，。！？?！,.]{1,24})(?:这首|这歌|这个歌|这首歌|这首歌曲|这首作品|这首音乐|这首曲子)?/i)
    if (preferencePair) {
      const artist = addArtist(entities, preferencePair[1] ?? '', 0.82)
      const title = usablePreferenceSongTitle(preferencePair[2] ?? '')
      if (title) {
        entities.push(entity('title', title, preferencePair[2]?.trim() ?? title, 0.82))
        artistQuery = artistQuery ?? artist
        seedTitle = title
      }
    }
  }

  if (!seedTitle) {
    const describedTitle = trimmed.match(/^(?:最近|最近的|听说|据说|网上说|短视频里)?\s*([^《》，。！？?！,.]{1,24}?)(?:这首|这歌|这个歌|这首歌|这首歌曲|这首音乐|这首曲子)(?:[^，。！？?！,.]{0,24})?[，。！？?！,.]?\s*(?:听听看|听一下|听听|试试|放一下|播放|能听)/i)
    const title = addTitle(entities, describedTitle?.[1] ?? '', 0.86)
    if (title) {
      seedTitle = title
      ambiguity = title.length <= 6 ? 'artist_or_title' : 'missing_artist'
    }
  }

  if (!artistQuery && !(seedTitle && /(?:类似|像|相似|相近|差不多|同款|同类型|同风格)/i.test(trimmed))) {
    const alias = Object.entries(ARTIST_ALIASES).find(([key]) => normalizeText(trimmed).includes(key))
    if (alias) {
      artistQuery = alias[1]
      entities.push(entity('artist', alias[1], alias[0], 0.94))
    }
  }

  if (!artistQuery && !(seedTitle && /(?:类似|像|相似|相近|差不多|同款|同类型|同风格)/i.test(trimmed))) {
    const artistPatterns = [
      /(?:想听|来一首|来点|放首|放点|推荐|推|给我|帮我|找一首|找首|整点|安排点|搞点|弄点|整一首|安排一首|搞一首|弄一首|整首|安排首|搞首|弄首)\s*(?:(?:\d{1,2}|[一二两三四五六七八九十两几])\s*首\s*)?([A-Za-z0-9 .&'’\-\u4e00-\u9fa5]{1,32}?)(?:的)?(?:歌|歌曲|音乐|作品)/i,
      /([A-Za-z0-9 .&'’\-\u4e00-\u9fa5]{1,32}?)(?:的)?(?:歌|歌曲|音乐|作品)(?:来一首|来几首|一首|几首)?/i,
      /(?:想听|想要听|要听|我要听|我想听|听|播放|放一首|放首|放|来一首|来点|推荐|推|给我|帮我|找一首|找首|整点|安排点|搞点|弄点|整一首|安排一首|搞一首|弄一首|整首|安排首|搞首|弄首)\s*(?:一首|几首|[一二两三四五六七八九十两几]\s*首|\d{1,2}\s*首)?\s*([A-Za-z0-9 .&'’\-\u4e00-\u9fa5]{1,32}?)(?:的)?(?:热门|经典|代表作|流行|出名|有名|火一点|火的|好听)(?:的)?(?:歌|歌曲|音乐|作品)?/i,
      /(?:整|安排|搞|弄)\s*(?:一首|首)\s*([A-Za-z0-9 .&'’\-\u4e00-\u9fa5]{1,32})(?:吧|呀|啊)?$/i,
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
    const titleOnly = trimmed.match(/(?:我)?(?:想听|想要听|要听|我要听|我想听|听听看|听一下|播放|放|放首|放一首|找首|找一首|来一首|点播)\s*([^《》，。！？?！,.]{1,40})/i)
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

export function hasExplicitSimilarityAnchor(text: string): boolean {
  if (!/(?:类似|像|相似|相近|差不多|同款|同类型|同风格)/i.test(text)) return false
  const resolution = resolveMusicEntitiesFromText(text)
  return Boolean(resolution.artistQuery || resolution.seedTitle)
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
    ambiguity: verifiedTrackTitle ? 'none' : resolution.ambiguity,
    confidence: verified ? Math.max(resolution.confidence, 0.94) : Math.min(resolution.confidence, 0.72),
    source: verified ? 'netease' : resolution.source,
  }
}
