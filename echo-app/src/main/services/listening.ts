import type { Track } from '../../types/ipc'
import { loadRecentConversations } from '../db/conversations'
import { loadActiveEvents, type ActiveEvent } from '../db/events'
import { appendRecommendedTracks, loadListenedTrackWindows, loadListenedTracksSince, loadRecentRecommendedTracks, loadRecentTracks } from '../db/tracks'
import { getAllImportedTracks } from '../db/playlists'
import { getTasteProfile } from '../db/taste'
import { getSettings } from '../db/settings'
import { getTrackSemantic } from '../db/semantics'
import { completeChat, LlmError } from '../llm/client'
import { stripKnownSystemBlocks } from '../llm/outputSanitize'
import { escapePromptData, safePromptJson } from '../llm/promptData'
import { filterPlayableTracks } from '../netease/music'
import { synthesize } from '../tts/client'
import { readRootFile } from '../utils/paths'
import { getMostRecentSeal } from './daySeal'
import { getWeather } from '../weather/client'
import { recordHealth } from './health'
import { inferTrackSemanticFallback } from './semantics'
import { buildMemoryEvidencePrompt } from './memoryEvidence'
import { hasMemorySourceLeak } from './memorySourceGuard'
import { chineseDayPeriodLabel } from '../../shared/dayPeriod'
import { stableDaySeed, stableInt, stableShuffle } from './recommendation/deterministic'
import {
  diversifyByArtist,
  hasTrackIdentity,
  primaryArtist,
  trackIdentityKeys,
  trackIdentitySet,
  uniqueTracks,
} from '../skills/music/identity'
import { searchMusic } from '../skills/music/search'
import { buildSoulPolicyPrompt } from '../skills/soul/policy'

interface ListeningText {
  text?: string
  selectedIndex?: number
}

export interface ListeningSegmentOptions {
  continuation?: boolean
  signal?: AbortSignal
  onProgress?: (patch: { phase?: string; current?: number; total?: number; message?: string }) => void
}

export type ListeningSegmentResult = {
  text: string
  track: Track | null
  audioUrl?: string
  error?: string
  generatedAt: string
}

function assertListeningActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('任务已取消', 'AbortError')
}

const recentScenarios: string[] = []
const recentTrackKeys: string[] = []
const STABLE_VOICE_BEHAVIOR_EVIDENCE_MIN = 3

interface SegmentSemantic {
  moods: string[]
  genres: string[]
  energy: number
  tempo: string
  artist: string
}

type VoiceMomentState =
  | 'fresh_install'
  | 'post_import_first_use'
  | 'daily_first'
  | 'after_tracks'
  | 'continuation'
  | 'emotion_context'

interface VoiceMoment {
  state: VoiceMomentState
  reason: string
  playedToday: number
  importedTrackCount: number
  hasRecommendationHistory: boolean
  hasTasteProfile: boolean
  isContinuation: boolean
  suggestedLength: string
}

const recentSegmentSemantics: SegmentSemantic[] = []
const recentArtists: string[] = []

let lastConversationFingerprint = ''

function recentBlockedKeys(recentListened = loadListenedTracksSince(24, 500)): Set<string> {
  const keys = trackIdentitySet([
    ...loadRecentRecommendedTracks(120),
    ...recentListened,
  ])
  for (const key of recentTrackKeys) keys.add(key)
  return keys
}

function semanticForTrack(track: Track): SegmentSemantic {
  const semantic = track.semantic ?? getTrackSemantic(track) ?? inferTrackSemanticFallback(track)
  return {
    moods: semantic.moods,
    genres: semantic.genres,
    energy: semantic.energy,
    tempo: semantic.tempo,
    artist: track.artist.split(/[/、,，&＋+]| feat\.?| ft\.?| and /i)[0]?.trim() ?? track.artist,
  }
}

function rememberScenario(text: string, track: Track | null) {
  recentScenarios.unshift(text)
  recentScenarios.splice(8)
  if (track) {
    recentTrackKeys.unshift(...trackIdentityKeys(track))
    recentTrackKeys.splice(36)
    recentSegmentSemantics.unshift(semanticForTrack(track))
    recentSegmentSemantics.splice(8)
    recentArtists.unshift(primaryArtist(track.artist))
    recentArtists.splice(8)
  }
}

function voiceSeed(label: string): string {
  return `${stableDaySeed()}:voice:${label}:${recentTrackKeys.slice(0, 12).join('|')}:${recentArtists.slice(0, 6).join('|')}`
}

function shuffled<T>(items: T[], seed: string, keyOf: (item: T, index: number) => string = (_item, index) => String(index)): T[] {
  return stableShuffle(items, seed, keyOf)
}

function parseJsonObject(content: string): ListeningText | null {
  const match = content.match(/\{[\s\S]*\}/)
  if (!match) return null
  try {
    return JSON.parse(match[0]) as ListeningText
  } catch {
    return null
  }
}

function normalizeText(content: string): string {
  return stripKnownSystemBlocks(content)
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```[a-z]*|```/gi, ''))
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^>\s*/, ''))
    .filter(Boolean)
    .join('')
    .replace(/^["“”'‘’]+|["“”'‘’]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function limitText(text: string): string {
  const trimmed = normalizeText(text)
  if (trimmed.length <= 300) return trimmed
  const sliced = trimmed.slice(0, 300)
  const lastStop = Math.max(sliced.lastIndexOf('。'), sliced.lastIndexOf('，'), sliced.lastIndexOf('、'), sliced.lastIndexOf('——'))
  return sliced.slice(0, lastStop > 180 ? lastStop + 1 : 300).trim()
}

const BANNED_LISTENING_TEXT_PATTERN = /我给你接上|给你安排|安排上|给你放一首|稳稳的|接住|撑住|沉淀|治愈的力量|完全理解你的心情|根据你的画像|根据你的轨迹|根据你的数据|太满|太猛|上头|燃爆|往里收|松开一点|空间感|音乐颜色|声音质地|情绪流动|拉你回来|缓一会儿|放下来/

function sentenceCount(text: string): number {
  return text
    .split(/[。！？!?]+/)
    .map((item) => item.trim())
    .filter(Boolean)
    .length
}

function hasListeningTextQuality(text: string): boolean {
  const compact = text.replace(/\s+/g, '')
  if (compact.length < 18 || compact.length > 300) return false
  if (sentenceCount(text) > 6) return false
  const firstTitleIndex = text.indexOf('《')
  if (firstTitleIndex < 0 || firstTitleIndex > 150) return false
  if (!text.includes('我') && !text.includes('你')) return false
  if (/(总的来说|由此可见|为您|用户|画像|轨迹|轮廓|数据|算法|记忆策略|纠正过|说明你|你其实|你总是|你一直|人格|诊断|标签)/.test(text)) return false
  if (hasMemorySourceLeak(text, { tail: '不喜欢|少推|别总|别老|纠正|画像|数据|轨迹|记忆' })) return false
  if (BANNED_LISTENING_TEXT_PATTERN.test(text)) return false
  if (/[-*#]|^\d+[.、]/m.test(text)) return false
  return true
}

function compactText(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[《》"'“”‘’·.,，。!！?？()（）\-_:：]/g, '')
}

function artistParts(artist: string): string[] {
  return artist
    .split(/[/、,，&＋+]| feat\.?| ft\.?| and /i)
    .map(compactText)
    .filter((item) => item.length >= 2)
}

function songLabel(track: Track): string {
  return `${track.artist}的《${track.title}》`
}

function replaceSongSentence(text: string, track: Track): string {
  const next = text.replace(/[^。！？!?\n]*《[^》]+》[^。！？!?\n]*(?:[。！？!?]|$)/, `那就听${songLabel(track)}。`)
  return next === text ? `${text.replace(/[。！？!?]*$/, '').trim()}。那就听${songLabel(track)}。` : next.trim()
}

function quotedTitles(text: string): string[] {
  return Array.from(text.matchAll(/《([^》]+)》/g))
    .map((match) => match[1]?.trim())
    .filter((title): title is string => Boolean(title))
}

function textMentionsTrack(text: string, track: Track | null): boolean {
  if (!track) return false
  const compactBody = compactText(text)
  const compactTitle = compactText(track.title)
  if (!compactTitle) return false
  if (!compactBody.includes(compactTitle)) return false
  const artists = artistParts(track.artist)
  return artists.length === 0 || artists.some((artist) => compactBody.includes(artist))
}

function pickTrackFromText(text: string, candidates: Track[], selectedIndex?: number): Track | null {
  const quoted = quotedTitles(text).map(compactText)
  for (const title of quoted) {
    const matchedByTitle = candidates.filter((track) => compactText(track.title) === title)
    const matchedByArtist = matchedByTitle.find((track) => textMentionsTrack(text, track))
    if (matchedByArtist) return matchedByArtist
    if (matchedByTitle[0]) return matchedByTitle[0]
  }

  const index = Number(selectedIndex ?? 0)
  if (Number.isFinite(index) && index >= 1) {
    return candidates[Math.max(0, Math.min(candidates.length - 1, index - 1))] ?? null
  }

  const compactBody = compactText(text)
  return candidates.find((track) => compactBody.includes(compactText(track.title))) ?? candidates[0] ?? null
}

function alignTextToTrack(text: string, track: Track | null): string {
  if (!track || textMentionsTrack(text, track)) return text
  const quoted = quotedTitles(text)
  let aligned = text
  if (quoted.length > 0) {
    for (const title of quoted) {
      aligned = aligned.split(`《${title}》`).join(`《${track.title}》`)
    }
    if (textMentionsTrack(aligned, track)) return aligned
    return replaceSongSentence(aligned, track)
  }
  const trimmed = aligned.replace(/[。！？!?]*$/, '').trim()
  return `${trimmed}。那就听${songLabel(track)}。`
}

function formatConversationTime(createdAt?: string) {
  if (!createdAt) return ''
  const date = new Date(createdAt)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
}

function hasVoiceBehaviorEvidence(profile: ReturnType<typeof getTasteProfile>): boolean {
  return voiceBehaviorEvidenceCount(profile) >= STABLE_VOICE_BEHAVIOR_EVIDENCE_MIN
}

function voiceBehaviorEvidenceCount(profile: ReturnType<typeof getTasteProfile>): number {
  const evidence = profile?.profile_meta?.statsEvidence
  if (!evidence) return 0
  return Math.max(
    evidence.feedbackTrackCount ?? 0,
    evidence.positiveEventCount ?? 0,
    evidence.energyBehaviorCount ?? 0,
    evidence.tempoBehaviorCount ?? 0,
    evidence.sceneEventCount ?? 0,
  )
}

function voiceTopArtistIntro(profile: ReturnType<typeof getTasteProfile>): string {
  const topArtist = profile?.artists?.[0]?.name
  if (!topArtist) return ''
  return hasVoiceBehaviorEvidence(profile)
    ? `你之前听过不少${topArtist}，`
    : `你的歌单里有不少${topArtist}，`
}

function withVoiceSourceContext(track: Track): Track {
  return {
    ...track,
    sourceContext: 'voice',
    reason: track.reason ?? '回声里 Echo 想到的这首。',
  }
}

function fallbackText(track: Track | null): string {
  const time = chineseDayPeriodLabel()
  if (!track) return `${time}好。我先不急着推歌。你可以先听点什么，或者跟我聊两句，我慢慢记住你的习惯。`
  const profile = getTasteProfile()
  const topArtistIntro = voiceTopArtistIntro(profile)
  const variants = [
    `${time}这个点，我想到${track.artist}的《${track.title}》。这首开头比较好进，声音可以开小一点。你先听半分钟。`,
    `我刚刚在想，先试试${track.artist}的《${track.title}》。它开头不吵，放着做点别的也行。不合适我再换。`,
    `现在先放${track.artist}的《${track.title}》吧。你不用认真听，等副歌出来再说。`,
    `${time}了，${topArtistIntro}这次换到${track.artist}的《${track.title}》。先听半分钟，不合适我再换。`,
    `这会儿先听${track.artist}的《${track.title}》。声音可以开小一点，手上的事慢慢做。`,
  ]
  return variants[stableInt(voiceSeed(`fallback:${track.title}:${track.artist}`), variants.length)]
}

async function getFallbackCandidates(signal?: AbortSignal): Promise<Track[]> {
  const imported = getAllImportedTracks()
  const listenedWindows = loadListenedTrackWindows(24, 500, 2, 200)
  const blocked = recentBlockedKeys(listenedWindows.history)
  const fresh = imported.filter((track) => !hasTrackIdentity(blocked, track))
  let pool = fresh
  if (fresh.length < 8 && imported.length > fresh.length) {
    const hardBlocked = trackIdentitySet(listenedWindows.recent)
    const relaxed = imported.filter((track) => !hasTrackIdentity(hardBlocked, track))
    pool = relaxed.length >= fresh.length ? relaxed : imported
  }
  const candidates = shuffled(pool, voiceSeed('fallback-candidates'), (track) => `${track.title}:${track.artist}`).slice(0, 24)
  return filterPlayableTracks(candidates, 5, signal)
}

const DIVERSITY_DIMENSIONS = [
  { label: '热烈', keywords: ['热烈', '激昂'] },
  { label: '轻快', keywords: ['轻快', '清新'] },
  { label: '放松', keywords: ['放松', '舒缓'] },
  { label: '治愈', keywords: ['治愈', '暖心'] },
  { label: '怀旧', keywords: ['怀旧', '经典'] },
  { label: '孤独', keywords: ['孤独', '安静'] },
  { label: '清醒', keywords: ['清醒', '提神'] },
  { label: '松弛', keywords: ['松弛', '慵懒'] },
]

function pickUncoveredDimension(): string {
  const coveredMoods = new Set(recentSegmentSemantics.flatMap((s) => s.moods))
  const uncovered = DIVERSITY_DIMENSIONS.filter((d) => !d.keywords.some((k) => coveredMoods.has(k)))
  const pool = uncovered.length > 0 ? uncovered : DIVERSITY_DIMENSIONS
  const pick = pool[stableInt(voiceSeed('dimension'), pool.length)]
  return pick.keywords[stableInt(voiceSeed(`dimension-keyword:${pick.label}`), pick.keywords.length)]
}

async function getCandidates(continuation?: boolean, signal?: AbortSignal): Promise<Track[]> {
  const blocked = recentBlockedKeys()
  const query = continuation && recentSegmentSemantics.length > 0
    ? `回声里给我一首${pickUncoveredDimension()}的、适合现在听的歌`
    : '回声里随机给我一首适合现在听的歌'
  const fromNetease = await searchMusic({ query, mode: 'voice', signal }).catch(() => [])
  assertListeningActive(signal)
  const fresh = fromNetease.filter((track) => !hasTrackIdentity(blocked, track))
  const diversified = diversifyByArtist(fresh, 2)
  if (diversified.length >= 3) return diversified.slice(0, 5)
  const fallback = await getFallbackCandidates(signal)
  const mixed = diversifyByArtist(uniqueTracks([...diversified, ...fallback.filter((t) => !hasTrackIdentity(blocked, t))]), 2)
  return mixed.slice(0, 5)
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

function stripQuotedSongTitles(text: string): string {
  return text.replace(/《[^》]+》/g, '')
}

function hasEmotionConversation(conversations: ReturnType<typeof loadRecentConversations>): boolean {
  const emotionPattern = /有点冷|觉得冷|身上冷|心里冷|好冷|太冷|冷得|好累|有点累|累了|累死|很累|疲惫|困了|睡不着|失眠|很烦|有点烦|烦躁|焦虑|压力|压抑|难过|伤心|想哭|emo|不舒服|开心|兴奋/i
  return conversations.some((item) => {
    const content = stripQuotedSongTitles(item.content)
    if (!emotionPattern.test(content)) return false
    if (/冷夜|冷门|冷色|冷感|冷歌/.test(content)) return false
    return true
  })
}

function buildVoiceMoment(input: {
  continuation?: boolean
  conversations: ReturnType<typeof loadRecentConversations>
  profile: ReturnType<typeof getTasteProfile>
  importedTrackCount: number
  playedToday: number
  hasRecommendationHistory: boolean
}): VoiceMoment {
  const hasTasteProfile = Boolean(input.profile?.echo_portrait || input.profile?.artists?.length || input.profile?.moods?.length)
  if (input.continuation) {
    return {
      state: 'continuation',
      reason: '用户正在连续点击回声',
      playedToday: input.playedToday,
      importedTrackCount: input.importedTrackCount,
      hasRecommendationHistory: input.hasRecommendationHistory,
      hasTasteProfile,
      isContinuation: true,
      suggestedLength: '140-200',
    }
  }
  if (hasEmotionConversation(input.conversations)) {
    return {
      state: 'emotion_context',
      reason: '最近对话里有明确情绪线索',
      playedToday: input.playedToday,
      importedTrackCount: input.importedTrackCount,
      hasRecommendationHistory: input.hasRecommendationHistory,
      hasTasteProfile,
      isContinuation: false,
      suggestedLength: '160-260',
    }
  }
  if (input.importedTrackCount === 0 && !hasTasteProfile) {
    return {
      state: 'fresh_install',
      reason: '还没有导入歌单和稳定画像',
      playedToday: input.playedToday,
      importedTrackCount: input.importedTrackCount,
      hasRecommendationHistory: input.hasRecommendationHistory,
      hasTasteProfile,
      isContinuation: false,
      suggestedLength: '120-180',
    }
  }
  if (input.importedTrackCount > 0 && !input.hasRecommendationHistory) {
    return {
      state: 'post_import_first_use',
      reason: '已有导入歌单，还没有回声推荐历史',
      playedToday: input.playedToday,
      importedTrackCount: input.importedTrackCount,
      hasRecommendationHistory: input.hasRecommendationHistory,
      hasTasteProfile,
      isContinuation: false,
      suggestedLength: '150-220',
    }
  }
  if (input.playedToday === 0) {
    return {
      state: 'daily_first',
      reason: '今天第一次打开回声',
      playedToday: input.playedToday,
      importedTrackCount: input.importedTrackCount,
      hasRecommendationHistory: input.hasRecommendationHistory,
      hasTasteProfile,
      isContinuation: false,
      suggestedLength: '150-220',
    }
  }
  return {
    state: 'after_tracks',
    reason: '今天已经有播放中的或听完的歌曲',
    playedToday: input.playedToday,
    importedTrackCount: input.importedTrackCount,
    hasRecommendationHistory: input.hasRecommendationHistory,
    hasTasteProfile,
    isContinuation: false,
    suggestedLength: '150-240',
  }
}

function formatVoiceMoment(moment: VoiceMoment): string {
  return `state: ${moment.state}
reason: ${moment.reason}
playedToday: ${moment.playedToday}
importedTrackCount: ${moment.importedTrackCount}
hasRecommendationHistory: ${moment.hasRecommendationHistory ? 'true' : 'false'}
hasTasteProfile: ${moment.hasTasteProfile ? 'true' : 'false'}
isContinuation: ${moment.isContinuation ? 'true' : 'false'}
suggestedLength: ${moment.suggestedLength}`
}

function buildContext(input: {
  generatedAt: string
  weatherSummary?: string
  conversations: ReturnType<typeof loadRecentConversations>
  seal: string
  profile: ReturnType<typeof getTasteProfile>
  candidates: Track[]
  voiceMoment: VoiceMoment
  activeEvents?: ActiveEvent[]
  continuation?: boolean
}) {
  const now = new Date(input.generatedAt)
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  const hh = String(now.getHours()).padStart(2, '0')
  const mm = String(now.getMinutes()).padStart(2, '0')
  const weekday = WEEKDAYS[now.getDay()]
  const currentTime = `${y}-${m}-${d} ${hh}:${mm} ${weekday}`
  const recent = input.conversations.map((item) => ({
    role: item.role,
    time: formatConversationTime(item.createdAt),
    content: item.content,
  }))
  const recentSegments = recentScenarios.map((item, index) => ({
    id: `S${index + 1}`,
    content: item,
  }))
  const activeEvents = input.activeEvents ?? []

  const continuationBlock = input.continuation && recentScenarios.length > 0
    ? `

<continuation>
${safePromptJson({
  instruction: '你正在连续说话。接着说，但换一个完全不同的切入点、不同的句式。',
  recentStarts: recentScenarios.slice(0, 3).map((item, index) => ({
    id: `S${index + 1}`,
    preview: `${item.slice(0, 40)}${item.length > 40 ? '...' : ''}`,
  })),
  recentMusicSemantics: recentSegmentSemantics.slice(0, 3).map((semantic, index) => ({
    id: `S${index + 1}`,
    artist: semantic.artist,
    moods: semantic.moods.slice(0, 3),
    genres: semantic.genres.slice(0, 2),
    tempo: semantic.tempo,
    energy: semantic.energy > 0.65 ? '高' : semantic.energy > 0.4 ? '中' : '低',
  })),
  recentArtists: [...new Set(recentArtists.slice(0, 3))],
  diversityRule: recentArtists.length > 0 && new Set(recentArtists.slice(0, 3)).size < 3
    ? '这次必须从 candidates 里选一首不同歌手的。'
    : '这次换一个歌手或换一种听感。',
})}

这些开头方式已经用过了。这次必须换一个完全不同的切入点、不同的句式。
可以换个话题,可以跑题,可以回前面的话题但用新的角度。
</continuation>`
    : ''

  return `<voice_moment>
${escapePromptData(formatVoiceMoment(input.voiceMoment))}
</voice_moment>

<current_time>${escapePromptData(currentTime)}</current_time>

<weather>${escapePromptData(input.weatherSummary ?? '未知')}</weather>

<recent_conversations>
${safePromptJson(recent)}
</recent_conversations>

<yesterday_seal_summary>
${escapePromptData(input.seal ? input.seal.slice(0, 900) : '(暂无)')}
</yesterday_seal_summary>

${buildMemoryEvidencePrompt(input.profile)}

<active_events>
${safePromptJson(activeEvents.map((event) => ({
  content: event.content,
  kind: event.kind,
  scope: event.kind === 'context' ? 'today_context' : 'active_event',
  weight: event.weight ?? null,
  confidence: event.confidence ?? null,
  startedAt: event.startedAt ?? null,
  createdAt: event.createdAt ?? null,
})))}
</active_events>
<active_events_contract>
kind=context 表示今天仍在持续的短期状态,只能写成“今天/这会儿/刚才”的轻量观察,不能写成稳定人格、长期偏好或反复模式。
</active_events_contract>

<recent_listening_segments>
${safePromptJson(recentSegments)}
</recent_listening_segments>${continuationBlock}

<candidates>
${safePromptJson(input.candidates.map((item, index) => ({
  id: `C${index + 1}`,
  artist: item.artist,
  title: item.title,
  album: item.album,
})))}
</candidates>

<output_contract>
只输出最终要朗读的一段话。不要 JSON,不要 Markdown,不要编号,不要解释。
必须从 candidates 里选一首,并在前两句写成《歌名》。
整体 160-260 字,最多 6 句。TTS 开头不要空转。
记忆只用于挑歌和语气边界,不要说画像、轨迹、数据、纠正、策略。
像朋友临时发来一段语音,少下结论,多给一个具体听法。
</output_contract>`
}

export async function generateListeningSegment(options: ListeningSegmentOptions = {}): Promise<ListeningSegmentResult> {
  assertListeningActive(options.signal)
  const generatedAt = new Date().toISOString()
  const settings = getSettings()
  const limit = options?.continuation ? 2 : 5
  options.onProgress?.({ phase: 'context', current: 1, total: 4, message: '整理回声上下文' })
  const conversations = loadRecentConversations(limit)
  if (options?.continuation && conversations.length > 0) {
    const fp = String(conversations[conversations.length - 1].id ?? '')
    if (fp === lastConversationFingerprint) conversations.length = 0
    lastConversationFingerprint = fp
  } else if (conversations.length > 0) {
    lastConversationFingerprint = String(conversations[conversations.length - 1].id ?? '')
  }
  const seal = getMostRecentSeal()
  const profile = getTasteProfile()
  const importedTrackCount = getAllImportedTracks().length
  const playedToday = loadRecentTracks(40).filter((track) => track.queueStatus === 'playing' || track.queueStatus === 'completed').length
  const hasRecommendationHistory = loadRecentRecommendedTracks(1).length > 0
  const voiceMoment = buildVoiceMoment({
    continuation: options?.continuation,
    conversations,
    profile,
    importedTrackCount,
    playedToday,
    hasRecommendationHistory,
  })
  const activeEvents = loadActiveEvents(8)
  const weather = await getWeather(settings.user.city, { signal: options.signal })
  assertListeningActive(options.signal)
  options.onProgress?.({ phase: 'candidates', current: 2, total: 4, message: '挑选回声歌曲' })
  const candidates = await getCandidates(options?.continuation, options.signal)
  const prompt = `${buildSoulPolicyPrompt('voice')}\n\n${readRootFile('prompts/scenario-100.md')}`
  const context = buildContext({ generatedAt, weatherSummary: weather?.summary, conversations, seal, profile, candidates, voiceMoment, activeEvents, continuation: options?.continuation })

  let text = fallbackText(candidates[0] ?? null)
  let track: Track | null = candidates[0] ?? null

  if (candidates.length > 0) {
    try {
      const response = await completeChat(settings, [
        { role: 'system', content: prompt },
        {
          role: 'user',
          content: context,
        },
      ], { temperature: options?.continuation ? 0.95 : 0.85, signal: options.signal, maxTokens: 800 })
      assertListeningActive(options.signal)
      const parsed = parseJsonObject(response)
      const nextText = parsed?.text ? limitText(parsed.text) : limitText(response)
      let selectedIndex = parsed?.selectedIndex
      if (nextText && hasListeningTextQuality(nextText)) {
        text = nextText
      } else if (nextText) {
        const retry = await completeChat(settings, [
          { role: 'system', content: prompt },
          {
            role: 'user',
            content: `${context}

上一版不适合 TTS。重写成一段能直接朗读的话: 160-260 字,最多 6 句,歌名出现在前两句,保留一首候选歌名,用具体听法,不要解释机制。`,
          },
        ], { temperature: options?.continuation ? 0.95 : 0.85, signal: options.signal, maxTokens: 800 })
        assertListeningActive(options.signal)
        const retryParsed = parseJsonObject(retry)
        const retryText = retryParsed?.text ? limitText(retryParsed.text) : limitText(retry)
        if (retryText && hasListeningTextQuality(retryText)) {
          text = retryText
          selectedIndex = retryParsed?.selectedIndex
        }
      }
      track = pickTrackFromText(text, candidates, selectedIndex)
      text = alignTextToTrack(text, track)
    } catch (error) {
      if (error instanceof LlmError) {
        recordHealth('llm', error.kind === 'auth' || error.kind === 'config' ? 'error' : 'degraded', 'Echo 连不上模型。去设置里检查 API key。', error.message)
      }
      text = fallbackText(track)
    }
  }

  options.onProgress?.({ phase: 'tts', current: 3, total: 4, message: '合成回声音频' })
  const audio = await synthesize(text, { signal: options.signal })
  assertListeningActive(options.signal)
  rememberScenario(text, track)
  if (track) {
    track = withVoiceSourceContext(track)
    appendRecommendedTracks([track])
  }
  if (audio.ok && audio.audioUrl) {
    options.onProgress?.({ phase: 'done', current: 4, total: 4, message: '回声片段已生成。' })
    return { text, track, audioUrl: audio.audioUrl, generatedAt }
  }
  options.onProgress?.({ phase: 'done', current: 4, total: 4, message: audio.error?.message ?? 'Echo 现在说不出话来' })
  return { text, track, error: audio.error?.message ?? 'Echo 现在说不出话来', generatedAt }
}

export const listeningTestHelpers = {
  alignTextToTrack,
  buildContext,
  hasVoiceBehaviorEvidence,
  hasListeningTextQuality,
  pickTrackFromText,
  withVoiceSourceContext,
  voiceTopArtistIntro,
}
