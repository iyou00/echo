import type { SceneKey, TrackSemantic } from '../../../types/ipc'
import { getSettings } from '../../db/settings'
import { completeChat } from '../../llm/client'
import { asObject } from '../../netease/music'
import {
  normalizeMusicArtistName,
  parseMusicRequestCount,
  resolveMusicEntitiesFromText,
} from '../../skills/music/entityResolver'
import { normalizeText, unique } from './text'

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

export interface IntentRejectIf {
  minEnergy?: number
  maxEnergy?: number
  forbidTempo?: Array<TrackSemantic['tempo']>
  requireTempo?: Array<TrackSemantic['tempo']>
}

export interface IntentParseOptions {
  inferEntities?: boolean
}

const ALLOWED_MOODS = new Set(['放松', '松弛', '清醒', '热烈', '轻快', '治愈', '怀旧', '孤独', '陪伴', '发呆'])
const ALLOWED_SCENES = new Set(['上午', '午休', '下午工作', '通勤', '下班路上', '夜晚', '睡前', '雨天', '独处', '运动'])
const ALLOWED_LANGUAGES = new Set(['华语', '粤语', '英语', '韩语', '日语'])
const ALLOWED_TEMPOS = new Set<TrackSemantic['tempo']>(['slow', 'medium', 'fast'])
const INTENT_LLM_TIMEOUT_MS = 4000

export const MAX_RECOMMENDATION_COUNT = 5
export const OVER_LIMIT_RECOMMENDATION_LINE = '歌不在多，慢慢听。我先给你挑 5 首。'
export const MUSIC_REQUEST_PATTERN = /推|推荐|来几首|来一首|听什么|听啥|值得听|适合听|想听|想要听|要听|我要听|我想听|播放|能听|放点|放首|来点|找首|找一首|给我.*歌|歌|曲|歌单|music|song/i
export const GENERIC_DISCOVERY_PATTERN = /这个时候|现在|此刻|随便|随机|听点啥|听什么|有什么.*听|值得听|来首歌|来一首歌|放首歌|推首歌|推荐一首|来点音乐|听会儿歌|听会歌/i
export const SPECIFIC_DISCOVERY_PATTERN = /《|》|像|类似|那种|那类|粤语|广东|英文|欧美|英语|english|外文|外语|国外|外国|韩语|韩国|韩文|kpop|k-pop|日语|日本|日文|j-pop|jpop|华语|中文|国语|激昂|高昂|亢奋|振奋|热血|澎湃|带感|节奏|鼓点|动感|燃|提神|清醒|欢快|开心|轻快|轻松|快歌|快的|快一点|快点|慢|困|累|睡|睡前|休息|安静|放松|舒缓|治愈|发呆|平静|emo|伤心|难过|孤独|想哭|r&b|说唱|rap|hip|摇滚|rock|民谣|folk|电子|edm/i

export const GENERIC_MOOD_KEYWORDS: Record<string, string[]> = {
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

export const GENERIC_GENRE_KEYWORDS: Record<string, string[]> = {
  流行: ['华语流行', '流行 新歌', '流行 歌单'],
  'R&B': ['R&B', '华语 R&B', '慵懒 R&B'],
  rnb: ['R&B', '华语 R&B', '慵懒 R&B'],
  摇滚: ['摇滚', '华语摇滚'],
  民谣: ['民谣', '华语民谣'],
  电子: ['电子', '电子流行'],
  说唱: ['说唱', '华语说唱'],
  爵士: ['爵士', '爵士流行'],
}

const HIGH_ENERGY_TERMS = ['激昂', '高昂', '亢奋', '振奋', '热血', '澎湃', '炸', '爆', '带感', '节奏感强', '节奏强', '有力量', '力量感', '鼓点', '动感', '燃', '提神', '清醒', '运动', '有劲']
const LOW_ENERGY_TERMS = ['慢', '困', '睡', '安静', '放松', '发呆', '舒缓', '缓和', '轻柔', '松弛', '平静']

export function parseRequestedTrackCount(text: string): { requestedCount: number; targetCount: number; overLimit: boolean; explicit: boolean } {
  return parseMusicRequestCount(text)
}

function detectTerms(text: string, terms: string[]): string[] {
  const normalized = normalizeText(text)
  return terms.filter((term) => normalized.includes(normalizeText(term)))
}

function inferDirectSongRequest(text: string): { artistQuery?: string; seedTitle?: string } {
  const entities = resolveMusicEntitiesFromText(text)
  return { artistQuery: entities.artistQuery, seedTitle: entities.seedTitle }
}

function inferArtistQuery(text: string): string | undefined {
  return resolveMusicEntitiesFromText(text).artistQuery
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
    override.artistQuery = normalizeMusicArtistName(value.artistQuery).slice(0, 40)
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

export function validateIntentOverride(text: string, override: IntentOverride | null, options: IntentParseOptions = {}): IntentOverride | null {
  if (!override) return null
  const highTerms = detectTerms(text, HIGH_ENERGY_TERMS)
  const lowTerms = detectTerms(text, LOW_ENERGY_TERMS)
  const inferEntities = options.inferEntities ?? true
  const artistQuery = inferEntities ? inferArtistQuery(text) : undefined
  const directSong = inferEntities ? inferDirectSongRequest(text) : {}
  const requested = parseRequestedTrackCount(text)
  const explicitMusic = MUSIC_REQUEST_PATTERN.test(text)
  const next: IntentOverride = { ...override }

  if (explicitMusic && next.wantsMusic === false) next.wantsMusic = true
  if (next.wantsMusic === undefined && explicitMusic) next.wantsMusic = true
  if (directSong.seedTitle && !next.seedTitle) next.seedTitle = directSong.seedTitle
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
      requireTempo: unique([...(next.rejectIf?.requireTempo ?? []), 'fast']),
    }
    next.evidence = unique([...(next.evidence ?? []), ...highTerms]).slice(0, 6)
  } else if (lowTerms.length > 0) {
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

export function mergeIntent(base: RecommendationIntent, override?: IntentOverride): RecommendationIntent {
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

export interface IntentInferenceOptions {
  signal?: AbortSignal
}

function assertIntentActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('任务已取消', 'AbortError')
}

export async function inferIntentWithLlm(text: string, recentDialog?: string, options: IntentInferenceOptions = {}): Promise<IntentOverride | null> {
  assertIntentActive(options.signal)
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
3. 用户没说几首就 targetCount: 1；用户说“几首”通常填 3；用户明确说具体数量就照填，最多填 5。
4. moods/scenes/energy/tempo 只用枚举里的值，不要自己造词。
5. “激昂 / 热血 / 澎湃 / 带感 / 节奏感强 / 炸 / 动感”都属于 moods:["清醒","热烈"], energy:"high", tempo:"fast", rejectIf.minEnergy 至少 0.55, rejectIf.forbidTempo 包含 "slow"。
6. “舒缓 / 睡前 / 安静 / 慢一点”属于 energy:"low", tempo:"slow", rejectIf.maxEnergy 不超过 0.78, rejectIf.forbidTempo 包含 "fast"。
7. evidence 只摘原文里的关键词，比如 ["激昂"]、["睡前","粤语"]。
8. 用户说“某歌手/某乐队的歌来一首”“来一首某歌手”“某歌手那种”时，artistQuery 填该艺人/乐队名；“魔力红”统一填 "Maroon 5"。这种请求可以直接推荐一首，不要追问更具体。
9. 用户直接点歌时要拆出歌手和歌名：例如“我要听王菲的主角”“我要听王菲《主角》”都填 artistQuery:"王菲", seedTitle:"主角", wantsMusic:true。用户只说“我要听主角”时填 seedTitle:"主角"。
10. “推荐几首陈默之歌曲”这类句子里，“陈默之”是艺人名，“几首”表示 targetCount:3。

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
- "推荐几首陈默之歌曲" → {"wantsMusic":true,"intentConfidence":0.96,"artistQuery":"陈默之","targetCount":3,"evidence":["几首","陈默之","歌曲"]}
- "我要听王菲的主角" → {"wantsMusic":true,"intentConfidence":0.98,"artistQuery":"王菲","seedTitle":"主角","targetCount":1,"evidence":["王菲","主角"]}
- "我想听主角" → {"wantsMusic":true,"intentConfidence":0.92,"seedTitle":"主角","targetCount":1,"evidence":["主角"]}
- "Maroon 5 那种偏轻快的" → {"wantsMusic":true,"intentConfidence":0.9,"artistQuery":"Maroon 5","moods":["轻快"],"targetCount":1,"evidence":["Maroon 5","轻快"]}
- "今天天气真不错" → {"wantsMusic":false,"intentConfidence":0.82,"evidence":[]}`

  const userPrompt = recentDialog
    ? `<recent_dialog>\n${recentDialog}\n</recent_dialog>\n\n用户这一句:${text}`
    : `用户这一句:${text}`

  const response = await withTimeout(
    completeChat(settings, [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ], { temperature: 0, signal: options.signal, timeoutMs: INTENT_LLM_TIMEOUT_MS, maxTokens: 200 }),
    INTENT_LLM_TIMEOUT_MS,
  )
  assertIntentActive(options.signal)
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

function parseTargetCount(text: string): number {
  return parseRequestedTrackCount(text).targetCount
}

export function parseIntent(text: string, options: IntentParseOptions = {}): RecommendationIntent {
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
  const inferEntities = options.inferEntities ?? true
  const directSong = inferEntities ? inferDirectSongRequest(text) : {}
  const seedTitle = inferEntities ? text.match(/《([^》]{1,40})》/)?.[1]?.trim() ?? directSong.seedTitle : undefined
  const artistQuery = inferEntities ? directSong.artistQuery ?? inferArtistQuery(text) : undefined
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
