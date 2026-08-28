import type { WebContents } from 'electron'
import type { RuntimeTaskSnapshot, SendChatResult, Track } from '../../../types/ipc'
import { appendConversation, loadRecentConversations } from '../../db/conversations'
import { getSettings } from '../../db/settings'
import { getState as getPlaybackState } from '../playback'
import { getCurrentScene } from '../scene'
import { attachSceneAdjustmentTracks } from '../sceneJourney'
import { applyMemorySignal } from '../memoryPolicy'
import { recordFeedback } from '../feedback'
import { getWeather } from '../../weather/client'
import {
  capturePendingQuestionAnswer,
  getPendingTasteQuestionContext,
  type PendingQuestionReplyCapture,
} from '../tasteQuestionScheduler'
import { checkJailbreak, pickJailbreakResponse } from '../safety/jailbreak-filter'
import {
  classifyFallbackChatIntent,
  fallbackChatIntent,
  resolvePreLlmChatIntent,
  routeChatIntentWithLlm,
  type ChatContinuationTarget,
  type ChatIntent,
  type ChatIntentContext,
  type ChatIntentKind,
} from './intent'
import type { ChatActiveTask } from './recommendationCandidates'
import {
  clearPendingDirectSongState,
  getPendingIntentContext,
  isPendingIntentCancelReply,
  resolvePendingDirectSongChoiceReply,
  resolvePendingDirectSongReply,
  resolvePendingMusicEntityReply,
  resolvePendingTrackPreferenceReply,
  setPendingMusicEntityClarification,
  setPendingTrackPreferenceClarification,
} from './pendingIntents'
import { appendAssistantReply } from './reply'
import {
  sanitizeAssistantOutput,
  streamPendingAnswerReply,
} from './responseStream'
import { handleCurrentTrackFeedback, trackLabel } from './trackFeedback'
import {
  getChatMusicSessionSnapshot,
  rememberChatMusicSession,
  resolveSessionMusicFollowUp,
  type SessionMusicFollowUp,
} from './sessionContext'
import { prepareCandidateStage } from './candidateStage'
import { runRecommendationResponseStage } from './responseStage'
import type { PendingIntentState, ReplyFn } from './sendPipelineTypes'
import {
  applyCompanionResponseStyle,
  loadCompanionResponseBrief,
  type CompanionResponseBrief,
} from './companionResponse'
import {
  applyCompanionPreferenceSignals,
  getCompanionProfile,
  loadLatestAssistantResponseStrategy,
} from '../../db/companion'
import type { CompanionResponseStrategy } from './companionTypes'
import { composePlannedReply } from './plannedReply'
import { inferCompanionReactionSignals } from './companionStrategy'
import { MUSIC_LANGUAGE_VALUES } from '../recommendation/language'
import { loadActiveStageContext } from '../../domain/stageContext/repository'
import { applyStageContextProposal } from '../../domain/stageContext/service'
import {
  applyWeatherToChatIntent,
  availableWeatherContext,
  isWeatherAwareMusicRequest,
  unavailableWeatherContext,
  type RecommendationWeatherContext,
} from './weatherRecommendation'
import { translateUserInput, type TranslatedInput } from './inputTranslator'
import { createUiBoundary } from '../../../shared/uiBoundary'

type ActiveChat = ChatActiveTask

/**
 * 翻译器不得改判的确定性意图：天气/身份/越界。
 * 这三类本身不是音乐请求，翻译器若误判出 searchQuery，一律以确定性层为准。
 */
const TRANSLATION_IMMUNE_KINDS: ReadonlySet<ChatIntentKind> = new Set(['weather', 'identity', 'out_of_scope'])

/**
 * 翻译器只能补充、不能改写的意图。这三类各自对应一条独立的推荐管线或追问流程，
 * 被改掉就是整条管线失效，不是降级：
 * - `similar_to_track` → `recommendationCandidates.ts` 的 similar-to-track 管线
 * - `feedback_current_track` → 当前曲目反馈重选 + 同上管线
 * - `clarification_needed` → 同名歌多版本的追问流程
 */
const TRANSLATION_PRESERVED_KINDS: ReadonlySet<ChatIntentKind> = new Set([
  'feedback_current_track',
  'similar_to_track',
  'clarification_needed',
])

/**
 * 把翻译器的结果合并进确定性层的基础意图。
 *
 * 确定性优先，翻译只补充不改写：
 * - 确定性层判为非音乐（天气/身份/越界）→ 翻译器再怎么说是音乐也不改判
 * - 确定性层判为独立管线对应的 kind → 保留该 kind，只并入翻译出的搜索词与实体
 * - 其余 → 按翻译出的实体推导 kind
 *
 * 返回 null 表示翻译结果不生效（没有搜索词）。
 * 详见 specs/routing-layering-design.md §5.2。
 */
export function mergeTranslatedIntent(base: ChatIntent, translated: TranslatedInput): ChatIntent | null {
  if (!translated.searchQuery) return null
  if (TRANSLATION_IMMUNE_KINDS.has(base.kind)) return base

  const preserved = TRANSLATION_PRESERVED_KINDS.has(base.kind)
  const intent: ChatIntent = {
    ...base,
    kind: preserved
      ? base.kind
      : translated.title
        ? 'direct_song'
        : translated.artist
          ? 'artist_request'
          : 'mood_request',
    // 当前曲目反馈里，「收藏」「不对但不想换」都不该触发放歌，尊重确定性层
    wantsMusic: preserved ? base.wantsMusic : true,
    confidence: 0.92,
    routeSource: 'llm',
    artistQuery: translated.artist ?? base.artistQuery,
    seedTitle: translated.title ?? base.seedTitle,
    moodTerms: translated.searchQuery.split(' ').slice(0, 2),
    intentDescription: translated.intent ?? undefined,
  }
  intent.recommendationIntent = {
    ...base.recommendationIntent,
    searchQuery: translated.searchQuery,
    seedTitle: translated.title ?? base.recommendationIntent.seedTitle,
    artistQuery: translated.artist ?? base.recommendationIntent.artistQuery,
  }
  if (!preserved) {
    // searchQuery 必须进 llmIntentOverride 才能到达召回层：
    // fetchRecommendationCandidates 只把 override 传给 searchMusic（顺带短路
    // inferMusicSearchIntent 的第二次 LLM 调用），recall 的 keywordFromIntent
    // 也只消费 mergeIntent 后的 intent.searchQuery。只写在 recommendationIntent
    // 上没有任何下游读取。clear* 防止 validateIntentOverride 把规则层从原话
    // 猜的实体（描述性短语被当歌名）补回搜索意图。
    // preserved 的三条独立管线不走这里：管线自带实体语义，翻译器不越权。
    intent.llmIntentOverride = {
      wantsMusic: true,
      searchQuery: translated.searchQuery,
      artistQuery: translated.artist ?? undefined,
      seedTitle: translated.title ?? undefined,
      // 只有翻译器和确定性层都没有实体时才 clear：翻译器漏抽时不能误杀
      // 确定性层抽到的实体——override 的 clear* 会在 recommendFromNetease 的
      // mergeIntent 里 delete 掉 parseIntent 重新抽取的实体（「实体只补充不清空」
      // 契约在搜索层同样要守住）。
      clearArtistQuery: !translated.artist && !base.artistQuery,
      clearSeedTitle: !translated.title && !base.seedTitle,
      intentConfidence: 0.92,
      evidence: ['输入翻译器'],
    }
  }
  return intent
}

function identityReply(): string {
  return '我是 Echo，你电脑里的 AI 音乐伴侣。可以陪你聊当下的状态，帮你找歌、推荐歌，也会慢慢记住你喜欢什么声音。'
}

function normalizedContains(left: string | undefined, right: string | undefined): boolean {
  const normalizedLeft = (left ?? '').toLowerCase().replace(/\s+/g, '')
  const normalizedRight = (right ?? '').toLowerCase().replace(/\s+/g, '')
  return Boolean(normalizedLeft && normalizedRight && (normalizedLeft.includes(normalizedRight) || normalizedRight.includes(normalizedLeft)))
}

function isPositiveExplicitTrackPreference(text: string, intent: ChatIntent, currentTrack: Track | null | undefined): boolean {
  if (!intent.seedTitle) return false
  if (/不喜欢|不爱听|不太喜欢|不是很喜欢|没那么喜欢|不好听|没感觉|不对|听不下/.test(text)) return false
  if (!/(喜欢|爱听|蛮喜欢|挺喜欢|很喜欢|还蛮|对味|常听|循环)/.test(text)) return false
  if (intent.wantsMusic && /想听|想要听|要听|我要听|播放|放一下|放首|放一首|点播|给我放|帮我放|来一首|推荐|推/.test(text)) return false
  if (!currentTrack) return true
  const titleMatches = normalizedContains(currentTrack.title, intent.seedTitle)
  const artistMatches = intent.artistQuery ? normalizedContains(currentTrack.artist, intent.artistQuery) : true
  return !(titleMatches && artistMatches)
}

async function rememberExplicitTrackPreference(text: string, artistQuery: string | undefined, seedTitle: string, reply: ReplyFn): Promise<SendChatResult> {
  await applyMemorySignal('like_track', {
    artist: artistQuery,
    title: seedTitle,
    target: [artistQuery, seedTitle].filter(Boolean).join(' / '),
    strength: 0.1,
    note: text.slice(0, 120),
  }, { source: 'chat' })
  const label = artistQuery ? `${artistQuery}的《${seedTitle}》` : `《${seedTitle}》`
  return reply(`记住了，你喜欢${label}。以后再找歌，我会把这条偏好放进去。`)
}

async function handleExplicitTrackPreference(text: string, intent: ChatIntent, currentTrack: Track | null | undefined, reply: ReplyFn): Promise<SendChatResult | null> {
  if (!isPositiveExplicitTrackPreference(text, intent, currentTrack)) return null
  const seedTitle = intent.seedTitle
  if (!seedTitle) return null
  if (!intent.artistQuery) {
    setPendingTrackPreferenceClarification(seedTitle, text)
    return reply(`我先确认一下，《${seedTitle}》是哪位歌手的？你回歌手名，我再把这个偏好记准。`)
  }
  return rememberExplicitTrackPreference(text, intent.artistQuery, seedTitle, reply)
}

async function buildWeatherReply(settings: ReturnType<typeof getSettings>, signal: AbortSignal): Promise<string> {
  const city = settings.user.city.trim()
  if (!city) return '我还没有你的天气城市。去设置里填一下城市，我之后就能按那个地方看天气。'
  const weather = await getWeather(city, { signal, timeoutMs: 6000 })
  if (!weather) return `我刚才没拿到${city}的实时天气。设置里的城市已经有了，可能是天气服务这会儿没回。`
  const temperatureNote = Number.isFinite(weather.tempC)
    ? weather.tempC <= 5
      ? '外面偏冷，出门多加一层。'
      : weather.tempC >= 30
        ? '温度有点高，出门记得带水。'
        : '这个温度还算好走。'
    : ''
  const humidityNote = Number.isFinite(weather.humidity) && weather.humidity >= 75 ? '湿度也偏高，体感可能会更闷一点。' : ''
  return [`${city}现在${weather.summary}。`, temperatureNote, humidityNote].filter(Boolean).join('')
}

function outOfScopeContent(intent: ChatIntent): string {
  switch (intent.outOfScopeTopic) {
    case 'politics':
      return '这个话题太硬，容易把我们带离音乐和当下感受。你可以把此刻的情绪直接说给我，我按那个状态陪你聊。'
    case 'code':
      return '代码问题我先收住。这里更适合聊你此刻的状态、想听的歌，或者让 Echo 给你找一首贴近现在的音乐。'
    case 'translation':
      return '翻译类问题我先收住。你可以直接说想听中文、英文、粤语、日语，或者说一个情绪，我按音乐方向接。'
    case 'math':
    case 'academic':
    case 'business':
      return '这个问题偏分析任务。你可以把现在的心情、场景、想听的歌手或歌名发给我，我按音乐陪伴的方式回应。'
    default:
      return '这个话题有点偏离 Echo 的音乐陪伴范围。你可以直接说现在的感受，或者说想听什么歌。'
  }
}

function attachSceneToTracks(tracks: Track[]): Track[] {
  const scene = getCurrentScene()
  if (!scene || tracks.length === 0) return tracks
  return attachSceneAdjustmentTracks(scene, tracks)
}

const CHAT_MEMORY_GENRE_TERMS = ['流行', ...MUSIC_LANGUAGE_VALUES, '欧美', '英文', 'R&B', 'r&b', '说唱', '摇滚', '民谣', '电子', '爵士', '古典', '轻音乐']
const CHAT_MEMORY_VIBE_TERMS = [
  '安静',
  '舒缓',
  '轻快',
  '治愈',
  '放松',
  '松弛',
  '清醒',
  '热烈',
  '激情',
  '激昂',
  '高昂',
  '节奏感',
  '慢一点',
  '快一点',
  '夜晚',
  '睡前',
  '提神',
  '温柔',
  '温暖',
  '暖心',
  '暖和',
  '悲伤',
  '伤感',
  '难过',
  '低落',
  '压抑',
  '孤独',
  '明亮',
  '阳光',
  '欢快',
  '甜',
  '梦幻',
  '空灵',
]
const CHAT_MEMORY_FOCUS_TERMS = ['人声', '声音', '嗓音', '唱腔', '旋律', '歌词', '编曲', '制作', '氛围', '气质', '节奏', '鼓点', '律动']
const CHAT_MEMORY_PRECISE_DIRECTION_PATTERN = /音墙|过亮|太亮|太暗|太吵|太闷|太厚|压迫|刺耳|噪|糊成|糊在|糊/
const CHAT_MEMORY_GENERIC_TARGET = /这首|这个|这种|这类|那首|那个|那种|那类|感觉|味道|方向|情绪|心情|今天|现在|最近|有点|太|更|比较|可以|能不能|推荐|播放|听|放|换|歌曲|音乐|作品|一首|几首/
const CHAT_MEMORY_ARTIST_PATTERN = /^[A-Za-z0-9 .&'’\-\u4e00-\u9fa5]{2,32}$/
const CURRENT_TRACK_REFERENCE_PATTERN = /这首歌|这首|这歌|刚才|当前|现在这首|上一首|这个歌|这版|刚刚那首|放错|播错|错歌/
const TRACK_REJECTION_PATTERN = /不好听|不喜欢|没感觉|不对|不太对|不合适|不太合适|别放|不听|腻了|太吵|太慢|太快|错误|错歌|放错|播错/
const TRACK_LIKE_PATTERN = /喜欢|爱听|蛮喜欢|挺喜欢|很喜欢|还蛮|对味|常听|循环/
const TRACK_DISLIKE_PATTERN = /不喜欢|不爱听|不太喜欢|不是很喜欢|没那么喜欢|不好听|没感觉|不对|听不下/

export interface ChatTasteSignal {
  kind:
    | 'like_artist'
    | 'unlike_artist'
    | 'like_track'
    | 'unlike_track'
    | 'like_genre'
    | 'unlike_genre'
    | 'reinforce_vibe'
    | 'unlike_vibe'
    | 'event_started'
    | 'event_ended'
  payload: Record<string, unknown>
}

const EMOTION_EVENT_PATTERNS: Array<{ pattern: RegExp; target: string }> = [
  { pattern: /有点冷|觉得冷|心里冷|好冷|太冷|冷得/i, target: '觉得有点冷' },
  { pattern: /好累|有点累|累了|累死|很累|疲惫|没力气/i, target: '觉得累' },
  { pattern: /困了|有点困|很困|睡不着|失眠/i, target: '困或睡不好' },
  { pattern: /很烦|有点烦|烦躁|焦虑|压力|压抑/i, target: '有点烦或压力' },
  { pattern: /难过|伤心|想哭|emo|低落/i, target: '情绪偏低' },
  { pattern: /开心|兴奋|心情不错|挺高兴/i, target: '心情不错' },
]
const EMOTION_EVENT_END_PATTERNS: Array<{ pattern: RegExp; target: string }> = [
  { pattern: /不冷了|没那么冷了?|暖和了|缓过来了/i, target: '冷' },
  { pattern: /不累了|没那么累了?|休息好了|有力气了/i, target: '累' },
  { pattern: /不困了|没那么困了?|睡醒了|清醒了/i, target: '困' },
  { pattern: /不烦了|没那么烦了?|没那么焦虑了?|没那么压抑了?/i, target: '烦' },
  { pattern: /好多了|没事了|过去了|已经好了|舒服多了/i, target: '' },
]

function cleanChatMemoryTarget(value: string): string {
  return value
    .replace(/[《》“”"'‘’]/g, '')
    .replace(/^(我|你|给我|最近|现在|其实|还是|就是|有点|很|挺|太|比较|更|多来点|少来点|别推|不要|听)\s*/, '')
    .replace(/(?:的)?(?:歌|歌曲|音乐|作品|这种|这类|那种|那类|一点|点|吧|了|啊|呀|呢)$/i, '')
    .replace(/[，。！？?！,.].*$/, '')
    .trim()
}

function pickKnownTerm(text: string, terms: string[]): string | undefined {
  return terms.find((term) => text.toLowerCase().includes(term.toLowerCase()))
}

function classifyMemoryTarget(raw: string): { kind: 'artist' | 'genre' | 'vibe'; target: string } | null {
  const target = cleanChatMemoryTarget(raw)
  if (!target) return null
  const focus = pickKnownTerm(target, CHAT_MEMORY_FOCUS_TERMS)
  if (focus) return { kind: 'vibe', target: focus }
  const genre = pickKnownTerm(target, CHAT_MEMORY_GENRE_TERMS)
  if (genre) {
    if (target !== genre && CHAT_MEMORY_PRECISE_DIRECTION_PATTERN.test(target)) {
      return { kind: 'vibe', target }
    }
    return { kind: 'genre', target: target.length <= 10 ? target : genre }
  }
  const vibe = pickKnownTerm(target, CHAT_MEMORY_VIBE_TERMS)
  if (vibe) return { kind: 'vibe', target: vibe }
  if (CHAT_MEMORY_GENERIC_TARGET.test(target)) return null
  if (!CHAT_MEMORY_ARTIST_PATTERN.test(target)) return null
  return { kind: 'artist', target }
}

function cleanExplicitTrackEntity(value: string): string {
  return cleanChatMemoryTarget(value)
    .replace(/^(?:的|是|就是)\s*/, '')
    .replace(/(?:这首|这歌|这个歌|这个首歌|这首歌|这首歌曲|这首作品|这首音乐|这首曲子)$/i, '')
    .trim()
}

function buildExplicitTrackTasteSignal(
  text: string,
  action: 'like' | 'unlike',
  artistRaw: string | undefined,
  titleRaw: string | undefined,
): ChatTasteSignal | null {
  const title = cleanExplicitTrackEntity(titleRaw ?? '')
  if (!title || CHAT_MEMORY_GENERIC_TARGET.test(title)) return null
  const artist = cleanExplicitTrackEntity(artistRaw ?? '').replace(/的$/, '').trim()
  if (artist && (!CHAT_MEMORY_ARTIST_PATTERN.test(artist) || CHAT_MEMORY_GENERIC_TARGET.test(artist))) return null
  return {
    kind: action === 'like' ? 'like_track' : 'unlike_track',
    payload: {
      artist: artist || undefined,
      title,
      target: [artist, title].filter(Boolean).join(' / ') || title,
      strength: action === 'like' ? 0.1 : 0.08,
      note: text.trim().slice(0, 120),
    },
  }
}

function explicitTrackPreferenceFromText(text: string): ChatTasteSignal | null {
  const trimmed = text.trim()
  const quoted = trimmed.match(new RegExp(`(?:${TRACK_DISLIKE_PATTERN.source})\\s*([^《》，。！？?！,.]{0,24})的?《([^》]{1,40})》`, 'i'))
    ?? trimmed.match(new RegExp(`([^《》，。！？?！,.]{0,24})的?《([^》]{1,40})》[^，。！？?！,.]{0,12}(?:${TRACK_DISLIKE_PATTERN.source})`, 'i'))
  if (quoted?.[2]) return buildExplicitTrackTasteSignal(trimmed, 'unlike', quoted[1], quoted[2])

  const likedQuoted = trimmed.match(new RegExp(`(?:${TRACK_LIKE_PATTERN.source})\\s*([^《》，。！？?！,.]{0,24})的?《([^》]{1,40})》`, 'i'))
    ?? trimmed.match(new RegExp(`([^《》，。！？?！,.]{0,24})的?《([^》]{1,40})》[^，。！？?！,.]{0,12}(?:${TRACK_LIKE_PATTERN.source})`, 'i'))
  if (likedQuoted?.[2]) return buildExplicitTrackTasteSignal(trimmed, 'like', likedQuoted[1], likedQuoted[2])

  const dislikedPair = trimmed.match(new RegExp(`(?:${TRACK_DISLIKE_PATTERN.source})\\s*([^《》，。！？?！,.]{1,24})的([^《》，。！？?！,.]{1,24})(?:这首|这歌|这个歌|这个首歌|这首歌|这首歌曲|这首作品|这首音乐|这首曲子)?`, 'i'))
    ?? trimmed.match(new RegExp(`([^《》，。！？?！,.]{1,24})的([^《》，。！？?！,.]{1,24}?)(?:这首|这歌|这个歌|这个首歌|这首歌|这首歌曲|这首作品|这首音乐|这首曲子)[^，。！？?！,.]{0,12}(?:${TRACK_DISLIKE_PATTERN.source})`, 'i'))
  if (dislikedPair?.[2]) return buildExplicitTrackTasteSignal(trimmed, 'unlike', dislikedPair[1], dislikedPair[2])

  const likedPair = trimmed.match(new RegExp(`(?:${TRACK_LIKE_PATTERN.source})\\s*([^《》，。！？?！,.]{1,24})的([^《》，。！？?！,.]{1,24})(?:这首|这歌|这个歌|这个首歌|这首歌|这首歌曲|这首作品|这首音乐|这首曲子)?`, 'i'))
    ?? trimmed.match(new RegExp(`([^《》，。！？?！,.]{1,24})的([^《》，。！？?！,.]{1,24}?)(?:这首|这歌|这个歌|这个首歌|这首歌|这首歌曲|这首作品|这首音乐|这首曲子)[^，。！？?！,.]{0,12}(?:${TRACK_LIKE_PATTERN.source})`, 'i'))
  if (likedPair?.[2]) return buildExplicitTrackTasteSignal(trimmed, 'like', likedPair[1], likedPair[2])

  return null
}

function emotionEventSignalFromText(text: string): ChatTasteSignal | null {
  const trimmed = text.trim()
  if (/不想听歌|先不听歌|只想聊|聊聊天|聊聊就好/.test(trimmed)) return null
  const match = EMOTION_EVENT_PATTERNS.find((item) => item.pattern.test(trimmed))
  if (!match) return null
  return {
    kind: 'event_started',
    payload: {
      target: match.target,
      note: trimmed.slice(0, 120),
      confidence: 0.64,
      strength: 0.08,
      weight: 0.32,
    },
  }
}

function emotionEventEndSignalFromText(text: string): ChatTasteSignal | null {
  const trimmed = text.trim()
  const match = EMOTION_EVENT_END_PATTERNS.find((item) => item.pattern.test(trimmed))
  if (!match) return null
  return {
    kind: 'event_ended',
    payload: {
      target: match.target,
      strength: 0.1,
      note: trimmed.slice(0, 120),
    },
  }
}

function explicitEntityDiffersFromCurrentTrack(intent: ChatIntent, currentTrack: Track | null | undefined): boolean {
  if (!currentTrack) return false
  if (!intent.seedTitle && !intent.artistQuery) return false
  const titleMatches = intent.seedTitle ? normalizedContains(currentTrack.title, intent.seedTitle) : true
  const artistMatches = intent.artistQuery ? normalizedContains(currentTrack.artist, intent.artistQuery) : true
  return !(titleMatches && artistMatches)
}

function shouldRecordCurrentTrackRejectionAlongsideExternalRequest(text: string, intent: ChatIntent, currentTrack: Track | null | undefined): currentTrack is Track {
  if (!currentTrack) return false
  if (intent.kind === 'feedback_current_track') return false
  if (!explicitEntityDiffersFromCurrentTrack(intent, currentTrack)) return false
  return CURRENT_TRACK_REFERENCE_PATTERN.test(text) && TRACK_REJECTION_PATTERN.test(text)
}

function buildChatTasteSignal(text: string, intent?: ChatIntent, currentTrack?: Track | null): ChatTasteSignal | null {
  const trimmed = text.trim()
  const emotionEnded = emotionEventEndSignalFromText(trimmed)
  if (emotionEnded) return emotionEnded

  const ended = trimmed.match(/(?:结束了|过去了|搞定了)\s*([^,，。.!！?？]{0,24})/)
  if (ended) {
    const target = cleanChatMemoryTarget(ended[1] || '当前事件')
    return { kind: 'event_ended', payload: { target, strength: 0.1, note: trimmed.slice(0, 120) } }
  }

  if (/(这种感觉|这个味道|这类歌|这个方向).{0,8}(再多|多来|可以多|继续)/.test(trimmed)) {
    const vibe = pickKnownTerm(trimmed, CHAT_MEMORY_VIBE_TERMS) ?? '当前偏好'
    return { kind: 'reinforce_vibe', payload: { vibe, target: vibe, strength: 0.08, note: trimmed.slice(0, 120) } }
  }

  const explicitTrackSignal = explicitTrackPreferenceFromText(trimmed)
  if (explicitTrackSignal) {
    if (
      explicitTrackSignal.kind === 'unlike_track'
      && intent
      && shouldRecordCurrentTrackRejectionAlongsideExternalRequest(trimmed, intent, currentTrack)
    ) return null
    if (
      explicitTrackSignal.kind === 'like_track'
      && intent?.seedTitle
      && normalizedContains(String(explicitTrackSignal.payload.title ?? ''), intent.seedTitle)
      && isPositiveExplicitTrackPreference(trimmed, intent, currentTrack)
    ) return null
    return explicitTrackSignal
  }

  if (intent?.seedTitle) {
    if (/不喜欢|不爱听|不太喜欢|不是很喜欢|没那么喜欢|不好听|没感觉|不对|听不下/.test(trimmed)) {
      if (shouldRecordCurrentTrackRejectionAlongsideExternalRequest(trimmed, intent, currentTrack)) return null
      return {
        kind: 'unlike_track',
        payload: {
          artist: intent.artistQuery,
          title: intent.seedTitle,
          target: [intent.artistQuery, intent.seedTitle].filter(Boolean).join(' / '),
          strength: 0.08,
          note: trimmed.slice(0, 120),
        },
      }
    }
    return null
  }

  const negative = trimmed.match(/(?:不喜欢|不爱听|别推|不要|少推|少来点|少来|腻了)\s*([^,，。.!！?？]{1,32})/)
    ?? trimmed.match(/([^,，。.!！?？]{2,32})(?:听腻了|腻了|少推|少来点)/)
  if (negative) {
    const classified = classifyMemoryTarget(negative[1] ?? '')
    if (!classified) return null
    const kind = classified.kind === 'artist' ? 'unlike_artist' : classified.kind === 'genre' ? 'unlike_genre' : 'unlike_vibe'
    const key = classified.kind === 'artist' ? 'artist' : classified.kind === 'genre' ? 'genre' : 'vibe'
    return { kind, payload: { [key]: classified.target, target: classified.target, strength: 0.08, note: trimmed.slice(0, 120) } }
  }

  const positive = trimmed.match(/(?:喜欢|爱听|最近迷上|新发现|多来点|再多点|可以多来点)\s*([^,，。.!！?？]{1,32})/)
    ?? trimmed.match(/([^,，。.!！?？]{2,32})(?:可以多来点|多来点|再多点)/)
  if (positive) {
    const classified = classifyMemoryTarget(positive[1] ?? '')
    if (!classified) return null
    const kind = classified.kind === 'artist' ? 'like_artist' : classified.kind === 'genre' ? 'like_genre' : 'reinforce_vibe'
    const key = classified.kind === 'artist' ? 'artist' : classified.kind === 'genre' ? 'genre' : 'vibe'
    return { kind, payload: { [key]: classified.target, target: classified.target, strength: 0.08, note: trimmed.slice(0, 120) } }
  }

  const emotionEvent = emotionEventSignalFromText(trimmed)
  if (emotionEvent) return emotionEvent

  return null
}

async function inferTasteSignal(text: string, intent: ChatIntent, currentTrack?: Track | null): Promise<void> {
  if (shouldRecordCurrentTrackRejectionAlongsideExternalRequest(text, intent, currentTrack)) {
    await recordFeedback(currentTrack, 'not_right', text)
  }
  const signal = buildChatTasteSignal(text, intent, currentTrack)
  if (!signal) return
  await applyMemorySignal(signal.kind, signal.payload, { source: 'chat' })
}

export const chatSendPipelineTestHelpers = {
  buildChatTasteSignal,
  isPositiveExplicitTrackPreference,
  mergeTranslatedIntent,
  shouldRecordCurrentTrackRejectionAlongsideExternalRequest,
  shouldUsePendingIntentFallback,
  shouldForcePendingIntentCancel: (text: string, hasPendingIntent: boolean) => (
    hasPendingIntent && isPendingIntentCancelReply(text)
  ),
}

async function handleStaticReply(input: {
  trimmed: string
  reply: ReplyFn
}): Promise<SendChatResult | null> {
  const jailbreak = checkJailbreak(input.trimmed)
  if (jailbreak.isJailbreak) return input.reply(pickJailbreakResponse(input.trimmed))
  return null
}

function resolvePendingIntentState(
  trimmed: string,
  continuationTarget?: ChatContinuationTarget,
  allowRuleFallback = false,
): PendingIntentState {
  const resolveDirectSong = allowRuleFallback || continuationTarget === 'direct_song'
  const resolveMusicEntity = allowRuleFallback || continuationTarget === 'music_entity'
  const resolveTrackChoice = allowRuleFallback || continuationTarget === 'track_choice'
  const pendingDirectSongReply = resolveDirectSong ? resolvePendingDirectSongReply(trimmed) : null
  const pendingMusicEntityReply = resolveMusicEntity && !pendingDirectSongReply?.query
    ? resolvePendingMusicEntityReply(trimmed)
    : null
  const pendingDirectSongChoiceReply = resolveTrackChoice && !pendingDirectSongReply?.query && !pendingMusicEntityReply?.query
    ? resolvePendingDirectSongChoiceReply(trimmed)
    : null
  return {
    pendingDirectSongReply,
    pendingMusicEntityReply,
    pendingDirectSongChoiceReply,
    effectiveText: pendingDirectSongReply?.query ?? pendingMusicEntityReply?.query ?? trimmed,
  }
}

function recentDialogBefore(messageId: number): Array<{ role: 'user' | 'assistant'; content: string }> {
  return loadRecentConversations(10)
    .filter((message) => message.id !== messageId)
    .slice(-8)
    .map((message) => ({ role: message.role, content: message.content.slice(0, 200) }))
}

function handlePendingIntentReply(state: PendingIntentState, reply: ReplyFn): SendChatResult | null {
  if (state.pendingDirectSongReply?.response) return reply(state.pendingDirectSongReply.response)
  if (state.pendingMusicEntityReply?.response) return reply(state.pendingMusicEntityReply.response)
  if (state.pendingDirectSongChoiceReply?.response) return reply(state.pendingDirectSongChoiceReply.response)
  if (state.pendingDirectSongChoiceReply?.track) {
    const tracks = attachSceneToTracks([state.pendingDirectSongChoiceReply.track])
    return reply(`好，就放${trackLabel(tracks[0])}。`, tracks, { persistTracks: true, expectsMusicAction: true })
  }
  return null
}

function shouldUsePendingIntentFallback(input: {
  hasPendingIntent: boolean
  routeSource: ChatIntent['routeSource']
  forcePendingCancel: boolean
}): boolean {
  return input.routeSource === 'rules' || input.forcePendingCancel
}

export async function runChatSendPipeline(
  text: string,
  sender: WebContents | undefined,
  signal: AbortSignal,
  runtimeEmit?: (channel: string, payload: unknown) => void,
  runtimeReport?: (patch: Partial<RuntimeTaskSnapshot>) => void,
): Promise<SendChatResult> {
  const trimmed = text.trim()
  if (!trimmed) throw new Error('消息不能为空')
  if (trimmed.length > 2000) throw new Error('这么长我得分两口气听,你要不分两次发?')
  const reply: ReplyFn = (content, tracks = [], options = {}) => appendAssistantReply({
    content,
    tracks,
    sender,
    runtimeEmit,
    ...options,
  })
  let companionResponseBrief: CompanionResponseBrief | null = null
  let responseStrategy: CompanionResponseStrategy | undefined
  const companionReply: ReplyFn = (content, tracks = [], options = {}) => reply(
    applyCompanionResponseStyle(content, trimmed, companionResponseBrief, responseStrategy),
    tracks,
    { ...options, responseStrategy: options.responseStrategy ?? responseStrategy },
  )

  runtimeReport?.({ phase: 'input', current: 1, total: 5, message: '记录用户消息' })
  const userMessage = appendConversation('user', trimmed)

  try {
    const playbackState = getPlaybackState()
    const currentPlaybackTrack = playbackState.current
    const settings = getSettings()
    const staticReply = await handleStaticReply({ trimmed, reply })
    if (staticReply) return staticReply
    companionResponseBrief = loadCompanionResponseBrief(trimmed)

    runtimeReport?.({ phase: 'intent', current: 2, total: 5, message: '理解这句话' })
    const pendingIntentContext = getPendingIntentContext()
    const pendingTasteQuestion = getPendingTasteQuestionContext()
    const musicSession = getChatMusicSessionSnapshot()
    const companionProfile = getCompanionProfile()
    const previousResponseStrategy = loadLatestAssistantResponseStrategy()
    const activeStageContext = loadActiveStageContext()
    // —— 确定性优先 ——
    // 情绪快速通道与已学到的先例不经过 LLM，必须让它们先于翻译器执行：
    // 否则会绕过夜间复盘学到的纠正（系统永远学不会），也会把今早修好的
    // 情绪快速通道架空。函数内部已按语种跳过非中文输入。
    // 详见 specs/routing-layering-design.md P0-1、决策 3。
    const preLlmIntent = resolvePreLlmChatIntent(trimmed)

    // —— 翻译制 ——
    // LLM 只做翻译（searchQuery + intent + entities），不做分类。
    // 翻译成功且有 searchQuery 时，直接组装 ChatIntent 跳过旧路由。
    // pendingIntent / pendingTasteQuestion 存在时一律走旧路由：多轮澄清与口味追问
    // 的承接语义由旧路由负责，翻译器不参与（见 specs/translate-architecture.md 风险 #4）。
    const translateRouterEnabled = settings.chat?.translateRouter !== false
    let translatedResult: TranslatedInput | null = null
    if (!preLlmIntent && translateRouterEnabled && !pendingIntentContext && !pendingTasteQuestion && trimmed.length >= 2) {
      translatedResult = await translateUserInput(trimmed, settings, {
        recentDialog: recentDialogBefore(userMessage.id),
        musicSession,
        currentTrack: currentPlaybackTrack ? { title: currentPlaybackTrack.title, artist: currentPlaybackTrack.artist } : null,
      }, signal)
    }

    // 三路归并：确定性层 → 翻译器 → 旧路由兜底
    const routeContext: ChatIntentContext = {
      currentTrack: currentPlaybackTrack,
      currentSceneKey: getCurrentScene()?.key,
      recentDialog: recentDialogBefore(userMessage.id),
      pendingIntent: pendingIntentContext,
      pendingTasteQuestion,
      musicSession,
      companionProfile,
      previousResponseStrategy,
      companionResponseBrief,
      currentConversationId: userMessage.id,
      activeStageContext,
    }
    let routedIntent: ChatIntent | null = preLlmIntent
    if (!routedIntent && translatedResult) {
      const base = classifyFallbackChatIntent(trimmed, { currentTrack: currentPlaybackTrack })
      routedIntent = mergeTranslatedIntent(base, translatedResult)
      if (routedIntent) {
        console.info(`[translator] routing: kind=${routedIntent.kind} sq=${translatedResult.searchQuery}`)
      }
    }
    if (!routedIntent && translatedResult) {
      // 翻译成功但明确不是音乐请求：语义判断已由翻译器完成，不再二次调用 LLM
      // 旧路由，直接用确定性兜底产出 kind 进回复生成（决策 2，省 1 次 LLM）。
      // 兜底内部含规则分类 + musicSession 承接：若规则层仍认定是音乐请求，
      // 以确定性层为准（确定性优先），行为与旧路由的规则路径完全一致。
      routedIntent = fallbackChatIntent(trimmed, routeContext)
      if (translatedResult.intent) routedIntent.intentDescription = translatedResult.intent
      console.info(`[translator] non-music: kind=${routedIntent.kind}`)
    }
    if (!routedIntent) {
      routedIntent = await routeChatIntentWithLlm(trimmed, routeContext, signal)
    }
    if (routedIntent.stageContextProposal) {
      applyStageContextProposal({
        proposal: routedIntent.stageContextProposal,
        allowedEvidenceConversationIds: [userMessage.id],
        evidenceStrength: 'proposed',
      })
    }
    responseStrategy = routedIntent.responseStrategy
    const companionSignals = [
      ...(routedIntent.companionSignals ?? []),
      ...inferCompanionReactionSignals(trimmed, previousResponseStrategy),
    ].filter((signal, index, items) => items.findIndex((item) => (
      item.dimension === signal.dimension && item.direction === signal.direction
    )) === index)
    if (companionSignals.length) {
      try {
        applyCompanionPreferenceSignals(companionSignals)
      } catch (error) {
        console.warn('[chat] companion preference persistence failed', error)
      }
    }
    const plannedCompanionReply = async (
      factualContent: string,
      tracks: Track[] = [],
      options: Parameters<ReplyFn>[2] = {},
      requiredDetails: string[] = [],
    ): Promise<SendChatResult> => {
      const content = await composePlannedReply({
        userText: trimmed,
        factualContent,
        settings,
        strategy: responseStrategy,
        tracks,
        requiredDetails,
        signal,
      })
      return reply(content, tracks, { ...options, responseStrategy })
    }
    runtimeEmit?.('runtime:chat-intent-routed', {
      kind: routedIntent.kind,
      source: routedIntent.routeSource,
      confidence: routedIntent.confidence,
      wantsMusic: routedIntent.wantsMusic,
      continuationTarget: routedIntent.continuationTarget,
    })

    const isLlmPendingReply = routedIntent.routeSource === 'llm' && routedIntent.kind === 'pending_reply'
    const forcePendingCancel = chatSendPipelineTestHelpers.shouldForcePendingIntentCancel(trimmed, Boolean(pendingIntentContext))
    const continuationTarget = isLlmPendingReply ? routedIntent.continuationTarget : undefined
    const allowRulePendingFallback = shouldUsePendingIntentFallback({
      hasPendingIntent: Boolean(pendingIntentContext),
      routeSource: routedIntent.routeSource,
      forcePendingCancel,
    })
    const pendingTrackPreferenceReply = continuationTarget === 'track_preference' || allowRulePendingFallback
      ? resolvePendingTrackPreferenceReply(trimmed)
      : null
    if (pendingTrackPreferenceReply?.response) return companionReply(pendingTrackPreferenceReply.response)
    if (pendingTrackPreferenceReply?.artistQuery) {
      return rememberExplicitTrackPreference(trimmed, pendingTrackPreferenceReply.artistQuery, pendingTrackPreferenceReply.seedTitle, companionReply)
    }

    const pendingState = resolvePendingIntentState(trimmed, continuationTarget, allowRulePendingFallback)
    const pendingIntentReply = handlePendingIntentReply(pendingState, companionReply)
    if (pendingIntentReply) return pendingIntentReply

    const { pendingDirectSongReply, pendingMusicEntityReply, effectiveText } = pendingState
    const resolvedPendingQuery = effectiveText !== trimmed
    const isFreshRoutedTopic = routedIntent.kind === 'weather'
      || routedIntent.kind === 'identity'
      || routedIntent.kind === 'out_of_scope'
      || (routedIntent.routeSource === 'llm' && !isLlmPendingReply)
    if (isFreshRoutedTopic && pendingIntentContext && !forcePendingCancel && !resolvedPendingQuery) clearPendingDirectSongState()
    if (routedIntent.kind === 'weather') {
      runtimeReport?.({ phase: 'weather', current: 3, total: 5, message: '查询设置城市天气' })
      const weatherContent = await buildWeatherReply(settings, signal)
      const city = settings.user.city.trim()
      const weatherNumbers = weatherContent.match(/-?\d+(?:\.\d+)?/g) ?? []
      const weatherFacts = weatherContent.match(/晴|多云|阴|小雨|中雨|大雨|暴雨|雷阵雨|雨夹雪|小雪|中雪|大雪|雾|霾/g) ?? []
      return plannedCompanionReply(weatherContent, [], {}, [...(city ? [city] : []), ...weatherNumbers, ...weatherFacts])
    }
    if (routedIntent.kind === 'identity') return companionReply(identityReply())
    if (routedIntent.kind === 'out_of_scope') return companionReply(outOfScopeContent(routedIntent))
    if (routedIntent.kind === 'clarification_needed' && routedIntent.needsClarification) {
      setPendingMusicEntityClarification({
        artistQuery: routedIntent.artistQuery,
        seedTitle: routedIntent.seedTitle,
        ambiguity: routedIntent.needsClarification.reason === 'ambiguous_direct_song'
          ? 'artist_or_title'
          : routedIntent.needsClarification.reason === 'missing_artist'
            ? 'missing_artist'
            : 'too_vague',
      }, trimmed)
      return plannedCompanionReply(
        routedIntent.needsClarification.prompt,
        [],
        {},
        routedIntent.seedTitle ? [routedIntent.seedTitle] : [],
      )
    }

    let initialChatIntent = resolvedPendingQuery
      ? classifyFallbackChatIntent(effectiveText, { currentTrack: currentPlaybackTrack })
      : routedIntent

    runtimeReport?.({ phase: 'taste', current: 2, total: 5, message: '更新口味信号' })
    inferTasteSignal(trimmed, initialChatIntent, currentPlaybackTrack).catch((error) => {
      console.warn('[chat] taste signal inference failed', error)
    })
    const shouldCaptureTasteAnswer = continuationTarget === 'taste_question' || allowRulePendingFallback
    const pendingReply: PendingQuestionReplyCapture = pendingDirectSongReply?.query || !shouldCaptureTasteAnswer
      ? { action: 'none' }
      : await capturePendingQuestionAnswer(trimmed, signal, continuationTarget === 'taste_question' ? routedIntent.pendingTasteAction : undefined)

    const shouldResolveMusicSession = continuationTarget === 'music_session' || allowRulePendingFallback
    const sessionFollowUp: SessionMusicFollowUp = shouldResolveMusicSession
      && pendingReply.action === 'none'
      && !pendingDirectSongReply?.query
      && !pendingMusicEntityReply?.query
      ? resolveSessionMusicFollowUp(trimmed)
      : { kind: 'none' }
    if (
      initialChatIntent.kind === 'pending_reply'
      && !resolvedPendingQuery
      && pendingReply.action === 'none'
      && sessionFollowUp.kind === 'none'
    ) {
      initialChatIntent = classifyFallbackChatIntent(trimmed, { currentTrack: currentPlaybackTrack })
    }
    if (sessionFollowUp.kind === 'play_track') {
      const tracks = attachSceneToTracks([sessionFollowUp.track])
      rememberChatMusicSession({
        sourceText: trimmed,
        intentKind: 'session_play',
        tracks,
        artistQuery: sessionFollowUp.track.artist,
        seedTitle: sessionFollowUp.track.title,
      })
      return plannedCompanionReply(
        sessionFollowUp.content,
        tracks,
        { persistTracks: true, expectsMusicAction: true },
        [sessionFollowUp.track.title, sessionFollowUp.track.artist],
      )
    }

    if (pendingReply.action === 'none' && initialChatIntent.kind === 'feedback_current_track' && currentPlaybackTrack) {
      const feedbackResult = await handleCurrentTrackFeedback(initialChatIntent, currentPlaybackTrack, trimmed, signal)
      if (feedbackResult.handled) {
        const feedbackTracks = feedbackResult.tracks.length > 0
          ? attachSceneToTracks(feedbackResult.tracks)
          : []
        if (feedbackTracks.length > 0) {
          rememberChatMusicSession({
            sourceText: trimmed,
            intentKind: initialChatIntent.kind,
            tracks: feedbackTracks,
            artistQuery: initialChatIntent.artistQuery,
            seedTitle: initialChatIntent.seedTitle,
          })
        }
        const feedbackOptions = {
          hints: feedbackResult.hints,
          persistTracks: feedbackTracks.length > 0,
          expectsMusicAction: feedbackTracks.length > 0 || initialChatIntent.wantsMusic,
        }
        if (feedbackTracks.length === 0) return companionReply(feedbackResult.content, feedbackTracks, feedbackOptions)
        return plannedCompanionReply(
          feedbackResult.content,
          feedbackTracks,
          feedbackOptions,
          feedbackTracks.flatMap((track) => [track.title, track.artist]),
        )
      }
    }

    if (pendingReply.action === 'none' && sessionFollowUp.kind === 'none') {
      const explicitPreferenceReply = await handleExplicitTrackPreference(trimmed, initialChatIntent, currentPlaybackTrack, companionReply)
      if (explicitPreferenceReply) return explicitPreferenceReply
    }

    const active: ActiveChat = {
      signal,
      get canceled() {
        return signal.aborted
      },
    }
    const emitChunk = (chunk: string) => {
      if (sender && !sender.isDestroyed()) sender.send('chat:stream:chunk', chunk)
      runtimeEmit?.('runtime:chat-stream-chunk', { chunk })
    }
    if (pendingReply.action === 'answer_only') {
      const started = Date.now()
      let content = await streamPendingAnswerReply(trimmed, pendingReply, active, settings, emitChunk, companionResponseBrief)
      content = sanitizeAssistantOutput(content)
      return reply(content.trim(), [], { durationMs: Date.now() - started, responseStrategy })
    }

    let recommendationWeatherContext: RecommendationWeatherContext | undefined
    if (isWeatherAwareMusicRequest(trimmed, initialChatIntent)) {
      runtimeReport?.({ phase: 'weather', current: 3, total: 5, message: '查询天气并生成选歌条件' })
      const city = settings.user.city.trim()
      if (!city) {
        recommendationWeatherContext = unavailableWeatherContext('')
      } else {
        const weather = await getWeather(city, { signal, timeoutMs: 6000 })
        recommendationWeatherContext = weather
          ? availableWeatherContext(city, weather)
          : unavailableWeatherContext(city)
      }
      initialChatIntent = applyWeatherToChatIntent(initialChatIntent, recommendationWeatherContext)
    }

    const candidateStage = await prepareCandidateStage({
      trimmed,
      effectiveText,
      initialChatIntent,
      pendingReply,
      pendingDirectSongReply,
      pendingMusicEntityReply,
      sessionFollowUp,
      currentPlaybackTrack,
      active,
      signal,
      reply: companionReply,
      attachSceneToTracks,
      runtimeReport,
      weatherContext: recommendationWeatherContext,
    })
    if (candidateStage.reply) return candidateStage.reply
    if (!candidateStage.ready) return plannedCompanionReply('我知道你是想听歌，但这次没拿到可播放的结果。')
    return runRecommendationResponseStage({
      trimmed,
      settings,
      active,
      signal,
      pendingReply,
      candidate: candidateStage.ready,
      currentPlaybackTrack,
      companionResponseBrief,
      responseStrategy,
      companionProfile,
      emitChunk,
      reply,
      attachSceneToTracks,
      runtimeReport,
      weatherContext: recommendationWeatherContext,
    })
  } catch (error) {
    if (signal.aborted) throw new DOMException('任务已取消', 'AbortError')
    console.error('[chat] send pipeline failed', error)
    runtimeEmit?.('runtime:chat-pipeline-failed', {
      message: error instanceof Error ? error.message : String(error),
    })
    return companionReply('我这会儿没接住这句话。你再说一遍，我重新听。', [], {
      hints: { runtimeFailure: true },
      boundary: createUiBoundary('task_failed'),
    })
  }
}
