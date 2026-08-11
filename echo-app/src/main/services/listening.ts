import type { Track } from '../../types/ipc'
import { loadRecentConversations, loadTodayConversations, loadUserConversationsForDate } from '../db/conversations'
import { getCompanionProfile, loadLatestAssistantResponseStrategy } from '../db/companion'
import { loadActiveEvents, type ActiveEvent } from '../db/events'
import { appendListeningSegment, getOrCreateListeningSession, loadListeningSegments } from '../db/listening'
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
import { buildMemoryEvidencePrompt, buildOperationalTasteSummary } from './memoryEvidence'
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
import { compactCompanionProfile } from './chat/companionStrategy'
import { buildListeningPlan, formatListeningPlan } from './listeningPlan'
import type { ListeningPlan, ListeningSegmentRecord } from './listeningTypes'

interface ListeningText {
  text?: string
  selectedIndex?: number
}

interface ListeningRecommendationBasis {
  searchQuery: string
  summary: string
  canReferenceYesterday: boolean
  source: 'yesterday' | 'taste' | 'generic'
}

const SAFE_CONTINUATION_TERMS: ReadonlyMap<string, string> = new Map([
  ['欢快', '欢快'], ['轻快', '轻快'], ['放松', '放松'], ['安静', '安静'], ['温柔', '温柔'], ['浪漫', '浪漫'],
  ['伤感', '伤感'], ['忧郁', '忧郁'], ['平静', '平静'], ['热血', '热血'], ['舒缓', '舒缓'], ['清新', '清新'],
  ['流行', '流行'], ['民谣', '民谣'], ['摇滚', '摇滚'], ['电子', '电子'], ['说唱', '说唱'], ['古典', '古典'],
  ['爵士', '爵士'], ['乡村', '乡村'], ['轻音乐', '轻音乐'], ['纯音乐', '纯音乐'], ['R&B', 'R&B'],
  ['华语', '华语'], ['粤语', '粤语'], ['韩语', '韩语'], ['韩国', '韩语'], ['日语', '日语'], ['日本', '日语'], ['英语', '英语'],
  ['工作', '工作'], ['通勤', '通勤'], ['休息', '休息'], ['睡前', '睡前'], ['运动', '运动'], ['阅读', '阅读'],
  ['下雨', '下雨'], ['夜晚', '夜晚'], ['清晨', '清晨'],
])

export interface ListeningSegmentOptions {
  continuation?: boolean
  automatic?: boolean
  signal?: AbortSignal
  onProgress?: (patch: { phase?: string; current?: number; total?: number; message?: string }) => void
}

export type ListeningSegmentResult = {
  text: string
  track: Track | null
  delivery: 'spoken' | 'silent'
  density: ListeningPlan['density']
  sessionId: number
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
  language: string
  year?: number
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

function activeEventKey(event: ActiveEvent): string {
  if (typeof event.id === 'number' && Number.isFinite(event.id)) return `event:${event.id}`
  return `event:${event.kind}:${event.createdAt ?? event.startedAt ?? ''}:${event.content.trim()}`
}

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
    language: semantic.language,
    year: track.year,
  }
}

function rememberScenario(text: string, track: Track | null) {
  if (text.trim()) {
    recentScenarios.unshift(text)
    recentScenarios.splice(8)
  }
  if (track) {
    recentTrackKeys.unshift(...trackIdentityKeys(track))
    recentTrackKeys.splice(36)
    recentSegmentSemantics.unshift(semanticForTrack(track))
    recentSegmentSemantics.splice(8)
    recentArtists.unshift(primaryArtist(track.artist))
    recentArtists.splice(8)
  }
}

function restoreScenarioMemory(segments: ListeningSegmentRecord[]): void {
  recentScenarios.length = 0
  recentTrackKeys.length = 0
  recentSegmentSemantics.length = 0
  recentArtists.length = 0
  for (const segment of segments) {
    if (segment.text.trim()) recentScenarios.push(segment.text)
    if (!segment.track) continue
    recentTrackKeys.push(...trackIdentityKeys(segment.track))
    recentSegmentSemantics.push(semanticForTrack(segment.track))
    recentArtists.push(primaryArtist(segment.track.artist))
  }
  recentScenarios.splice(8)
  recentTrackKeys.splice(36)
  recentSegmentSemantics.splice(8)
  recentArtists.splice(8)
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

const COOLED_LISTENING_PHRASES = [
  '先听半分钟',
  '声音可以开小一点',
  '声音开小一点',
  '等副歌出来',
  '不合适我再换',
  '你继续忙，我在',
  '你继续忙',
  '手上的事慢慢做',
]

function textShape(value: string): string {
  return compactText(value.replace(/[^，。！？!?]{0,24}《[^》]+》/g, '《歌名》'))
}

function textNgrams(value: string, size = 3): Set<string> {
  const normalized = textShape(value)
  const grams = new Set<string>()
  for (let index = 0; index <= normalized.length - size; index += 1) {
    grams.add(normalized.slice(index, index + size))
  }
  return grams
}

function listeningTextSimilarity(left: string, right: string): number {
  const a = textNgrams(left)
  const b = textNgrams(right)
  if (a.size === 0 || b.size === 0) return 0
  let intersection = 0
  for (const item of a) {
    if (b.has(item)) intersection += 1
  }
  return intersection / Math.max(1, a.size + b.size - intersection)
}

function listeningTextSignature(text: string): string {
  return textShape(text).slice(0, 96)
}

function hasMechanicalReuse(text: string, recentTexts: string[]): boolean {
  const currentStart = textShape(text).slice(0, 12)
  for (const recent of recentTexts.slice(0, 8)) {
    if (currentStart.length >= 8 && currentStart === textShape(recent).slice(0, 12)) return true
    if (listeningTextSimilarity(text, recent) >= 0.58) return true
  }
  return COOLED_LISTENING_PHRASES.some((phrase) => text.includes(phrase) && recentTexts.slice(0, 4).some((recent) => recent.includes(phrase)))
}

function hasListeningTextQuality(text: string, options: { plan?: ListeningPlan; recentTexts?: string[] } = {}): boolean {
  const compact = text.replace(/\s+/g, '')
  const minChars = options.plan?.minChars ?? 18
  const maxChars = options.plan?.maxChars ?? 300
  const maxSentences = options.plan?.maxSentences ?? 6
  if (compact.length < minChars || compact.length > maxChars) return false
  if (sentenceCount(text) > maxSentences) return false
  const firstTitleIndex = text.indexOf('《')
  if (firstTitleIndex < 0 || firstTitleIndex > Math.min(150, Math.max(40, maxChars - 10))) return false
  if (!options.plan && !text.includes('我') && !text.includes('你')) return false
  if (/(总的来说|由此可见|为您|用户|画像|轨迹|轮廓|数据|算法|记忆策略|纠正过|说明你|你其实|你总是|你一直|人格|诊断|标签)/.test(text)) return false
  if (hasMemorySourceLeak(text, { tail: '不喜欢|少推|别总|别老|纠正|画像|数据|轨迹|记忆' })) return false
  if (BANNED_LISTENING_TEXT_PATTERN.test(text)) return false
  if (/[-*#]|^\d+[.、]/m.test(text)) return false
  if (hasMechanicalReuse(text, options.recentTexts ?? [])) return false
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

function segmentTrackReason(text: string, plan?: ListeningPlan): string {
  if (plan?.delivery === 'silent') return '这一首先安静地听，留点位置给音乐。'
  const firstSentence = text.split(/[。！？!?]/).map((item) => item.trim()).find(Boolean)
  return firstSentence ? `${firstSentence.slice(0, 56)}。` : '回声里 Echo 想到的这首。'
}

function withVoiceSourceContext(track: Track, plan?: ListeningPlan, text = ''): Track {
  const reason = plan ? segmentTrackReason(text, plan) : track.reason ?? '回声里 Echo 想到的这首。'
  return {
    ...track,
    sourceContext: 'voice',
    reason,
    echoNote: reason,
  }
}

function fallbackText(track: Track | null, plan?: ListeningPlan, recentTexts: string[] = []): string {
  const time = chineseDayPeriodLabel()
  if (!track) return `${time}好。我先不急着推歌。你可以先听点什么，或者跟我聊两句，我慢慢记住你的习惯。`
  if (plan?.delivery === 'silent') return ''
  const topArtistIntro = plan?.density === 'micro' ? '' : voiceTopArtistIntro(getTasteProfile())
  const fullLabel = songLabel(track)
  const titleLabel = `《${track.title}》`
  const label = plan && fullLabel.length > Math.max(20, plan.maxChars - 16) ? titleLabel : fullLabel
  const micro = [
    `${label}来了。前面绕得有点久，这次走直一点。`,
    `刚才已经够安静了，换${label}醒一醒。`,
    `试试${label}。这回先跟着前奏走。`,
    `嗯，这时候还是${label}合适。`,
    `我们换${label}，让耳朵走条新路。`,
    `${label}先唱，我少说两句。`,
    `本来想继续安静，临时改主意了：听${label}。`,
  ]
  const brief = [
    `刚才那首把情绪压得有点低，这回换${label}。节奏往前一点，脑子也能顺势挪个位置。`,
    `我在前面几首里绕了一圈，还是想让${label}进来。它负责换口气，你照常做自己的事。`,
    `${topArtistIntro}这一回我偏要拐个弯，听${label}。连续一个方向走久了，耳朵也该看看别处。`,
    `先让${label}接班。它和刚才的脾气不太一样，正好看看你会不会多留一会儿。`,
  ]
  const full = [
    `${time}到了，我想先用${label}把这一轮打开。它进得轻，后面又有一点自己的主意，很适合边做事边慢慢熟起来。你照常忙，我先看看它能不能让今天的声音顺一点。`,
    `这一轮我挑了${label}，想从一个容易进入、又留着一点变化的位置开始。前面不用急着判断，先让旋律在旁边待一会儿。等你真的注意到它时，可能已经听进去一段了。`,
  ]
  const variants = plan?.density === 'micro' ? micro : plan?.density === 'brief' ? brief : full
  const start = stableInt(voiceSeed(`fallback:${plan?.move ?? 'default'}:${track.title}:${track.artist}`), variants.length)
  for (let offset = 0; offset < variants.length; offset += 1) {
    const candidate = variants[(start + offset) % variants.length]
    if (plan
      ? hasListeningTextQuality(candidate, { plan, recentTexts })
      : !hasMechanicalReuse(candidate, recentTexts)) return candidate
  }
  const emergency = [
    `${titleLabel}接上。刚才的方向先放一放，这回听它怎么走。`,
    `${titleLabel}来了。前面的情绪留在前面，我们换个角度听。`,
    `这次让${titleLabel}先唱。它有自己的脾气，正好把耳朵带去别处。`,
    `${titleLabel}放进来。我们暂时不替它下结论，先听完这一小段。`,
  ]
  for (const candidate of emergency) {
    if (plan
      ? hasListeningTextQuality(candidate, { plan, recentTexts })
      : !hasMechanicalReuse(candidate, recentTexts)) return candidate
  }
  return variants[start]
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

function energyBand(energy: number): 'low' | 'medium' | 'high' {
  return energy > 0.65 ? 'high' : energy > 0.4 ? 'medium' : 'low'
}

function decade(year?: number): number | null {
  return year && Number.isFinite(year) ? Math.floor(year / 10) * 10 : null
}

function rankBySessionDiversity(tracks: Track[], history = recentSegmentSemantics): Track[] {
  const recent = history.slice(0, 4)
  const cooledArtists = new Set(recent.map((item) => compactText(item.artist)))
  const repeatedLanguage = recent.length >= 3 && recent.slice(0, 3).every((item) => item.language === recent[0].language)
    ? recent[0].language
    : ''
  const recentDecades = recent.slice(0, 3).map((item) => decade(item.year)).filter((item): item is number => item !== null)
  const repeatedDecade = recentDecades.length >= 3 && recentDecades.every((item) => item === recentDecades[0])
    ? recentDecades[0]
    : null

  return tracks
    .map((track, index) => {
      const semantic = semanticForTrack(track)
      let penalty = 0
      if (cooledArtists.has(compactText(semantic.artist))) penalty += 100
      for (const previous of recent.slice(0, 3)) {
        if (semantic.genres.some((genre) => previous.genres.includes(genre))) penalty += 12
      }
      if (repeatedLanguage && semantic.language === repeatedLanguage) penalty += 8
      if (recent.length >= 2 && recent.slice(0, 2).every((item) => energyBand(item.energy) === energyBand(semantic.energy))) penalty += 6
      if (repeatedDecade !== null && decade(semantic.year) === repeatedDecade) penalty += 5
      return { track, index, penalty }
    })
    .sort((left, right) => left.penalty - right.penalty || left.index - right.index)
    .map((item) => item.track)
}

async function getCandidates(continuation?: boolean, signal?: AbortSignal, basis?: ListeningRecommendationBasis): Promise<Track[]> {
  const blocked = recentBlockedKeys()
  const query = !continuation && basis?.searchQuery
    ? basis.searchQuery
    : continuation && recentSegmentSemantics.length > 0
    ? `回声里给我一首${pickUncoveredDimension()}的、适合现在听的歌`
    : '回声里随机给我一首适合现在听的歌'
  const fromNetease = await searchMusic({ query, mode: 'voice', signal }).catch(() => [])
  assertListeningActive(signal)
  const fresh = rankBySessionDiversity(fromNetease.filter((track) => !hasTrackIdentity(blocked, track)))
  const cooledArtists = new Set(recentArtists.slice(0, 4).map((artist) => compactText(artist)))
  const artistFresh = fresh.filter((track) => !cooledArtists.has(compactText(primaryArtist(track.artist))))
  const preferred = artistFresh.length >= 3 ? artistFresh : fresh
  const diversified = diversifyByArtist(preferred, 1)
  if (diversified.length >= 3) return diversified.slice(0, 5)
  const fallback = await getFallbackCandidates(signal)
  const fallbackFresh = fallback.filter((track) => (
    !hasTrackIdentity(blocked, track)
    && !cooledArtists.has(compactText(primaryArtist(track.artist)))
  ))
  const fallbackRelaxed = fallback.filter((track) => !hasTrackIdentity(blocked, track))
  const mixed = diversifyByArtist(uniqueTracks([...diversified, ...fallbackFresh, ...fallbackRelaxed]), 1)
  return mixed.slice(0, 5)
}

function yesterdayDate(now: Date): string {
  const date = new Date(now)
  date.setDate(date.getDate() - 1)
  return date.toLocaleDateString('sv-SE')
}

function fallbackRecommendationBasis(profile: ReturnType<typeof getTasteProfile>): ListeningRecommendationBasis {
  const mood = profile?.moods?.[0]?.tag?.trim()
  const genre = profile?.genres?.[0]?.name?.trim()
  const artist = profile?.artists?.[0]?.name?.trim()
  const direction = [mood, genre].filter(Boolean).join('、')
  if (direction) {
    return {
      searchQuery: `推荐一首${direction}、适合现在听的歌`,
      summary: `参考长期品味中的${direction}`,
      canReferenceYesterday: false,
      source: 'taste',
    }
  }
  if (artist) {
    return {
      searchQuery: `推荐一首和${artist}听感相近、适合现在听的歌`,
      summary: `参考长期品味中的常听艺人方向`,
      canReferenceYesterday: false,
      source: 'taste',
    }
  }
  return {
    searchQuery: '推荐一首容易进入、适合现在听的歌',
    summary: '暂无稳定的昨日或长期品味线索',
    canReferenceYesterday: false,
    source: 'generic',
  }
}

function normalizeYesterdayRecommendationBasis(
  value: Record<string, unknown>,
  fallback: ListeningRecommendationBasis,
): ListeningRecommendationBasis {
  const rawTerms = Array.isArray(value.terms) ? value.terms : []
  const terms = [...new Set(rawTerms.flatMap((term) => {
    if (typeof term !== 'string') return []
    const safe = SAFE_CONTINUATION_TERMS.get(term.trim())
    return safe ? [safe] : []
  }))].slice(0, 3)
  if (terms.length === 0) return fallback
  const canReferenceYesterday = value.canReferenceYesterday === true
  const direction = terms.join('、')
  return {
    searchQuery: `推荐一首${direction}、适合现在听的歌`,
    summary: canReferenceYesterday ? `承接昨天明确提过的${direction}方向` : `只参考${direction}这一音乐方向`,
    canReferenceYesterday,
    source: 'yesterday',
  }
}

async function buildRecommendationBasis(input: {
  settings: ReturnType<typeof getSettings>
  yesterdayMessages: ReturnType<typeof loadUserConversationsForDate>
  profile: ReturnType<typeof getTasteProfile>
  signal?: AbortSignal
}): Promise<ListeningRecommendationBasis> {
  const fallback = fallbackRecommendationBasis(input.profile)
  if (input.yesterdayMessages.length === 0) return fallback
  try {
    const response = await completeChat(input.settings, [
      {
        role: 'system',
        content: `你只负责从昨日用户消息中选择今天可延续的音乐标签。
输出 JSON: {"terms":["标签"],"canReferenceYesterday":true|false}。
terms 最多 3 个，只能从以下词中选择：${[...new Set(SAFE_CONTINUATION_TERMS.values())].join('、')}。
明确音乐要求可以设 canReferenceYesterday=true。健康、隐私、关系冲突等敏感内容必须设为 false，且不能出现在 terms。不要输出原话、歌名、人名或解释。`,
      },
      {
        role: 'user',
        content: safePromptJson({
          yesterdayUserMessages: input.yesterdayMessages.map((item) => item.content).slice(-12),
          tasteSummary: buildOperationalTasteSummary(input.profile),
        }),
      },
    ], { temperature: 0.2, signal: input.signal, timeoutMs: 6_000, maxTokens: 180 })
    assertListeningActive(input.signal)
    const match = response.match(/\{[\s\S]*\}/)
    const parsed = match ? JSON.parse(match[0]) as Record<string, unknown> : {}
    return normalizeYesterdayRecommendationBasis(parsed, fallback)
  } catch (error) {
    assertListeningActive(input.signal)
    recordHealth('llm', 'degraded', '昨日音乐方向提取失败，已改用长期品味。', error instanceof Error ? error.message : String(error))
    return fallback
  }
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

function stripQuotedSongTitles(text: string): string {
  return text.replace(/《[^》]+》/g, '')
}

const EMOTION_CONTEXT_PATTERN = /有点冷|觉得冷|身上冷|心里冷|好冷|太冷|冷得|好累|有点累|累了|累死|很累|疲惫|困了|睡不着|失眠|很烦|有点烦|烦躁|焦虑|压力|压抑|难过|伤心|想哭|emo|不舒服|开心|兴奋/i

function hasEmotionConversation(conversations: ReturnType<typeof loadRecentConversations>): boolean {
  return conversations.some((item) => {
    const content = stripQuotedSongTitles(item.content)
    if (!EMOTION_CONTEXT_PATTERN.test(content)) return false
    if (/冷夜|冷门|冷色|冷感|冷歌/.test(content)) return false
    return true
  })
}

function buildVoiceMoment(input: {
  continuation?: boolean
  automatic?: boolean
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
      reason: input.automatic ? '用户正在自动连续听回声' : '用户主动要求再听一段回声',
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
  listeningPlan?: ListeningPlan
  sessionSegments?: ListeningSegmentRecord[]
  companionProfile?: ReturnType<typeof getCompanionProfile>
  recommendationBasis?: ListeningRecommendationBasis
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
  const persistedSegments = input.sessionSegments ?? []
  const recentSegments = persistedSegments.length > 0
    ? persistedSegments.slice(0, 8).map((item, index) => ({
        id: `S${index + 1}`,
        content: item.text,
        delivery: item.delivery,
        density: item.density,
        move: item.move,
        sentenceForm: item.sentenceForm,
        artist: item.track?.artist ?? '',
        title: item.track?.title ?? '',
      }))
    : recentScenarios.map((item, index) => ({
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
    language: semantic.language,
    year: semantic.year ?? null,
  })),
  recentArtists: [...new Set(recentArtists.slice(0, 3))],
  recentMoves: persistedSegments.slice(0, 4).map((segment) => segment.move),
  recentSentenceForms: persistedSegments.slice(0, 4).map((segment) => segment.sentenceForm),
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

<listening_plan>
${escapePromptData(input.listeningPlan ? formatListeningPlan(input.listeningPlan) : 'density: full\nlength: 160-260\nmaxSentences: 6')}
</listening_plan>

<companion_style>
${safePromptJson(input.companionProfile ? compactCompanionProfile(input.companionProfile) : {})}
</companion_style>

<recent_conversations>
${safePromptJson(recent)}
</recent_conversations>

<yesterday_seal_summary>
${escapePromptData(input.recommendationBasis ? '(本轮使用受控音乐方向，不读取昨日封印)' : input.seal ? input.seal.slice(0, 900) : '(暂无)')}
</yesterday_seal_summary>

<recommendation_basis>
${safePromptJson(input.recommendationBasis ?? null)}
</recommendation_basis>
<recommendation_basis_contract>
该字段是内部选曲依据。canReferenceYesterday=true 时才允许自然提到“昨天你提过”; false 时只体现氛围和选曲方向，不复述历史内容。
</recommendation_basis_contract>

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
严格服从 listening_plan 的 length、maxSentences、move 和 sentenceForm。TTS 开头不要空转。
move 是本段与用户相处的动作,sentenceForm 是表达句式。自然完成它们,不要复述内部名称。
记忆只用于挑歌和语气边界,不要说画像、轨迹、数据、纠正、策略。
短段允许只说一个判断、观察或留白。具体听法只在语境合适时出现。
</output_contract>`
}

export async function generateListeningSegment(options: ListeningSegmentOptions = {}): Promise<ListeningSegmentResult> {
  assertListeningActive(options.signal)
  const now = new Date()
  const generatedAt = now.toISOString()
  const session = getOrCreateListeningSession(Boolean(options.continuation), now)
  const sessionSegments = loadListeningSegments(session.id, 12)
  restoreScenarioMemory(sessionSegments)
  const settings = getSettings()
  const limit = options?.continuation ? 2 : 5
  options.onProgress?.({ phase: 'context', current: 1, total: 4, message: '整理回声上下文' })
  const todayConversations = loadTodayConversations(limit)
  const conversations = todayConversations.some((item) => item.role === 'user') ? todayConversations : []
  const latestPersistedAt = sessionSegments[0]?.generatedAt ? new Date(sessionSegments[0].generatedAt).getTime() : 0
  const latestConversationAt = conversations.reduce((latest, item) => {
    const value = item.createdAt ? new Date(item.createdAt).getTime() : 0
    return Number.isFinite(value) ? Math.max(latest, value) : latest
  }, 0)
  if (options?.continuation && conversations.length > 0 && latestPersistedAt > 0 && latestConversationAt <= latestPersistedAt) {
    conversations.length = 0
  }
  const seal = getMostRecentSeal()
  const profile = getTasteProfile()
  const recommendationBasis = !options.continuation && conversations.length === 0
    ? await buildRecommendationBasis({
        settings,
        yesterdayMessages: loadUserConversationsForDate(yesterdayDate(now), 12),
        profile,
        signal: options.signal,
      })
    : undefined
  const companionProfile = getCompanionProfile()
  const importedTrackCount = getAllImportedTracks().length
  const playedToday = loadRecentTracks(40).filter((track) => track.queueStatus === 'playing' || track.queueStatus === 'completed').length
  const hasRecommendationHistory = loadRecentRecommendedTracks(1).length > 0
  const activeEvents = loadActiveEvents(8)
  const consumedEventKeys = new Set(session.consumedEventKeys)
  const unusedActiveEvents = activeEvents.filter((event) => !consumedEventKeys.has(activeEventKey(event)))
  const weather = await getWeather(settings.user.city, { signal: options.signal })
  assertListeningActive(options.signal)
  const latestCompanionStrategy = conversations.length > 0 ? loadLatestAssistantResponseStrategy() : null
  const companionMode = latestCompanionStrategy?.mode ?? session.companionMode
  const hasUnusedActiveContext = unusedActiveEvents.length > 0
  let listeningPlan = buildListeningPlan({
    session,
    recentSegments: sessionSegments,
    automatic: Boolean(options.automatic),
    hasFreshConversation: conversations.length > 0,
    hasActiveContext: hasUnusedActiveContext,
    emotionContext: hasEmotionConversation(conversations)
      || (hasUnusedActiveContext && unusedActiveEvents.some((event) => EMOTION_CONTEXT_PATTERN.test(event.content))),
    hasWeather: Boolean(weather?.summary),
    companionProfile,
    companionMode,
    now,
  })
  const voiceMoment = {
    ...buildVoiceMoment({
      continuation: options?.continuation,
      automatic: options?.automatic,
      conversations,
      profile,
      importedTrackCount,
      playedToday,
      hasRecommendationHistory,
    }),
    suggestedLength: `${listeningPlan.minChars}-${listeningPlan.maxChars}`,
  }
  options.onProgress?.({ phase: 'candidates', current: 2, total: 4, message: '挑选回声歌曲' })
  const candidates = await getCandidates(options?.continuation, options.signal, recommendationBasis)
  if (listeningPlan.delivery === 'silent' && candidates.length === 0) {
    listeningPlan = {
      ...listeningPlan,
      delivery: 'spoken',
      density: 'brief',
      move: 'self_talk',
      sentenceForm: 'self_talk',
      topicSource: 'session',
      minChars: 18,
      maxChars: 100,
      maxSentences: 3,
      reason: 'missing_track_recovery',
    }
  }
  let track: Track | null = candidates[0] ?? null
  if (listeningPlan.delivery === 'silent') {
    if (track) {
      track = withVoiceSourceContext(track, listeningPlan)
      appendRecommendedTracks([track])
    }
    rememberScenario('', track)
    appendListeningSegment({
      sessionId: session.id,
      track,
      text: '',
      delivery: listeningPlan.delivery,
      density: listeningPlan.density,
      move: listeningPlan.move,
      sentenceForm: listeningPlan.sentenceForm,
      topicSource: listeningPlan.topicSource,
      signature: '',
      companionMode,
      consumedEventKeys: listeningPlan.topicSource === 'active_event' ? unusedActiveEvents.map(activeEventKey) : [],
      generatedAt,
    })
    options.onProgress?.({ phase: 'done', current: 4, total: 4, message: '这首先安静地听。' })
    return {
      text: '',
      track,
      delivery: listeningPlan.delivery,
      density: listeningPlan.density,
      sessionId: session.id,
      generatedAt,
    }
  }
  const prompt = `${buildSoulPolicyPrompt('voice')}\n\n${readRootFile('prompts/scenario-100.md')}`
  const context = buildContext({
    generatedAt,
    weatherSummary: weather?.summary,
    conversations,
    seal: recommendationBasis ? '' : seal,
    profile,
    candidates,
    voiceMoment,
    activeEvents: hasUnusedActiveContext ? unusedActiveEvents : [],
    continuation: options?.continuation,
    listeningPlan,
    sessionSegments,
    companionProfile,
    recommendationBasis,
  })
  const recentTexts = sessionSegments.map((segment) => segment.text).filter(Boolean)

  let text = fallbackText(track, listeningPlan, recentTexts)

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
      if (nextText && hasListeningTextQuality(nextText, { plan: listeningPlan, recentTexts })) {
        text = nextText
      } else if (nextText) {
        const retry = await completeChat(settings, [
          { role: 'system', content: prompt },
          {
            role: 'user',
            content: `${context}

上一版没有满足本段计划。换一种开头和句式重写: ${listeningPlan.minChars}-${listeningPlan.maxChars} 字,最多 ${listeningPlan.maxSentences} 句,歌名出现在前两句,保持 ${listeningPlan.move} 的相处动作和 ${listeningPlan.sentenceForm} 句式。避开最近段落已经使用的表达。`,
          },
        ], { temperature: options?.continuation ? 0.95 : 0.85, signal: options.signal, maxTokens: 800 })
        assertListeningActive(options.signal)
        const retryParsed = parseJsonObject(retry)
        const retryText = retryParsed?.text ? limitText(retryParsed.text) : limitText(retry)
        if (retryText && hasListeningTextQuality(retryText, { plan: listeningPlan, recentTexts })) {
          text = retryText
          selectedIndex = retryParsed?.selectedIndex
        }
      }
      track = pickTrackFromText(text, candidates, selectedIndex)
      text = alignTextToTrack(text, track)
      if (!hasListeningTextQuality(text, { plan: listeningPlan, recentTexts })) {
        text = fallbackText(track, listeningPlan, recentTexts)
      }
    } catch (error) {
      if (error instanceof LlmError) {
        recordHealth('llm', error.kind === 'auth' || error.kind === 'config' ? 'error' : 'degraded', 'Echo 连不上模型。去设置里检查 API key。', error.message)
      }
      text = fallbackText(track, listeningPlan, recentTexts)
    }
  }

  if (track && !hasListeningTextQuality(text, { plan: listeningPlan, recentTexts })) {
    throw new Error('回声文案未通过最终质量校验')
  }

  options.onProgress?.({ phase: 'tts', current: 3, total: 4, message: '合成回声音频' })
  const audio = await synthesize(text, { signal: options.signal })
  assertListeningActive(options.signal)
  if (track) {
    track = withVoiceSourceContext(track, listeningPlan, text)
    appendRecommendedTracks([track])
  }
  rememberScenario(text, track)
  appendListeningSegment({
    sessionId: session.id,
    track,
    text,
    delivery: listeningPlan.delivery,
    density: listeningPlan.density,
    move: listeningPlan.move,
    sentenceForm: listeningPlan.sentenceForm,
    topicSource: listeningPlan.topicSource,
    signature: listeningTextSignature(text),
    companionMode,
    consumedEventKeys: listeningPlan.topicSource === 'active_event' ? unusedActiveEvents.map(activeEventKey) : [],
    generatedAt,
  })
  if (audio.ok && audio.audioUrl) {
    options.onProgress?.({ phase: 'done', current: 4, total: 4, message: '回声片段已生成。' })
    return { text, track, delivery: listeningPlan.delivery, density: listeningPlan.density, sessionId: session.id, audioUrl: audio.audioUrl, generatedAt }
  }
  options.onProgress?.({ phase: 'done', current: 4, total: 4, message: audio.error?.message ?? 'Echo 现在说不出话来' })
  return { text, track, delivery: listeningPlan.delivery, density: listeningPlan.density, sessionId: session.id, error: audio.error?.message ?? 'Echo 现在说不出话来', generatedAt }
}

export const listeningTestHelpers = {
  activeEventKey,
  alignTextToTrack,
  buildContext,
  fallbackText,
  fallbackRecommendationBasis,
  normalizeYesterdayRecommendationBasis,
  yesterdayDate,
  hasVoiceBehaviorEvidence,
  hasListeningTextQuality,
  hasMechanicalReuse,
  listeningTextSimilarity,
  listeningTextSignature,
  pickTrackFromText,
  rankBySessionDiversity,
  restoreScenarioMemory,
  withVoiceSourceContext,
  voiceTopArtistIntro,
}
