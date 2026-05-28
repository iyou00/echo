import type { Track } from '../../../types/ipc'
import { getSettings } from '../../db/settings'
import { completeChat } from '../../llm/client'
import {
  mergeIntent,
  parseIntent,
  type IntentOverride,
  type RecommendationIntent,
} from '../../services/recommendation/intent'
import { normalizeText, unique } from '../music/identity'

export type ChatIntentKind =
  | 'direct_song'
  | 'artist_request'
  | 'similar_to_track'
  | 'mood_request'
  | 'scene_request'
  | 'casual_chat'
  | 'feedback_current_track'
  | 'clarification_needed'
  | 'out_of_scope'

export type ChatOutOfScopeTopic =
  | 'politics'
  | 'code'
  | 'translation'
  | 'math'
  | 'business'
  | 'academic'
  | 'other'

export interface ChatIntentClarification {
  reason: 'ambiguous_direct_song' | 'missing_artist' | 'unclear_reference'
  prompt: string
}

export interface ChatIntent {
  kind: ChatIntentKind
  confidence: number
  text: string
  wantsMusic: boolean
  recommendationIntent: RecommendationIntent
  llmIntentOverride?: IntentOverride
  seedTitle?: string
  artistQuery?: string
  targetCount: number
  moodTerms: string[]
  feedbackAction?: 'more_like_this' | 'not_right' | 'skip' | 'favorite'
  outOfScopeTopic?: ChatOutOfScopeTopic
  needsClarification?: ChatIntentClarification
}

export interface ChatIntentContext {
  currentTrack?: Track | null
  currentSceneKey?: string | null
}

const DIRECT_SONG_ACTION_PATTERN = /想听|想要听|要听|我要听|我想听|播放|放一下|放首|放一首|点播|给我放|帮我放/i
const MUSIC_ACTION_PATTERN = /推|推荐|来几首|来一首|来\s*\d+\s*首|来[一二两三四五六七八九十]\s*首|听什么|听啥|值得听|适合听|想听|想要听|要听|我要听|我想听|播放|能听|放点|放首|放一首|来点|找首|找一首|给我.*歌|帮我.*歌|接\s*\d*\s*首|歌单|music|song/i
const SIMILAR_PATTERN = /像|类似|相似|那种|那类|这类|这种感觉|同款|差不多|接近/i
const SCENE_PATTERN = /场景|专注|工作|午休|睡前|通勤|下班|雨天|独处|运动|提神|放松|发呆|随机|随便/i
const MUSIC_QUALITY_PATTERN = /慢|快|安静|热闹|循环|舒缓|缓和|轻|燃|激昂|高昂|亢奋|振奋|热血|澎湃|带感|节奏|动感|鼓点|有劲|提神|治愈|怀旧|英文|欧美|英语|粤语|广东|韩语|kpop|日语|华语|民谣|摇滚|说唱|电子/i
const EMOTION_PATTERN = /累|困|疲|睡|烦|燥|低落|emo|想哭|难过|伤心|开心|兴奋|阳光|孤独|焦虑|压力|失眠|无聊|烦躁|压抑/i
const FEEDBACK_REF_PATTERN = /这首|这歌|刚才|当前|现在这首|它|这个|上一首|错误的歌|错误的歌曲|放错|播错/i
const FAVORITE_PATTERN = /喜欢|爱听|不错|对味|收藏|留下|可以/i
const SKIP_PATTERN = /跳过|换一首|换首|下一首|切歌/i
const NOT_RIGHT_PATTERN = /不对|不太对|不好听|没感觉|别放|不喜欢|腻了|太吵|太慢|太快|错误|错歌|放错|播错/i
const MORE_LIKE_THIS_PATTERN = /类似|像这样|这种感觉|继续|再来|多来|同款/i
const CHAT_ROUTER_TIMEOUT_MS = 2500
const CHAT_ROUTER_HINT_PATTERN = /听|歌|曲|音乐|分享|来点|来一首|随便|推荐|推|播放|放首|找首|歌单|song|music/i
const GENERIC_TITLE_WORDS = new Set(['歌', '歌曲', '音乐', '作品', '那首', '这首', '一首', '几首', '来一首', '来几首'])
const ROUTER_ARTIST_ALIASES: Record<string, string> = {
  eason: '陈奕迅',
  jay: '周杰伦',
  jj: '林俊杰',
  jjlin: '林俊杰',
  maroon5: 'Maroon 5',
  maroon: 'Maroon 5',
  魔力红: 'Maroon 5',
}

const OUT_OF_SCOPE_PATTERNS: Array<{ topic: ChatOutOfScopeTopic; pattern: RegExp }> = [
  { topic: 'politics', pattern: /政治|总统|选举|特朗普|拜登|普京|习近平|台湾|中共|民主党|共和党|以色列|巴勒斯坦|乌克兰|俄罗斯/i },
  { topic: 'code', pattern: /代码|编程|bug|报错|typescript|javascript|python|react|electron|sql|算法/i },
  { topic: 'translation', pattern: /翻译|怎么说|英文怎么|日文怎么|韩文怎么/i },
  { topic: 'math', pattern: /数学|方程|积分|微分|概率|几何|证明|计算/i },
  { topic: 'business', pattern: /商业模式|创业|获客|增长|投放|融资|估值|竞品|转化率/i },
  { topic: 'academic', pattern: /论文|文献|研究|引用|摘要|学术|期刊/i },
]

function uniqueTerms(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)))
}

function detectMoodTerms(text: string, recommendationIntent: RecommendationIntent): string[] {
  const terms = [...recommendationIntent.moods, ...recommendationIntent.scenes]
  const directTerms = text.match(/累|困|疲|睡|烦|燥|低落|emo|想哭|难过|伤心|开心|兴奋|阳光|孤独|焦虑|压力|失眠|无聊|烦躁|压抑|放松|舒缓|治愈|怀旧|激昂|热血|提神|专注/g)
  if (directTerms) terms.push(...directTerms)
  return uniqueTerms(terms).slice(0, 8)
}

function classifyOutOfScope(text: string): ChatOutOfScopeTopic | undefined {
  for (const item of OUT_OF_SCOPE_PATTERNS) {
    if (item.pattern.test(text)) return item.topic
  }
  return undefined
}

function classifyFeedbackAction(text: string): ChatIntent['feedbackAction'] | undefined {
  if (NOT_RIGHT_PATTERN.test(text)) return 'not_right'
  if (SKIP_PATTERN.test(text)) return 'skip'
  if (MORE_LIKE_THIS_PATTERN.test(text)) return 'more_like_this'
  if (FAVORITE_PATTERN.test(text)) return 'favorite'
  return undefined
}

function directSongClarification(seedTitle: string, artistQuery?: string): ChatIntentClarification | undefined {
  if (artistQuery) return undefined
  if (seedTitle.length <= 6) return undefined
  if (!/[的是像给把和最温暖相遇拥抱]/.test(seedTitle)) return undefined
  return {
    reason: 'missing_artist',
    prompt: `我先确认一下，你要找的是完整歌名《${seedTitle}》吗？有歌手名的话也发我一下。`,
  }
}

function assertChatRouterActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('任务已取消', 'AbortError')
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

function stringValue(value: unknown): string | undefined {
  return typeof value === 'string' && value.trim() ? value.trim() : undefined
}

function numberValue(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined
}

function normalizeRouterTitle(value: unknown): string | undefined {
  const title = stringValue(value)
  if (!title) return undefined
  const generic = normalizeText(title.replace(/[吧吗呢呀啊呗啦咯喽]$/i, ''))
  if (GENERIC_TITLE_WORDS.has(generic)) return undefined
  return title.slice(0, 40)
}

function sourceContainsNormalizedValue(source: string, value: string): boolean {
  const normalizedSource = normalizeText(source)
  const normalizedValue = normalizeText(value)
  return Boolean(normalizedSource && normalizedValue && normalizedSource.includes(normalizedValue))
}

function sourceSupportsArtist(source: string, artist: string | undefined): artist is string {
  if (!artist) return false
  if (sourceContainsNormalizedValue(source, artist)) return true
  const normalizedSource = normalizeText(source)
  const normalizedArtist = normalizeText(artist)
  return Object.entries(ROUTER_ARTIST_ALIASES).some(([alias, canonical]) => (
    normalizedSource.includes(normalizeText(alias))
    && (normalizeText(canonical) === normalizedArtist || normalizedArtist.includes(normalizeText(alias)))
  ))
}

function sourceSupportsTitle(source: string, title: string | undefined): title is string {
  if (!title) return false
  return sourceContainsNormalizedValue(source, title)
}

function normalizeRouterKind(value: unknown): ChatIntentKind | undefined {
  const kind = stringValue(value)
  if (
    kind === 'direct_song'
    || kind === 'artist_request'
    || kind === 'similar_to_track'
    || kind === 'mood_request'
    || kind === 'scene_request'
    || kind === 'casual_chat'
  ) {
    return kind
  }
  return undefined
}

function shouldUseLlmRouter(intent: ChatIntent): boolean {
  if (intent.kind === 'out_of_scope' || intent.kind === 'feedback_current_track') return false
  if (intent.kind === 'clarification_needed') return true
  if (intent.seedTitle && /歌|歌曲|音乐|作品/.test(intent.seedTitle)) return true
  if (intent.kind === 'direct_song' || intent.kind === 'artist_request' || intent.kind === 'similar_to_track' || intent.kind === 'scene_request') return false
  if (!CHAT_ROUTER_HINT_PATTERN.test(intent.text)) return false
  if (intent.wantsMusic && intent.confidence >= 0.84) return false
  return true
}

async function inferChatRouteWithLlm(text: string, signal?: AbortSignal): Promise<{
  kind: ChatIntentKind
  confidence: number
  wantsMusic: boolean
  override?: IntentOverride
} | null> {
  assertChatRouterActive(signal)
  const settings = getSettings()
  if (!settings.llm.baseUrl || !settings.llm.apiKey || !settings.llm.model) return null

  const content = await completeChat(settings, [
    {
      role: 'system',
      content: `你是 Echo 絮语入口的意图路由器。只输出 JSON,不要解释。

可选 kind:
- direct_song: 用户要播放某一首具体歌。
- artist_request: 用户想听某个歌手/乐队的任意歌曲。
- similar_to_track: 用户想要类似某首歌、某个歌手或当前播放的感觉。
- mood_request: 用户想听歌,但只给了心情、场景、泛泛请求。
- scene_request: 用户按工作、睡前、通勤、雨天等场景找歌。
- casual_chat: 普通聊天或纯情绪表达。

输出格式:
{"kind":"mood_request","wantsMusic":true,"confidence":0.92,"artistQuery":null,"seedTitle":null,"targetCount":1,"evidence":["原文短词"]}

规则:
1. 纯粹说心情,例如“我累了”“我有点烦”,kind 填 casual_chat,wantsMusic:false。
2. 带“歌/听/音乐/来一首/推荐/分享”等音乐意图时,wantsMusic:true。
3. “某歌手的歌/歌曲/音乐来一首”“随便来一首某歌手”是 artist_request,artistQuery 填歌手名,seedTitle 填 null。
4. “王菲的主角”“Nicky Youre 的 Part Time Lover”“我要听《主角》”是 direct_song。
5. “歌曲吧/歌吧/音乐吧/作品吧”是泛指词,不能当歌名。
6. 不确定歌名就 seedTitle:null,不要猜。
7. targetCount 默认 1,“几首”填 3,最多 5。

例子:
- 你随便来一首陈奕迅的歌曲吧 → {"kind":"artist_request","wantsMusic":true,"confidence":0.96,"artistQuery":"陈奕迅","seedTitle":null,"targetCount":1,"evidence":["随便","陈奕迅","歌曲"]}
- 有什么可以分享给我听的歌吗 → {"kind":"mood_request","wantsMusic":true,"confidence":0.9,"artistQuery":null,"seedTitle":null,"targetCount":1,"evidence":["分享","听","歌"]}
- 我要听王菲的主角 → {"kind":"direct_song","wantsMusic":true,"confidence":0.98,"artistQuery":"王菲","seedTitle":"主角","targetCount":1,"evidence":["王菲","主角"]}
- 我有点冷 → {"kind":"casual_chat","wantsMusic":false,"confidence":0.8,"artistQuery":null,"seedTitle":null,"targetCount":1,"evidence":[]}`,
    },
    { role: 'user', content: text },
  ], {
    temperature: 0,
    signal,
    timeoutMs: CHAT_ROUTER_TIMEOUT_MS,
    maxTokens: 200,
  }).catch((error) => {
    if (!signal?.aborted) {
      console.warn('[chat-router] llm route unavailable', error instanceof Error ? error.message : error)
    }
    return null
  })
  assertChatRouterActive(signal)
  if (!content) return null

  const parsed = parseJsonObject(content)
  if (!parsed) return null
  const kind = normalizeRouterKind(parsed.kind)
  if (!kind) return null
  const confidence = Math.max(0, Math.min(1, numberValue(parsed.confidence) ?? 0.5))
  const wantsMusic = typeof parsed.wantsMusic === 'boolean' ? parsed.wantsMusic : kind !== 'casual_chat'
  const parsedArtistQuery = stringValue(parsed.artistQuery)?.slice(0, 40)
  const parsedSeedTitle = normalizeRouterTitle(parsed.seedTitle)
  const artistQuery = sourceSupportsArtist(text, parsedArtistQuery) ? parsedArtistQuery : undefined
  const seedTitle = sourceSupportsTitle(text, parsedSeedTitle) ? parsedSeedTitle : undefined
  const targetCount = Math.max(1, Math.min(5, Math.floor(numberValue(parsed.targetCount) ?? 1)))
  const evidence = Array.isArray(parsed.evidence)
    ? unique(parsed.evidence.map(String).map((item) => item.trim()).filter(Boolean)).slice(0, 6)
    : undefined
  const override: IntentOverride = {}
  if (wantsMusic) override.wantsMusic = true
  if (artistQuery) override.artistQuery = artistQuery
  if (seedTitle) override.seedTitle = seedTitle
  if (targetCount) override.targetCount = targetCount
  if (evidence?.length) override.evidence = evidence
  if (confidence) override.intentConfidence = confidence
  let normalizedKind = kind
  if (seedTitle) normalizedKind = 'direct_song'
  else if (artistQuery && kind !== 'similar_to_track') normalizedKind = 'artist_request'
  else if (kind === 'direct_song' || kind === 'artist_request') normalizedKind = 'mood_request'
  return {
    kind: normalizedKind,
    confidence,
    wantsMusic,
    override: Object.keys(override).length > 0 ? override : undefined,
  }
}

export async function refineChatIntentWithLlm(intent: ChatIntent, context: ChatIntentContext = {}, signal?: AbortSignal): Promise<ChatIntent> {
  if (!shouldUseLlmRouter(intent)) return intent
  const route = await inferChatRouteWithLlm(intent.text, signal)
  if (!route || route.confidence < 0.72) return intent
  const recommendationIntent = route.override
    ? mergeIntent(intent.recommendationIntent, route.override)
    : intent.recommendationIntent
  const moodTerms = detectMoodTerms(intent.text, recommendationIntent)
  const needsClarification = route.kind === 'direct_song' && recommendationIntent.seedTitle
    ? directSongClarification(recommendationIntent.seedTitle, recommendationIntent.artistQuery)
    : undefined
  return {
    ...intent,
    kind: needsClarification ? 'clarification_needed' : route.kind,
    confidence: Math.max(intent.confidence, route.confidence),
    wantsMusic: route.wantsMusic,
    recommendationIntent,
    llmIntentOverride: route.override,
    seedTitle: recommendationIntent.seedTitle,
    artistQuery: recommendationIntent.artistQuery,
    targetCount: recommendationIntent.targetCount,
    moodTerms,
    needsClarification,
    feedbackAction: context.currentTrack ? intent.feedbackAction : undefined,
  }
}

export function classifyChatIntent(text: string, context: ChatIntentContext = {}): ChatIntent {
  const trimmed = text.trim()
  const recommendationIntent = parseIntent(trimmed)
  const seedTitle = recommendationIntent.seedTitle
  const artistQuery = recommendationIntent.artistQuery
  const hasMusicAction = MUSIC_ACTION_PATTERN.test(trimmed)
  const hasDirectSongAction = DIRECT_SONG_ACTION_PATTERN.test(trimmed)
  const hasSimilarSignal = SIMILAR_PATTERN.test(trimmed)
  const hasSceneSignal = SCENE_PATTERN.test(trimmed)
  const hasMusicQuality = MUSIC_QUALITY_PATTERN.test(trimmed)
  const hasEmotionSignal = EMOTION_PATTERN.test(trimmed)
  const moodTerms = detectMoodTerms(trimmed, recommendationIntent)
  const targetCount = recommendationIntent.targetCount
  const outOfScopeTopic = classifyOutOfScope(trimmed)

  const feedbackAction = context.currentTrack && (FEEDBACK_REF_PATTERN.test(trimmed) || MORE_LIKE_THIS_PATTERN.test(trimmed))
    ? classifyFeedbackAction(trimmed)
    : undefined
  if (feedbackAction) {
    return {
      kind: 'feedback_current_track',
      confidence: 0.92,
      text: trimmed,
      wantsMusic: feedbackAction === 'more_like_this' || feedbackAction === 'skip',
      recommendationIntent,
      seedTitle,
      artistQuery,
      targetCount,
      moodTerms,
      feedbackAction,
    }
  }

  if (outOfScopeTopic && !hasMusicAction && !seedTitle) {
    return {
      kind: 'out_of_scope',
      confidence: 0.88,
      text: trimmed,
      wantsMusic: false,
      recommendationIntent,
      seedTitle,
      artistQuery,
      targetCount,
      moodTerms,
      outOfScopeTopic,
    }
  }

  if (seedTitle && hasDirectSongAction && !hasSimilarSignal) {
    const needsClarification = directSongClarification(seedTitle, artistQuery)
    return {
      kind: needsClarification ? 'clarification_needed' : 'direct_song',
      confidence: artistQuery ? 0.96 : 0.88,
      text: trimmed,
      wantsMusic: true,
      recommendationIntent,
      seedTitle,
      artistQuery,
      targetCount,
      moodTerms,
      needsClarification,
    }
  }

  if (hasSimilarSignal && (seedTitle || artistQuery || context.currentTrack || hasMusicAction)) {
    return {
      kind: 'similar_to_track',
      confidence: 0.9,
      text: trimmed,
      wantsMusic: true,
      recommendationIntent,
      seedTitle,
      artistQuery,
      targetCount,
      moodTerms,
    }
  }

  if (hasSceneSignal && hasMusicAction) {
    return {
      kind: 'scene_request',
      confidence: 0.86,
      text: trimmed,
      wantsMusic: true,
      recommendationIntent,
      seedTitle,
      artistQuery,
      targetCount,
      moodTerms,
    }
  }

  if (artistQuery && hasMusicAction) {
    return {
      kind: 'artist_request',
      confidence: 0.9,
      text: trimmed,
      wantsMusic: true,
      recommendationIntent,
      seedTitle,
      artistQuery,
      targetCount,
      moodTerms,
    }
  }

  if (hasMusicAction || hasMusicQuality || hasEmotionSignal) {
    return {
      kind: 'mood_request',
      confidence: hasMusicAction || hasMusicQuality ? 0.82 : 0.68,
      text: trimmed,
      wantsMusic: hasMusicAction || hasMusicQuality,
      recommendationIntent,
      seedTitle,
      artistQuery,
      targetCount,
      moodTerms,
    }
  }

  return {
    kind: 'casual_chat',
    confidence: 0.72,
    text: trimmed,
    wantsMusic: false,
    recommendationIntent,
    seedTitle,
    artistQuery,
    targetCount,
    moodTerms,
  }
}
