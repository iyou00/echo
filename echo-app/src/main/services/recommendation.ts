import { createRequire } from 'node:module'
import type { RecommendationSource, SceneKey, TasteProfile, Track, TrackSemantic } from '../../types/ipc'
import { getAllImportedTracks } from '../db/playlists'
import { getRecommendationCache, setRecommendationCache } from '../db/recommendationCache'
import { getTrackSemantic, listSemantics, semanticTrackKey } from '../db/semantics'
import { loadListenedTracksSince, loadRecentRecommendedTracks } from '../db/tracks'
import { getFeedbackScore, listExplicitTrackFeedback } from '../db/feedback'
import { listFavoriteTracks } from '../db/favorites'
import { getTasteProfile } from '../db/taste'
import { getSettings } from '../db/settings'
import { completeChat } from '../llm/client'
import { asArray, asObject, filterPlayableTracks, normalizeNeteaseTrack } from '../netease/music'
import { readNeteaseCookie } from '../netease/auth'
import { inferTrackSemanticFallback } from './semantics'
import { sceneIntentOverride } from './scene'

const require = createRequire(import.meta.url)
const netease = require('@neteasecloudmusicapienhanced/api') as Record<string, (query: Record<string, unknown>) => Promise<ApiResponse>>

type ApiResponse = {
  body?: Record<string, unknown>
}

export class NeteaseAuthRequiredError extends Error {
  constructor(message = '请先登录网易云后再让 Echo 推荐歌。') {
    super(message)
    this.name = 'NeteaseAuthRequiredError'
  }
}

export interface RecommendationIntent {
  moods: string[]
  scenes: string[]
  language?: string
  energy?: 'low' | 'medium' | 'high'
  tempo?: TrackSemantic['tempo']
  familiarity: 'safe' | 'explore' | 'balanced'
  targetCount: number
  query: string
  seedTitle?: string
  artistQuery?: string
  intentConfidence?: number
  evidence?: string[]
  rejectIf?: IntentRejectIf
  sceneKey?: SceneKey
  source: 'rules' | 'llm' | 'hybrid'
}

/**
 * LLM 解析意图返回的结构。所有字段都可选，字段会先经过本地校验层再进入推荐链路。
 */
export interface IntentOverride {
  wantsMusic?: boolean
  language?: '华语' | '粤语' | '英语' | '韩语' | '日语'
  moods?: string[]
  scenes?: string[]
  energy?: 'low' | 'medium' | 'high'
  tempo?: 'slow' | 'medium' | 'fast'
  familiarity?: 'safe' | 'explore' | 'balanced'
  targetCount?: number
  seedTitle?: string
  artistQuery?: string
  intentConfidence?: number
  evidence?: string[]
  rejectIf?: IntentRejectIf
  sceneKey?: SceneKey
}

export interface RecommendationOptions {
  ignoreScene?: boolean
}

interface IntentRejectIf {
  minEnergy?: number
  maxEnergy?: number
  forbidTempo?: Array<TrackSemantic['tempo']>
  requireTempo?: Array<TrackSemantic['tempo']>
}

const ALLOWED_MOODS = new Set(['放松', '松弛', '清醒', '热烈', '轻快', '治愈', '怀旧', '孤独', '陪伴', '发呆'])
const ALLOWED_SCENES = new Set(['上午', '午休', '下午工作', '通勤', '下班路上', '夜晚', '睡前', '雨天', '独处', '运动'])
const ALLOWED_LANGUAGES = new Set(['华语', '粤语', '英语', '韩语', '日语'])
const ALLOWED_TEMPOS = new Set<TrackSemantic['tempo']>(['slow', 'medium', 'fast'])
const INTENT_LLM_TIMEOUT_MS = 4000
export const MAX_RECOMMENDATION_COUNT = 5
export const OVER_LIMIT_RECOMMENDATION_LINE = '歌不在多，慢慢听。我先给你挑 5 首。'
const HIGH_ENERGY_TERMS = ['激昂', '高昂', '亢奋', '振奋', '热血', '澎湃', '炸', '爆', '带感', '节奏感强', '节奏强', '有力量', '力量感', '鼓点', '动感', '燃', '提神', '清醒', '运动', '有劲']
const LOW_ENERGY_TERMS = ['慢', '困', '睡', '安静', '放松', '发呆', '舒缓', '缓和', '轻柔', '松弛', '平静']
const MUSIC_REQUEST_PATTERN = /推|推荐|来几首|来一首|听什么|听啥|值得听|适合听|想听|能听|放点|放首|来点|找首|找一首|给我.*歌|歌|曲|歌单|music|song/i
const GENERIC_DISCOVERY_PATTERN = /这个时候|现在|此刻|随便|随机|听点啥|听什么|有什么.*听|值得听|来首歌|来一首歌|放首歌|推首歌|推荐一首|来点音乐|听会儿歌|听会歌/i
const SPECIFIC_DISCOVERY_PATTERN = /《|》|像|类似|那种|那类|粤语|广东|英文|欧美|英语|english|外文|外语|国外|外国|韩语|韩国|韩文|kpop|k-pop|日语|日本|日文|j-pop|jpop|华语|中文|国语|激昂|高昂|亢奋|振奋|热血|澎湃|带感|节奏|鼓点|动感|燃|提神|清醒|欢快|开心|轻快|轻松|快歌|快的|快一点|快点|慢|困|累|睡|睡前|休息|安静|放松|舒缓|治愈|发呆|平静|emo|伤心|难过|孤独|想哭|r&b|说唱|rap|hip|摇滚|rock|民谣|folk|电子|edm/i
const ARTIST_ALIASES: Record<string, string> = {
  魔力红: 'Maroon 5',
  maroon5: 'Maroon 5',
  maroon: 'Maroon 5',
}

const GENERIC_MOOD_KEYWORDS: Record<string, string[]> = {
  放松: ['放松 华语', '舒缓 流行', '治愈 慢歌'],
  松弛: ['松弛 流行', '慵懒 R&B', '舒服 华语'],
  清醒: ['清醒 节奏', '提神 流行', '明亮 节奏'],
  热烈: ['热烈 节奏', '热血 流行', '有力量 流行'],
  轻快: ['轻快 流行', '清新 华语', '阳光 流行'],
  治愈: ['治愈 华语', '温柔 流行', '暖心 慢歌'],
  怀旧: ['怀旧 华语', '经典 流行', '老歌 流行'],
  孤独: ['孤独 华语', '夜晚 慢歌', '安静 流行'],
  陪伴: ['陪伴 华语', '温柔 流行', '日常 流行'],
  发呆: ['发呆 华语', '慵懒 流行', '安静 R&B'],
}

const GENERIC_GENRE_KEYWORDS: Record<string, string[]> = {
  流行: ['华语流行', '流行 新歌', '流行 歌单'],
  'R&B': ['R&B', '华语 R&B', '慵懒 R&B'],
  rnb: ['R&B', '华语 R&B', '慵懒 R&B'],
  摇滚: ['摇滚', '华语摇滚'],
  民谣: ['民谣', '华语民谣'],
  电子: ['电子', '电子流行'],
  说唱: ['说唱', '华语说唱'],
  爵士: ['爵士', '爵士流行'],
}

export function parseRequestedTrackCount(text: string): { requestedCount: number; targetCount: number; overLimit: boolean; explicit: boolean } {
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
  const chinese = lower.match(/(?:来|推|推荐|放|听|给我)?\s*([一二两三四五六七八九十])\s*首/)
  const requestedCount = arabic
    ? Number(arabic[1])
    : chinese?.[1]
      ? chineseDigits[chinese[1]] ?? 1
      : 1
  return {
    requestedCount,
    targetCount: Math.max(1, Math.min(MAX_RECOMMENDATION_COUNT, requestedCount)),
    overLimit: requestedCount > MAX_RECOMMENDATION_COUNT,
    explicit: Boolean(arabic || chinese),
  }
}

function detectTerms(text: string, terms: string[]): string[] {
  const normalized = normalizeText(text)
  return terms.filter((term) => normalized.includes(normalizeText(term)))
}

function normalizeArtistName(value: string): string {
  const trimmed = value
    .replace(/^[想听来点放首放点推推荐给我找首找一首]+/, '')
    .replace(/(?:的)?(?:歌|歌曲|音乐|作品|那种|那类|这种|来一首|来几首|一首|几首).*$/i, '')
    .replace(/[，。！？?！,.]/g, '')
    .trim()
  if (!trimmed) return ''
  const compact = normalizeText(trimmed)
  return ARTIST_ALIASES[compact] ?? ARTIST_ALIASES[trimmed.toLowerCase().replace(/\s+/g, '')] ?? trimmed
}

function inferArtistQuery(text: string): string | undefined {
  const alias = Object.entries(ARTIST_ALIASES).find(([key]) => normalizeText(text).includes(key))
  if (alias) return alias[1]

  const patterns = [
    /(?:想听|来一首|来点|放首|放点|推|推荐|给我|找首|找一首)\s*([A-Za-z0-9 .&'’\-\u4e00-\u9fa5]{1,32}?)(?:的)?(?:歌|歌曲|音乐|作品)/i,
    /([A-Za-z0-9 .&'’\-\u4e00-\u9fa5]{1,32}?)(?:的)?(?:歌|歌曲|音乐|作品)(?:来一首|来几首|一首|几首)?/i,
    /([A-Za-z0-9 .&'’-]{2,32})\s*(?:那种|那类|这种)/i,
  ]
  for (const pattern of patterns) {
    const match = text.match(pattern)
    const artist = normalizeArtistName(match?.[1] ?? '')
    if (artist && !ALLOWED_MOODS.has(artist) && !ALLOWED_SCENES.has(artist)) return artist
  }
  return undefined
}

function normalizeEvidence(items: unknown): string[] {
  if (!Array.isArray(items)) return []
  return unique(items.map(String).map((item) => item.trim()).filter(Boolean)).slice(0, 6)
}

function normalizeRejectIf(value: unknown): IntentRejectIf | undefined {
  const raw = asObject(value)
  const rejectIf: IntentRejectIf = {}
  const minEnergy = Number(raw.minEnergy)
  const maxEnergy = Number(raw.maxEnergy)
  if (Number.isFinite(minEnergy)) rejectIf.minEnergy = Math.max(0, Math.min(1, minEnergy))
  if (Number.isFinite(maxEnergy)) rejectIf.maxEnergy = Math.max(0, Math.min(1, maxEnergy))
  if (Array.isArray(raw.forbidTempo)) {
    rejectIf.forbidTempo = unique(raw.forbidTempo.filter((tempo): tempo is TrackSemantic['tempo'] => ALLOWED_TEMPOS.has(tempo as TrackSemantic['tempo'])))
  }
  if (Array.isArray(raw.requireTempo)) {
    rejectIf.requireTempo = unique(raw.requireTempo.filter((tempo): tempo is TrackSemantic['tempo'] => ALLOWED_TEMPOS.has(tempo as TrackSemantic['tempo'])))
  }
  return Object.keys(rejectIf).length > 0 ? rejectIf : undefined
}

function normalizeIntentOverride(raw: unknown): IntentOverride | null {
  const value = asObject(raw)
  if (Object.keys(value).length === 0) return null
  const override: IntentOverride = {}
  if (typeof value.wantsMusic === 'boolean') override.wantsMusic = value.wantsMusic
  if (typeof value.language === 'string' && ALLOWED_LANGUAGES.has(value.language)) override.language = value.language as IntentOverride['language']
  if (Array.isArray(value.moods)) {
    override.moods = unique(value.moods.map(String).filter((mood) => ALLOWED_MOODS.has(mood))).slice(0, 6)
  }
  if (Array.isArray(value.scenes)) {
    override.scenes = unique(value.scenes.map(String).filter((scene) => ALLOWED_SCENES.has(scene))).slice(0, 6)
  }
  if (value.energy === 'low' || value.energy === 'medium' || value.energy === 'high') override.energy = value.energy
  if (value.tempo === 'slow' || value.tempo === 'medium' || value.tempo === 'fast') override.tempo = value.tempo
  if (value.familiarity === 'safe' || value.familiarity === 'explore' || value.familiarity === 'balanced') override.familiarity = value.familiarity
  if (typeof value.targetCount === 'number' && Number.isFinite(value.targetCount)) {
    override.targetCount = Math.max(1, Math.min(MAX_RECOMMENDATION_COUNT, Math.floor(value.targetCount)))
  }
  if (typeof value.seedTitle === 'string' && value.seedTitle.trim()) override.seedTitle = value.seedTitle.trim().slice(0, 40)
  if (typeof value.artistQuery === 'string' && value.artistQuery.trim()) {
    override.artistQuery = normalizeArtistName(value.artistQuery).slice(0, 40)
  }
  if (typeof value.intentConfidence === 'number' && Number.isFinite(value.intentConfidence)) {
    override.intentConfidence = Math.max(0, Math.min(1, value.intentConfidence))
  }
  if (typeof value.sceneKey === 'string') {
    const allowedSceneKeys = new Set<SceneKey>(['focus', 'sleepy', 'relax', 'irritated', 'random'])
    if (allowedSceneKeys.has(value.sceneKey as SceneKey)) override.sceneKey = value.sceneKey as SceneKey
  }
  override.evidence = normalizeEvidence(value.evidence)
  override.rejectIf = normalizeRejectIf(value.rejectIf)
  return override
}

function validateIntentOverride(text: string, override: IntentOverride | null): IntentOverride | null {
  if (!override) return null
  const highTerms = detectTerms(text, HIGH_ENERGY_TERMS)
  const lowTerms = detectTerms(text, LOW_ENERGY_TERMS)
  const artistQuery = inferArtistQuery(text)
  const requested = parseRequestedTrackCount(text)
  const explicitMusic = MUSIC_REQUEST_PATTERN.test(text)
  const next: IntentOverride = { ...override }

  if (explicitMusic && next.wantsMusic === false) next.wantsMusic = true
  if (next.wantsMusic === undefined && explicitMusic) next.wantsMusic = true
  if (artistQuery && !next.artistQuery) next.artistQuery = artistQuery
  if (requested.explicit) next.targetCount = requested.targetCount

  if (highTerms.length > 0) {
    next.energy = 'high'
    next.tempo = 'fast'
    next.moods = unique([...(next.moods ?? []), '清醒', '热烈']).filter((mood) => ALLOWED_MOODS.has(mood))
    next.rejectIf = {
      ...next.rejectIf,
      minEnergy: Math.max(next.rejectIf?.minEnergy ?? 0, 0.55),
      forbidTempo: unique([...(next.rejectIf?.forbidTempo ?? []), 'slow']),
    }
    next.evidence = unique([...(next.evidence ?? []), ...highTerms]).slice(0, 6)
  } else if (lowTerms.length > 0 && next.energy === 'high') {
    next.energy = 'low'
    next.tempo = 'slow'
    next.rejectIf = {
      ...next.rejectIf,
      maxEnergy: Math.min(next.rejectIf?.maxEnergy ?? 1, 0.78),
      forbidTempo: unique([...(next.rejectIf?.forbidTempo ?? []), 'fast']),
    }
    next.evidence = unique([...(next.evidence ?? []), ...lowTerms]).slice(0, 6)
  }

  if ((next.intentConfidence ?? 1) < 0.35 && explicitMusic) next.wantsMusic = true
  return next
}

function mergeRejectIf(base?: IntentRejectIf, override?: IntentRejectIf): IntentRejectIf | undefined {
  const merged: IntentRejectIf = {}
  if (typeof base?.minEnergy === 'number' || typeof override?.minEnergy === 'number') {
    merged.minEnergy = Math.max(base?.minEnergy ?? 0, override?.minEnergy ?? 0)
  }
  if (typeof base?.maxEnergy === 'number' || typeof override?.maxEnergy === 'number') {
    merged.maxEnergy = Math.min(base?.maxEnergy ?? 1, override?.maxEnergy ?? 1)
  }
  merged.forbidTempo = unique([...(base?.forbidTempo ?? []), ...(override?.forbidTempo ?? [])])
  merged.requireTempo = unique([...(base?.requireTempo ?? []), ...(override?.requireTempo ?? [])])
  if (!merged.forbidTempo.length) delete merged.forbidTempo
  if (!merged.requireTempo.length) delete merged.requireTempo
  return Object.keys(merged).length > 0 ? merged : undefined
}

function mergeIntent(base: RecommendationIntent, override?: IntentOverride): RecommendationIntent {
  if (!override) return base
  const merged: RecommendationIntent = {
    ...base,
    source: 'hybrid',
    intentConfidence: override.intentConfidence,
    evidence: unique([...(base.evidence ?? []), ...(override.evidence ?? [])]).slice(0, 8),
    rejectIf: mergeRejectIf(base.rejectIf, override.rejectIf),
  }

  if (override.language && ALLOWED_LANGUAGES.has(override.language)) {
    merged.language = override.language
  }
  if (Array.isArray(override.moods) && override.moods.length > 0) {
    const filtered = override.moods.filter((m) => ALLOWED_MOODS.has(m))
    const baseMoods = base.moods.length === 1 && base.moods[0] === '陪伴' ? [] : base.moods
    if (filtered.length > 0) merged.moods = unique([...filtered, ...baseMoods]).slice(0, 6)
  }
  if (Array.isArray(override.scenes) && override.scenes.length > 0) {
    const filtered = override.scenes.filter((s) => ALLOWED_SCENES.has(s))
    if (filtered.length > 0) merged.scenes = unique([...filtered, ...base.scenes]).slice(0, 6)
  }
  if (override.energy === 'low' || override.energy === 'medium' || override.energy === 'high') {
    merged.energy = override.energy
  }
  if (override.tempo === 'slow' || override.tempo === 'medium' || override.tempo === 'fast') {
    merged.tempo = override.tempo
  }
  if (override.familiarity === 'safe' || override.familiarity === 'explore' || override.familiarity === 'balanced') {
    merged.familiarity = override.familiarity
  }
  if (typeof override.targetCount === 'number' && override.targetCount >= 1 && override.targetCount <= MAX_RECOMMENDATION_COUNT) {
    merged.targetCount = Math.floor(override.targetCount)
  }
  if (typeof override.seedTitle === 'string' && override.seedTitle.trim()) {
    merged.seedTitle = override.seedTitle.trim()
  }
  if (typeof override.artistQuery === 'string' && override.artistQuery.trim()) {
    merged.artistQuery = override.artistQuery.trim()
  }
  if (override.sceneKey) {
    merged.sceneKey = override.sceneKey
  }
  return merged
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms)
    promise
      .then((value) => {
        clearTimeout(timer)
        resolve(value)
      })
      .catch(() => {
        clearTimeout(timer)
        resolve(null)
      })
  })
}

/**
 * 用 fallback 兜底的 timeout: timeout 后或 reject 后都返回 fallback。
 * 用于外部网络请求，确保整个 fetchCandidates 不会被某个挂死的接口拖住。
 */
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

const NET_CALL_TIMEOUT_MS = 6000
const FETCH_CANDIDATES_TIMEOUT_MS = 9000
const EXPLICIT_FEEDBACK_LIMIT = 50
const FAVORITE_DIRECTION_LIMIT = 60

export interface DirectionMemoryItem {
  action: 'more_like_this' | 'not_right' | 'favorite'
  semantic: TrackSemantic
  artist: string
  trackKey: string
  weight: number
}

/**
 * 用 LLM 把用户这一句话翻译成结构化意图。
 * 失败 / 超时 / 没配 LLM → 返回 null，调用方走规则版 parseIntent。
 * 这是为了让"我累了""推荐国外""舒缓的歌"这种正则覆盖不到的自然语言，也能落到一个具体的 intent 上。
 */
export async function inferIntentWithLlm(text: string, recentDialog?: string): Promise<IntentOverride | null> {
  const settings = getSettings()
  if (!settings.llm.baseUrl || !settings.llm.apiKey || !settings.llm.model) return null

  const systemPrompt = `你是 Echo 的意图解析器。把用户这句话翻成下面这个 JSON。只输出 JSON 本体，不要解释、不要 Markdown、不要代码块。

{
  "wantsMusic": true | false,
  "intentConfidence": 0 到 1 的数字,
  "language": "华语" | "粤语" | "英语" | "韩语" | "日语" | null,
  "moods": [可选: "放松","松弛","清醒","热烈","轻快","治愈","怀旧","孤独","陪伴","发呆"],
  "scenes": [可选: "上午","午休","下午工作","通勤","下班路上","夜晚","睡前","雨天","独处","运动"],
  "energy": "low" | "medium" | "high" | null,
  "tempo": "slow" | "medium" | "fast" | null,
  "targetCount": 1 | 2 | 3 | 4 | 5,
  "seedTitle": null | "用户提到的具体歌名",
  "artistQuery": null | "用户明确提到的艺人或乐队名",
  "evidence": ["从用户原文里支持这个判断的短词"],
  "rejectIf": {
    "minEnergy": 0 到 1 的数字或 null,
    "maxEnergy": 0 到 1 的数字或 null,
    "forbidTempo": ["slow" | "medium" | "fast"],
    "requireTempo": ["slow" | "medium" | "fast"]
  }
}

判断规则：
1. wantsMusic：用户在请求音乐就 true，包括"我累了""想躺会儿""有点 emo""适合上班的歌"这种间接表达；只是闲聊就 false。
2. 不确定的字段一律填 null 或不填，不要瞎猜。
3. 用户没说几首就 targetCount: 1；用户明确说几首就照填，最多填 5。
4. moods/scenes/energy/tempo 只用枚举里的值，不要自己造词。
5. “激昂 / 热血 / 澎湃 / 带感 / 节奏感强 / 炸 / 动感”都属于 moods:["清醒","热烈"], energy:"high", tempo:"fast", rejectIf.minEnergy 至少 0.55, rejectIf.forbidTempo 包含 "slow"。
6. “舒缓 / 睡前 / 安静 / 慢一点”属于 energy:"low", tempo:"slow", rejectIf.maxEnergy 不超过 0.78, rejectIf.forbidTempo 包含 "fast"。
7. evidence 只摘原文里的关键词，比如 ["激昂"]、["睡前","粤语"]。
8. 用户说“某歌手/某乐队的歌来一首”“来一首某歌手”“某歌手那种”时，artistQuery 填该艺人/乐队名；“魔力红”统一填 "Maroon 5"。这种请求可以直接推荐一首，不要追问更具体。

例子：
- "我累了" → {"wantsMusic":true,"intentConfidence":0.84,"moods":["放松","松弛"],"energy":"low","tempo":"slow","targetCount":1,"evidence":["累"],"rejectIf":{"maxEnergy":0.78,"forbidTempo":["fast"]}}
- "推荐国外的歌曲" → {"wantsMusic":true,"intentConfidence":0.88,"language":"英语","targetCount":1,"evidence":["国外","歌曲"]}
- "来点舒缓的" → {"wantsMusic":true,"intentConfidence":0.9,"moods":["放松","治愈"],"energy":"low","tempo":"slow","targetCount":1,"evidence":["舒缓"],"rejectIf":{"maxEnergy":0.78,"forbidTempo":["fast"]}}
- "来一首激昂的歌曲" → {"wantsMusic":true,"intentConfidence":0.95,"moods":["清醒","热烈"],"energy":"high","tempo":"fast","targetCount":1,"evidence":["激昂","歌曲"],"rejectIf":{"minEnergy":0.55,"forbidTempo":["slow"],"requireTempo":["fast"]}}
- "节奏感强一点的" → {"wantsMusic":true,"intentConfidence":0.92,"moods":["清醒","热烈"],"energy":"high","tempo":"fast","targetCount":1,"evidence":["节奏感强"],"rejectIf":{"minEnergy":0.55,"forbidTempo":["slow"],"requireTempo":["fast"]}}
- "睡前粤语三首" → {"wantsMusic":true,"intentConfidence":0.93,"language":"粤语","scenes":["睡前"],"energy":"low","tempo":"slow","targetCount":3,"evidence":["睡前","粤语"],"rejectIf":{"maxEnergy":0.78,"forbidTempo":["fast"]}}
- "准备听会儿歌休息，来5首欢快的歌曲" → {"wantsMusic":true,"intentConfidence":0.95,"moods":["轻快"],"energy":"medium","tempo":"medium","targetCount":5,"evidence":["5首","欢快","休息"]}
- "来十首轻快的" → {"wantsMusic":true,"intentConfidence":0.95,"moods":["轻快"],"targetCount":5,"evidence":["十首","轻快"]}
- "魔力红的歌曲来一首" → {"wantsMusic":true,"intentConfidence":0.96,"artistQuery":"Maroon 5","targetCount":1,"evidence":["魔力红","歌曲"]}
- "Maroon 5 那种偏轻快的" → {"wantsMusic":true,"intentConfidence":0.9,"artistQuery":"Maroon 5","moods":["轻快"],"targetCount":1,"evidence":["Maroon 5","轻快"]}
- "今天天气真不错" → {"wantsMusic":false,"intentConfidence":0.82,"evidence":[]}`

  const userPrompt = recentDialog
    ? `<recent_dialog>\n${recentDialog}\n</recent_dialog>\n\n用户这一句:${text}`
    : `用户这一句:${text}`

  const response = await withTimeout(
    completeChat(settings, [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ], { temperature: 0 }),
    INTENT_LLM_TIMEOUT_MS,
  )
  if (typeof response !== 'string') return null

  const match = response.match(/\{[\s\S]*\}/)
  if (!match) return null
  try {
    const parsed = JSON.parse(match[0]) as IntentOverride
    return validateIntentOverride(text, normalizeIntentOverride(parsed))
  } catch {
    return null
  }
}

function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items))
}

function normalizeText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, '').replace(/[《》"'“”·.,，。!！?？()（）-]/g, '')
}

function trackKey(track: Track): string {
  return semanticTrackKey(track)
}

function trackIdentityKeys(track: Track): string[] {
  const keys = new Set<string>()
  const neteaseId = String(track.neteaseId ?? '').trim()
  const id = String(track.id ?? '').trim()
  const title = normalizeText(track.title)
  const artist = normalizeText(track.artist)
  if (neteaseId) keys.add(`netease:${neteaseId}`)
  if (id) keys.add(`id:${id}`)
  if (title && artist) keys.add(`name:${title}::${artist}`)
  keys.add(trackKey(track))
  return Array.from(keys)
}

function trackIdentitySet(tracks: Track[]): Set<string> {
  const keys = new Set<string>()
  for (const track of tracks) {
    for (const key of trackIdentityKeys(track)) keys.add(key)
  }
  return keys
}

function hasTrackIdentity(keys: Set<string>, track: Track): boolean {
  return trackIdentityKeys(track).some((key) => keys.has(key))
}

function uniqueTracks(tracks: Track[]): Track[] {
  const seen = new Set<string>()
  const result: Track[] = []
  for (const track of tracks) {
    const key = trackKey(track)
    if (seen.has(key)) continue
    seen.add(key)
    result.push(track)
  }
  return result
}

function primaryArtist(artist: string): string {
  return artist.split(/[/、,，&＋+]| feat\.?| ft\.?| and /i)[0]?.trim().toLowerCase() ?? artist.trim().toLowerCase()
}

function diversifyByArtist(tracks: Track[], maxPerArtist: number): Track[] {
  const artistCounts = new Map<string, number>()
  return tracks.filter((track) => {
    const key = primaryArtist(track.artist)
    const count = artistCounts.get(key) ?? 0
    if (count >= maxPerArtist) return false
    artistCounts.set(key, count + 1)
    return true
  })
}

function parseTargetCount(text: string): number {
  return parseRequestedTrackCount(text).targetCount
}

function parseIntent(text: string): RecommendationIntent {
  const lower = text.toLowerCase()
  const moods: string[] = []
  const scenes: string[] = []
  const highTerms = detectTerms(text, HIGH_ENERGY_TERMS)
  const lowTerms = detectTerms(text, LOW_ENERGY_TERMS)
  const hasHighEnergy = highTerms.length > 0 || /快/.test(lower)
  const hasLowEnergy = lowTerms.length > 0
  if (/困|累|睡|慢|发呆|安静|放松|平静/.test(lower)) moods.push('放松', '松弛')
  if (/伤心|难过|emo|孤独|想哭/.test(lower)) moods.push('孤独', '陪伴')
  if (/开心|轻松|甜|阳光/.test(lower)) moods.push('轻快')
  if (/清醒|工作|提神|快|有劲|燃|激昂|高昂|亢奋|振奋|热血|澎湃|炸|爆|带感|节奏感强|节奏强|有力量|力量感|鼓点|动感/.test(lower)) moods.push('清醒', '热烈')
  if (/雨/.test(lower)) scenes.push('雨天')
  if (/通勤|路上|开车/.test(lower)) scenes.push('通勤')
  if (/下班|回家/.test(lower)) scenes.push('下班路上')
  if (/夜|晚上|深夜|睡前/.test(lower)) scenes.push('夜晚', '睡前')
  if (/午休|中午/.test(lower)) scenes.push('午休')
  const language = /粤语|广东/.test(lower)
    ? '粤语'
    : /英文|欧美|英语|english|外文|外语|国外|外国|老外|英美/.test(lower)
      ? '英语'
      : /韩语|韩国|韩文|韩团|kpop|k-pop/.test(lower)
        ? '韩语'
        : /日语|日本|日文|j-pop|jpop/.test(lower)
          ? '日语'
          : /华语|中文|国语|国内|大陆|中国/.test(lower)
            ? '华语'
            : undefined
  const energy = hasHighEnergy ? 'high' : hasLowEnergy ? 'low' : undefined
  const tempo = hasHighEnergy ? 'fast' : hasLowEnergy ? 'slow' : undefined
  const familiarity = /新|没听过|探索|陌生/.test(lower) ? 'explore' : /熟|稳|安全|常听|像/.test(lower) ? 'safe' : 'balanced'
  const seedTitle = text.match(/《([^》]{1,40})》/)?.[1]?.trim()
  const artistQuery = inferArtistQuery(text)
  const rejectIf = hasHighEnergy
    ? { minEnergy: 0.55, forbidTempo: ['slow' as const], requireTempo: ['fast' as const] }
    : hasLowEnergy
      ? { maxEnergy: 0.78, forbidTempo: ['fast' as const] }
      : undefined
  return {
    moods: unique(moods.length ? moods : ['陪伴']),
    scenes: unique(scenes),
    language,
    energy,
    tempo,
    familiarity,
    targetCount: parseTargetCount(text),
    query: text.trim(),
    seedTitle,
    artistQuery,
    evidence: unique([...highTerms, ...lowTerms]).slice(0, 6),
    rejectIf,
    sceneKey: undefined,
    source: 'rules',
  }
}

function queryFingerprint(text: string): string {
  return normalizeText(text)
    .replace(/推|推荐|来几首|来一首|听什么|听啥|值得听|适合听|想听|能听|放点|放首|来点|找首|找一首|给我|歌曲|歌|音乐|曲/g, '')
    .slice(0, 48)
}

function buildCacheKey(intent: RecommendationIntent): string {
  return normalizeText(JSON.stringify({
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

function sceneKeyword(intent: RecommendationIntent): string {
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
      const profile = pickWeightedKeywords()
      const picked = shuffleItems(profile).slice(0, 3)
      return picked.join(' ') || '华语流行'
    }
    default:
      return ''
  }
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

function extractPlaylistIds(response: ApiResponse): string[] {
  const result = asObject(response.body?.result)
  return asArray(result.playlists)
    .map((playlist) => String(asObject(playlist).id ?? ''))
    .filter(Boolean)
    .slice(0, 2)
}

function keywordFromIntent(intent: RecommendationIntent): string {
  const parts = [
    sceneKeyword(intent),
    intent.artistQuery ?? '',
    intent.language === '粤语' ? '粤语' : intent.language === '英语' ? '欧美' : intent.language === '韩语' ? 'Kpop' : '',
    intent.moods.includes('放松') || intent.tempo === 'slow' ? '慢歌' : '',
    intent.moods.includes('清醒') || intent.energy === 'high' ? '激昂 节奏 热血' : '',
    intent.scenes.includes('雨天') ? '雨天' : '',
    intent.scenes.includes('夜晚') || intent.scenes.includes('睡前') ? '夜晚' : '',
    intent.query.replace(/[推荐推来点几首听什么值得听适合听歌的呢吗？?]/g, '').trim(),
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

function pickWeightedKeywords(): string[] {
  const profile = getTasteProfile()
  const semanticTracks = listSemantics()
  const pool: string[] = []

  // Mood bucket: take up to 3 distinct moods, pick 1 keyword each
  const moodKeywords = (profile?.moods ?? []).flatMap((mood) => GENERIC_MOOD_KEYWORDS[mood.tag] ?? [mood.tag])
  const shuffledMoods = shuffleItems(unique(moodKeywords))
  pool.push(...shuffledMoods.slice(0, 3))

  // Genre bucket: take up to 3 distinct genres, pick 1 keyword each
  const genreKeywords = (profile?.genres ?? []).flatMap((genre) => GENERIC_GENRE_KEYWORDS[genre.name] ?? [genre.name])
  const shuffledGenres = shuffleItems(unique(genreKeywords))
  pool.push(...shuffledGenres.slice(0, 3))

  // Semantic track bucket: secondary diversity from actual listened tracks
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
  pool.push(...shuffleItems(unique(semanticMoodKeywords)).slice(0, 2))
  const semanticGenreKeywords = Array.from(semanticGenreCounts.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 3)
    .flatMap(([genre]) => GENERIC_GENRE_KEYWORDS[genre] ?? [genre])
  pool.push(...shuffleItems(unique(semanticGenreKeywords)).slice(0, 2))

  return unique(pool)
}

function genericDiscoveryKeywords(): string[] {
  const profileKeywords = pickWeightedKeywords().filter((keyword) => keyword.trim().length > 0)
  const fallback = ['华语流行', '轻快 流行', '治愈 华语', '舒服 华语']
  return unique([...profileKeywords, ...fallback]).slice(0, 8)
}

async function fetchGenericDiscoveryCandidates(intent: RecommendationIntent): Promise<Track[]> {
  const cookie = readNeteaseCookie()
  if (!cookie) throw new NeteaseAuthRequiredError()
  const keywords = shuffleItems(genericDiscoveryKeywords()).slice(0, Math.max(3, Math.min(5, intent.targetCount + 3)))
  const calls: Array<Promise<Track[]>> = []

  for (const keyword of keywords) {
    const offset = Math.floor(Math.random() * 4) * 10
    calls.push(netCall(netease.cloudsearch({ keywords: keyword, type: 1, limit: 30, offset, cookie }), 'search'))
    const tagId = styleTagIdFromText(keyword)
    if (tagId) calls.push(netCall(netease.style_song({ tagId, size: 20, cursor: Math.floor(Math.random() * 3) * 20, cookie }), 'style'))
  }

  if (calls.length === 0) calls.push(netCall(netease.personalized_newsong({ limit: 30, cookie }), 'new_song'))

  const groups = await Promise.all(calls)
  return uniqueTracks(groups.flat()).slice(0, 160)
}

function genericDiscoveryScore(track: Track, recentSevenDayKeys: Set<string>, memory: DirectionMemoryItem[]): number {
  const semantic = semanticForCandidate(track)
  let score = Math.random() * 3
  if (semantic.familiarity === 'explore') score += 0.6
  if (track.recommendSource === 'style') score += 0.9
  if (track.recommendSource === 'search') score += 0.4
  score += directionMemoryScore(track, semantic, memory)
  if (hasTrackIdentity(recentSevenDayKeys, track)) score -= 8
  return score
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

async function recommendGenericDiscovery(intent: RecommendationIntent): Promise<Track[]> {
  const candidates = await fetchGenericDiscoveryCandidates(intent)
  const memory = buildDirectionMemory()
  const lastDayKeys = trackIdentitySet(loadListenedTracksSince(24, 400))
  const lastSevenDayKeys = trackIdentitySet(loadListenedTracksSince(24 * 7, 800))
  const enriched = uniqueTracks(candidates.map((track) => ({ ...track, semantic: semanticForCandidate(track) })))
    .map((track) => ({ track, score: genericDiscoveryScore(track, lastSevenDayKeys, memory) }))
    .sort((a, b) => b.score - a.score)
    .map((item) => item.track)

  const stages = [
    enriched.filter((track) => !hasTrackIdentity(lastDayKeys, track) && !hasTrackIdentity(lastSevenDayKeys, track)),
    enriched.filter((track) => !hasTrackIdentity(lastDayKeys, track)),
  ]

  for (const stage of stages) {
    if (stage.length === 0) continue
    const playable = await filterPlayableTracks(shuffleTracks(stage), Math.max(20, intent.targetCount * 8))
    const picked = diversifyByArtist(uniqueTracks(playable), 1).slice(0, intent.targetCount).map(withGenericReason)
    if (picked.length) {
      return picked.map((track) => ({
        ...track,
        profileEvidence: {
          moods: intent.moods,
          scenes: intent.scenes,
          source: track.recommendSource ?? 'search',
          score: genericDiscoveryScore(track, lastSevenDayKeys, memory),
        },
      }))
    }
  }

  return []
}

function importedSeedTracks(intent: RecommendationIntent): Track[] {
  const imported = getAllImportedTracks()
  if (intent.seedTitle) {
    const seed = imported.find((track) => normalizeText(track.title).includes(normalizeText(intent.seedTitle ?? '')))
    if (seed) return [seed]
  }
  const semantic = listSemantics()
    .filter((track) => intent.moods.some((mood) => track.semantic.moods.includes(mood)) || intent.scenes.some((scene) => track.semantic.scenes.includes(scene)))
    .slice(0, Math.max(4, intent.targetCount))
  return [...semantic, ...imported].filter((track) => track.id || track.neteaseId).slice(0, Math.max(3, intent.targetCount))
}

function profileArtistQueries(intent: RecommendationIntent): string[] {
  const profile = getTasteProfile()
  const semanticArtists = listSemantics()
    .filter((track) => intent.moods.some((mood) => track.semantic.moods.includes(mood)) || intent.scenes.some((scene) => track.semantic.scenes.includes(scene)))
    .map((track) => track.artist)
  const profileArtists = profile?.artists.slice(0, 6).map((artist) => artist.name) ?? []
  return unique([intent.artistQuery ?? '', ...semanticArtists, ...profileArtists].filter(Boolean)).slice(0, 5)
}

async function fetchArtistCandidates(intent: RecommendationIntent, cookie: string): Promise<Track[]> {
  const tracks: Track[] = []
  for (const artist of profileArtistQueries(intent)) {
    const search = await timed(
      netease.cloudsearch({ keywords: artist, type: 100, limit: 3, offset: 0, cookie }),
      NET_CALL_TIMEOUT_MS,
      null as ApiResponse | null,
    )
    if (!search) continue
    for (const id of extractArtistIds(search)) {
      const topSongs = await timed(
        netease.artist_top_song({ id, cookie }),
        NET_CALL_TIMEOUT_MS,
        null as ApiResponse | null,
      )
      if (topSongs) tracks.push(...extractTracks(topSongs, 'artist'))
    }
  }
  return tracks
}

function isArtistFocusedIntent(intent: RecommendationIntent): boolean {
  return Boolean(intent.artistQuery) && !intent.seedTitle && intent.moods.every((mood) => mood === '陪伴')
}

function shuffleTracks(tracks: Track[]): Track[] {
  const items = [...tracks]
  for (let index = items.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1))
    ;[items[index], items[swap]] = [items[swap], items[index]]
  }
  return items
}

function shuffleItems<T>(items: T[]): T[] {
  const next = [...items]
  for (let index = next.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1))
    ;[next[index], next[swap]] = [next[swap], next[index]]
  }
  return next
}

async function fetchPlaylistCandidates(intent: RecommendationIntent, cookie: string): Promise<Track[]> {
  const keywords = `${keywordFromIntent(intent)} 歌单`.trim()
  const playlistOffset = Math.floor(Math.random() * 3) * 5
  const search = await timed(
    netease.cloudsearch({ keywords, type: 1000, limit: 5, offset: playlistOffset, cookie }),
    NET_CALL_TIMEOUT_MS,
    null as ApiResponse | null,
  )
  if (!search) return []
  const tracks: Track[] = []
  for (const id of extractPlaylistIds(search)) {
    const detail = await timed(
      netease.playlist_track_all({ id, limit: 24, offset: 0, cookie }),
      NET_CALL_TIMEOUT_MS,
      null as ApiResponse | null,
    )
    if (detail) tracks.push(...extractTracks(detail, 'playlist'))
  }
  return tracks
}

function netCall(promise: Promise<ApiResponse>, source: RecommendationSource): Promise<Track[]> {
  return timed(promise, NET_CALL_TIMEOUT_MS, null as ApiResponse | null)
    .then((res) => (res ? extractTracks(res, source) : []))
    .catch(() => [])
}

async function fetchCandidatesInternal(intent: RecommendationIntent): Promise<Track[]> {
  const cookie = readNeteaseCookie()
  if (!cookie) throw new NeteaseAuthRequiredError()
  const candidates: Track[] = []

  const searchOffset = Math.floor(Math.random() * 4) * 10
  const calls: Array<Promise<Track[]>> = [
    netCall(netease.recommend_songs({ cookie }), 'daily'),
    netCall(netease.personal_fm({ cookie }), 'fm'),
    netCall(netease.cloudsearch({ keywords: keywordFromIntent(intent), type: 1, limit: 30, offset: searchOffset, cookie }), 'search'),
    netCall(netease.personalized_newsong({ limit: 20, cookie }), 'new_song'),
    timed(fetchArtistCandidates(intent, cookie), NET_CALL_TIMEOUT_MS + 2000, [] as Track[]),
    timed(fetchPlaylistCandidates(intent, cookie), NET_CALL_TIMEOUT_MS + 2000, [] as Track[]),
  ]

  const tagId = styleTagId(intent)
  if (tagId) {
    calls.push(netCall(netease.style_song({ tagId, size: 20, cursor: 0, cookie }), 'style'))
  }

  for (const seed of importedSeedTracks(intent)) {
    const id = seed.neteaseId ?? seed.id
    if (id) calls.push(netCall(netease.simi_song({ id, limit: 20, offset: 0, cookie }), 'similar'))
  }

  const groups = await Promise.all(calls)
  for (const group of groups) candidates.push(...group)
  return uniqueTracks(candidates).slice(0, 120)
}

async function fetchCandidates(intent: RecommendationIntent): Promise<Track[]> {
  // 认证错误必须保留向上抛 (chat.ts 接住后会让 LLM 提示用户去登录)。
  // 其他情况 (网络挂死 / 接口异常) 都用 timed 兜底, 防止整条链路被某个挂起的 fetch 拖死。
  let authError: NeteaseAuthRequiredError | null = null
  const wrapped = fetchCandidatesInternal(intent).catch((error) => {
    if (error instanceof NeteaseAuthRequiredError) {
      authError = error
    }
    return [] as Track[]
  })
  const result = await timed(wrapped, FETCH_CANDIDATES_TIMEOUT_MS, [] as Track[])
  if (authError) throw authError
  return result
}

function semanticForCandidate(track: Track): TrackSemantic {
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

function buildDirectionMemory(): DirectionMemoryItem[] {
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

function directionMemoryScore(track: Track, semantic: TrackSemantic, memory: DirectionMemoryItem[]): number {
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
  if (track.recommendSource === 'similar') score += 1.2
  if (track.recommendSource === 'artist') score += 0.9
  if (track.recommendSource === 'playlist') score += 0.7
  if (track.recommendSource === 'daily' || track.recommendSource === 'fm') score += 0.8
  score += Math.max(-5, Math.min(5, feedbackScore(track)))
  score += directionMemoryScore(track, semantic, memory)
  if (hasTrackIdentity(recentKeys, track)) score -= 12
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

function scoreCandidate(track: Track, intent: RecommendationIntent, recentKeys: Set<string>, memory: DirectionMemoryItem[], profile?: TasteProfile | null): number {
  return scoreCandidateWithFeedback(track, intent, recentKeys, memory, getFeedbackScore, profile)
}

function scoreCandidateForTest(track: Track, intent: RecommendationIntent, recentKeys: Set<string>, memory: DirectionMemoryItem[]): number {
  return scoreCandidateWithFeedback(track, intent, recentKeys, memory, () => 0)
}

function matchesIntentFloor(track: Track, intent: RecommendationIntent): boolean {
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

function parseJsonObject(content: string): Record<string, unknown> | null {
  const match = content.match(/\{[\s\S]*\}/)
  if (!match) return null
  try {
    return JSON.parse(match[0]) as Record<string, unknown>
  } catch {
    return null
  }
}

function fallbackReason(track: Track, index: number, intent: RecommendationIntent): string {
  const reasons = intent.energy === 'low' || intent.tempo === 'slow'
    ? ['第一首先把节奏放慢,入口轻一点。', '第二首接住松弛感,让耳朵歇一会。', '第三首留在后面,把这段情绪收稳。']
    : intent.energy === 'high'
      ? ['第一首先提气,让注意力醒过来。', '第二首续住速度,适合继续做事。', '第三首把能量放稳,听完不会散。']
      : ['第一首先试温度,比较容易进去。', '第二首换一点颜色,让这组歌有变化。', '第三首放在后面,听完还有余味。']
  if (intent.targetCount === 1) {
    if (intent.energy === 'low' || intent.tempo === 'slow') return '这首入口轻,适合先把节奏放慢。'
    if (intent.energy === 'high') return '这首能把注意力提起来,现在接上比较顺。'
    return '这首温度刚好,先听它。'
  }
  return reasons[index] ?? `第 ${index + 1} 首换一点颜色,让这组歌更完整。`
}

async function selectFinalTracks(text: string, candidates: Track[], intent: RecommendationIntent): Promise<Track[]> {
  const targetCount = intent.targetCount
  if (candidates.length <= targetCount) return candidates.map((track, index) => ({ ...track, reason: track.reason ?? fallbackReason(track, index, intent) }))
  const settings = getSettings()
  const list = candidates
    .slice(0, Math.max(20, targetCount * 8))
    .map((track, index) => `${index + 1}. ${track.title} - ${track.artist}${track.album ? ` / ${track.album}` : ''} / ${track.recommendSource ?? 'search'}`)
    .join('\n')
  try {
    const content = await completeChat(settings, [
      {
        role: 'system',
        content: `你是 Echo 的最终推荐排序器。只能从候选中选 ${targetCount} 首。
输出严格 JSON: {"indexes":[数字],"notes":["每首一句中文理由"]}。
indexes 数量必须是 ${targetCount}。理由要具体,每首理由要有差异。`,
      },
      {
        role: 'user',
        content: `用户说:${text}
解析意图:${JSON.stringify(intent)}
候选:
${list}`,
      },
    ], { temperature: 0.45 })
    const parsed = parseJsonObject(content)
    const indexes = Array.isArray(parsed?.indexes) ? parsed.indexes.map(Number).filter((item) => Number.isInteger(item)) : []
    const notes = Array.isArray(parsed?.notes) ? parsed.notes.map(String) : []
    const selected = indexes
      .map((index) => candidates[index - 1])
      .filter((track): track is Track => Boolean(track))
      .slice(0, targetCount)
      .map((track, index) => ({ ...track, reason: notes[index] || fallbackReason(track, index, intent) }))
    const filled = uniqueTracks([
      ...selected,
      ...candidates.filter((track) => !selected.some((item) => trackKey(item) === trackKey(track))),
    ]).slice(0, targetCount)
    return filled.length ? filled.map((track, index) => ({ ...track, reason: track.reason ?? fallbackReason(track, index, intent) })) : candidates.slice(0, targetCount).map((track, index) => ({ ...track, reason: fallbackReason(track, index, intent) }))
  } catch {
    return candidates.slice(0, targetCount).map((track, index) => ({ ...track, reason: fallbackReason(track, index, intent) }))
  }
}

export async function recommendFromNetease(text: string, override?: IntentOverride, options: RecommendationOptions = {}): Promise<Track[]> {
  if (!readNeteaseCookie()) throw new NeteaseAuthRequiredError()
  const baseIntent = mergeIntent(parseIntent(text), options.ignoreScene ? undefined : sceneIntentOverride())
  const intent = mergeIntent(baseIntent, validateIntentOverride(text, override ?? null) ?? undefined)
  if (isGenericDiscoveryRequest(text, intent)) {
    return recommendGenericDiscovery(intent)
  }
  const allowCooldownFallback = Boolean(intent.seedTitle || intent.artistQuery || intent.sceneKey)
  const cacheKey = buildCacheKey(intent)
  const profile = getTasteProfile()
  const memory = buildDirectionMemory()
  const hardCooldownKeys = trackIdentitySet(loadListenedTracksSince(24, 500))
  const recentKeys = trackIdentitySet([...loadRecentRecommendedTracks(120), ...loadListenedTracksSince(24 * 7, 900)])
  const cached = getRecommendationCache(cacheKey)
  if (cached?.tracks.length) {
    const cachedFresh = cached.tracks
      .filter((track) => !hasTrackIdentity(hardCooldownKeys, track) && !hasTrackIdentity(recentKeys, track))
      .map((track) => ({ ...track, semantic: track.semantic ?? semanticForCandidate(track), playUrl: undefined, urlExpiresAt: undefined }))
      .filter((track) => matchesIntentFloor(track, intent))
    const playable = await filterPlayableTracks(cachedFresh, intent.targetCount)
    if (playable.length >= intent.targetCount) return playable
  }

  const candidates = await fetchCandidates(intent)
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
    const playableArtistTracks = await filterPlayableTracks(shuffleTracks(artistCandidates.length ? artistCandidates : fallbackArtistCandidates.length ? fallbackArtistCandidates : lastResortArtistCandidates), intent.targetCount)
    if (playableArtistTracks.length) {
      const picked = playableArtistTracks.slice(0, intent.targetCount).map((track) => ({
        ...track,
        reason: track.reason ?? `${intent.artistQuery} 的歌里,这首现在接上就行。`,
      }))
      setRecommendationCache(cacheKey, intent as unknown as Record<string, unknown>, picked.map((track) => ({ ...track, playUrl: undefined, urlExpiresAt: undefined })))
      return picked
    }
  }
  const ranked = candidates
    .map((track) => ({ track: { ...track, semantic: semanticForCandidate(track) }, score: scoreCandidate(track, intent, recentKeys, memory, profile) }))
    .sort((a, b) => b.score - a.score)
    .map((item) => item.track)
  const intentMatched = ranked.filter((track) => !hasTrackIdentity(hardCooldownKeys, track) && !hasTrackIdentity(recentKeys, track) && matchesIntentFloor(track, intent))
  const cooledPool = ranked.filter((track) => !hasTrackIdentity(hardCooldownKeys, track) && matchesIntentFloor(track, intent))
  const fallbackPool = allowCooldownFallback ? ranked.filter((track) => matchesIntentFloor(track, intent)) : []
  const primaryPool = intentMatched.length >= intent.targetCount ? intentMatched : cooledPool.length >= intent.targetCount ? cooledPool : fallbackPool
  const playablePool = await filterPlayableTracks(primaryPool, Math.max(20, intent.targetCount * 8))
  const diversifiedPool = diversifyByArtist(playablePool, 2)
  const finalTracks = await selectFinalTracks(text, diversifiedPool, intent)
  const evidencedTracks = finalTracks.map((track) => ({
    ...track,
    profileEvidence: {
      moods: intent.moods,
      scenes: intent.scenes,
      source: track.recommendSource ?? 'search',
      score: scoreCandidate(track, intent, recentKeys, memory, profile),
    },
  }))
  const playable = await filterPlayableTracks(evidencedTracks, intent.targetCount)
  if (playable.length) setRecommendationCache(cacheKey, intent as unknown as Record<string, unknown>, playable.map((track) => ({ ...track, playUrl: undefined, urlExpiresAt: undefined })))
  return playable
}
