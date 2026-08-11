import type { ChatMessage } from '../../types/ipc'
import { isExternalListeningSource, type TodayTrackEvent } from '../db/tracks'
import type { LlmMessage } from '../llm/client'
import { escapePromptData, safePromptJson } from '../llm/promptData'
import { readRootFile } from '../utils/paths'
import { buildSoulPolicyPrompt } from '../skills/soul/policy'

export type YinyiNarrativeShape = 'sentence_echo' | 'object_thread' | 'contrast' | 'single_scene' | 'unfinished_question' | 'casual_letter'
export type YinyiStance = 'curious' | 'warm' | 'playful' | 'regretful' | 'bright' | 'quiet'

export interface YinyiEvidenceItem {
  id: string
  kind: 'conversation' | 'track'
  occurredAt: string
  time: string
  dayPeriod: '凌晨' | '早上' | '上午' | '中午' | '下午' | '晚上'
  role?: 'user' | 'assistant'
  content?: string
  title?: string
  artist?: string
  attribution?: 'user_playback' | 'echo_recommendation' | 'echo_continuation' | 'imported_or_unknown'
  outcome?: 'playing' | 'completed' | 'dismissed' | 'observed'
}

export interface YinyiEvidenceBundle {
  date: string
  weather?: string
  items: YinyiEvidenceItem[]
}

export interface YinyiWritingBrief {
  anchorEvidenceIds: string[]
  supportingEvidenceIds: string[]
  emotionalThread: string
  echoStance: YinyiStance
  narrativeShape: YinyiNarrativeShape
  openingMode: string
  endingMode: string
  imageryFamily?: string
  allowedInference: string[]
  forbiddenClaims: string[]
  timeRelationPairs: Array<{ fromEvidenceId: string; toEvidenceId: string }>
}

export interface YinyiStyleSignature {
  narrativeShape: YinyiNarrativeShape
  echoStance: YinyiStance
  openingMode: string
  endingMode: string
  imageryFamily?: string
}

export interface VerifiedTimeRelation {
  fromEvidenceId: string
  toEvidenceId: string
  minutes: number
  wording: string
}

const SHAPES = new Set<YinyiNarrativeShape>(['sentence_echo', 'object_thread', 'contrast', 'single_scene', 'unfinished_question', 'casual_letter'])
const STANCES = new Set<YinyiStance>(['curious', 'warm', 'playful', 'regretful', 'bright', 'quiet'])

function storedDate(value: string): Date {
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(value)) return new Date(value)
  return new Date(`${value.replace(' ', 'T')}Z`)
}

function localClock(value: string): { occurredAt: string; time: string; dayPeriod: YinyiEvidenceItem['dayPeriod'] } {
  const date = storedDate(value)
  const hour = date.getHours()
  const dayPeriod = hour < 6 ? '凌晨' : hour < 9 ? '早上' : hour < 12 ? '上午' : hour < 14 ? '中午' : hour < 18 ? '下午' : '晚上'
  return {
    occurredAt: date.toISOString(),
    time: date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }),
    dayPeriod,
  }
}

function trackAttribution(track: TodayTrackEvent): YinyiEvidenceItem['attribution'] {
  if (track.sourceContext === 'voice') return 'echo_continuation'
  if (track.source === 'recommended_by_echo') return 'echo_recommendation'
  if (isExternalListeningSource(track.source)) return 'user_playback'
  return 'imported_or_unknown'
}

function trackOutcome(track: TodayTrackEvent): YinyiEvidenceItem['outcome'] {
  if (track.queueStatus === 'completed') return 'completed'
  if (track.queueStatus === 'playing') return 'playing'
  if (track.queueStatus === 'skipped') return 'dismissed'
  return 'observed'
}

export function buildYinyiEvidenceBundle(date: string, conversations: ChatMessage[], tracks: TodayTrackEvent[], weather?: string): YinyiEvidenceBundle {
  const conversationItems = conversations.map((message, index): YinyiEvidenceItem => ({
    id: `conversation:${message.id ?? index + 1}`,
    kind: 'conversation',
    ...localClock(message.createdAt ?? `${date}T12:00:00`),
    role: message.role,
    content: message.content,
  }))
  const trackItems = tracks.map((track, index): YinyiEvidenceItem => ({
    id: `track:${index + 1}`,
    kind: 'track',
    ...localClock(track.listenedAt),
    title: track.title,
    artist: track.artist,
    attribution: trackAttribution(track),
    outcome: trackOutcome(track),
  }))
  return { date, weather, items: [...conversationItems, ...trackItems].sort((a, b) => a.occurredAt.localeCompare(b.occurredAt)) }
}

function stringArray(value: unknown, validIds?: Set<string>, max = 4): string[] {
  if (!Array.isArray(value)) return []
  return [...new Set(value.filter((item): item is string => typeof item === 'string' && (!validIds || validIds.has(item))))].slice(0, max)
}

export function parseYinyiWritingBrief(raw: string, bundle: YinyiEvidenceBundle): YinyiWritingBrief | null {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const value = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>
    const validIds = new Set(bundle.items.map((item) => item.id))
    const anchors = stringArray(value.anchorEvidenceIds, validIds, 2)
    if (anchors.length === 0 || !SHAPES.has(value.narrativeShape as YinyiNarrativeShape) || !STANCES.has(value.echoStance as YinyiStance)) return null
    const supportingEvidenceIds = stringArray(value.supportingEvidenceIds, validIds, 3)
    const selectedIds = new Set([...anchors, ...supportingEvidenceIds])
    const pairs = Array.isArray(value.timeRelationPairs) ? value.timeRelationPairs.flatMap((pair) => {
      if (!pair || typeof pair !== 'object') return []
      const typed = pair as Record<string, unknown>
      return typeof typed.fromEvidenceId === 'string' && typeof typed.toEvidenceId === 'string'
        && typed.fromEvidenceId !== typed.toEvidenceId
        && selectedIds.has(typed.fromEvidenceId) && selectedIds.has(typed.toEvidenceId)
        ? [{ fromEvidenceId: typed.fromEvidenceId, toEvidenceId: typed.toEvidenceId }]
        : []
    }).slice(0, 2) : []
    return {
      anchorEvidenceIds: anchors,
      supportingEvidenceIds,
      emotionalThread: typeof value.emotionalThread === 'string' ? value.emotionalThread.slice(0, 120) : '记住今天一个具体的瞬间',
      echoStance: value.echoStance as YinyiStance,
      narrativeShape: value.narrativeShape as YinyiNarrativeShape,
      openingMode: typeof value.openingMode === 'string' ? value.openingMode.slice(0, 60) : '从具体瞬间切入',
      endingMode: typeof value.endingMode === 'string' ? value.endingMode.slice(0, 60) : '留下一个小动作',
      imageryFamily: typeof value.imageryFamily === 'string' ? value.imageryFamily.slice(0, 30) : undefined,
      allowedInference: stringArray(value.allowedInference, undefined, 3),
      forbiddenClaims: stringArray(value.forbiddenClaims, undefined, 5),
      timeRelationPairs: pairs,
    }
  } catch {
    return null
  }
}

export function fallbackYinyiWritingBrief(bundle: YinyiEvidenceBundle, recentStyles: YinyiStyleSignature[] = []): YinyiWritingBrief {
  const userItem = [...bundle.items].reverse().find((item) => item.kind === 'conversation' && item.role === 'user')
  const trackItem = [...bundle.items].reverse().find((item) => item.kind === 'track' && item.outcome !== 'dismissed')
  const anchor = userItem ?? trackItem ?? bundle.items[0]
  const support = trackItem && trackItem.id !== anchor?.id ? [trackItem.id] : []
  const usedShapes = new Set(recentStyles.slice(0, 2).map((style) => style.narrativeShape))
  const compatibleShapes: YinyiNarrativeShape[] = userItem
    ? ['single_scene', 'sentence_echo', 'casual_letter']
    : ['object_thread', 'single_scene', 'contrast']
  const narrativeShape = compatibleShapes.find((shape) => !usedShapes.has(shape)) ?? compatibleShapes[0]
  const recentOpenings = new Set(recentStyles.slice(0, 3).map((style) => style.openingMode))
  const recentEndings = new Set(recentStyles.slice(0, 3).map((style) => style.endingMode))
  return {
    anchorEvidenceIds: anchor ? [anchor.id] : [],
    supportingEvidenceIds: support,
    emotionalThread: '只记住今天最后留下来的一个具体瞬间',
    echoStance: 'quiet',
    narrativeShape,
    openingMode: recentOpenings.has('直接落在具体细节上') ? '从主要证据中的一句话切入' : '直接落在具体细节上',
    endingMode: recentEndings.has('以一个未完成的小动作收住') ? '停在 Echo 没有说出口的一句话前' : '以一个未完成的小动作收住',
    allowedInference: [],
    forbiddenClaims: ['不要推断用户的稳定性格或真实内心'],
    timeRelationPairs: [],
  }
}

export function verifyYinyiTimeRelations(brief: YinyiWritingBrief, bundle: YinyiEvidenceBundle): VerifiedTimeRelation[] {
  const byId = new Map(bundle.items.map((item) => [item.id, item]))
  return brief.timeRelationPairs.flatMap((pair) => {
    const from = byId.get(pair.fromEvidenceId)
    const to = byId.get(pair.toEvidenceId)
    if (!from || !to) return []
    const minutes = Math.round((Date.parse(to.occurredAt) - Date.parse(from.occurredAt)) / 60000)
    if (minutes < 0 || minutes > 24 * 60) return []
    return [{ ...pair, minutes, wording: minutes === 0 ? '同一分钟' : `相隔${minutes}分钟` }]
  })
}

export function selectedYinyiEvidence(brief: YinyiWritingBrief, bundle: YinyiEvidenceBundle): YinyiEvidenceItem[] {
  const selected = new Set([...brief.anchorEvidenceIds, ...brief.supportingEvidenceIds])
  return bundle.items.filter((item) => selected.has(item.id))
}

export function yinyiStyleSignature(brief: YinyiWritingBrief): YinyiStyleSignature {
  return {
    narrativeShape: brief.narrativeShape,
    echoStance: brief.echoStance,
    openingMode: brief.openingMode,
    endingMode: brief.endingMode,
    imageryFamily: brief.imageryFamily,
  }
}

export function yinyiStyleConflicts(brief: YinyiWritingBrief, recentStyles: YinyiStyleSignature[]): string[] {
  const recentTwo = recentStyles.slice(0, 2)
  const recentThree = recentStyles.slice(0, 3)
  const issues: string[] = []
  if (recentTwo.some((style) => style.narrativeShape === brief.narrativeShape)) issues.push('叙事结构与最近两篇重复')
  if (recentThree.some((style) => style.openingMode === brief.openingMode)) issues.push('开头方式与近期风信重复')
  if (recentThree.some((style) => style.endingMode === brief.endingMode)) issues.push('结尾方式与近期风信重复')
  if (brief.imageryFamily && recentThree.some((style) => style.imageryFamily === brief.imageryFamily)) issues.push('主要意象与近期风信重复')
  return issues
}

export function buildYinyiDirectorMessages(bundle: YinyiEvidenceBundle, recentStyles: YinyiStyleSignature[]): LlmMessage[] {
  return [{
    role: 'system',
    content: `${buildSoulPolicyPrompt('yinyi')}\n\n你是风信的写法导演，不写正文。选择一条内在线索和最多两个主要证据。避免流水账，选择适合今天的叙事结构。只返回 JSON。`,
  }, {
    role: 'user',
    content: `<evidence_bundle>\n${safePromptJson(bundle)}\n</evidence_bundle>\n<recent_style_signatures>\n${safePromptJson(recentStyles)}\n</recent_style_signatures>\n\n返回字段：anchorEvidenceIds、supportingEvidenceIds、emotionalThread、echoStance、narrativeShape、openingMode、endingMode、imageryFamily、allowedInference、forbiddenClaims、timeRelationPairs。narrativeShape 只能是 sentence_echo/object_thread/contrast/single_scene/unfinished_question/casual_letter；echoStance 只能是 curious/warm/playful/regretful/bright/quiet。不得重复最近两篇的 narrativeShape，也不要重复近期 openingMode、endingMode、imageryFamily。timeRelationPairs 的两个 ID 必须都来自本次选择的 anchorEvidenceIds 或 supportingEvidenceIds。`,
  }]
}

export function buildYinyiWriterMessages(brief: YinyiWritingBrief, bundle: YinyiEvidenceBundle, relations: VerifiedTimeRelation[]): LlmMessage[] {
  const prompt = readRootFile('prompts/yinyi-writer-v6.md')
  return [{ role: 'system', content: `${buildSoulPolicyPrompt('yinyi')}\n\n${prompt}` }, {
    role: 'user',
    content: `<date>${escapePromptData(bundle.date)}</date>\n<weather>${escapePromptData(bundle.weather ?? '未知')}</weather>\n<writing_brief>\n${safePromptJson(brief)}\n</writing_brief>\n<selected_evidence>\n${safePromptJson(selectedYinyiEvidence(brief, bundle))}\n</selected_evidence>\n<verified_time_relations>\n${safePromptJson(relations)}\n</verified_time_relations>`,
  }]
}

export function buildYinyiCriticMessages(content: string, brief: YinyiWritingBrief, bundle: YinyiEvidenceBundle, relations: VerifiedTimeRelation[], recentEntries: string[]): LlmMessage[] {
  return [{ role: 'system', content: '你是风信质检员，只做判断。检查事实、归因、流水账、过度解读、文学腔堆砌和近期重复。只返回 JSON：{"passed":boolean,"issues":string[]}。' }, {
    role: 'user',
    content: safePromptJson({ content, brief, weather: bundle.weather, selectedEvidence: selectedYinyiEvidence(brief, bundle), verifiedTimeRelations: relations, recentEntries: recentEntries.slice(0, 3) }),
  }]
}

export function parseYinyiCritique(raw: string): { passed: boolean; issues: string[] } | null {
  const start = raw.indexOf('{')
  const end = raw.lastIndexOf('}')
  if (start < 0 || end <= start) return null
  try {
    const value = JSON.parse(raw.slice(start, end + 1)) as Record<string, unknown>
    if (typeof value.passed !== 'boolean') return null
    return { passed: value.passed, issues: stringArray(value.issues, undefined, 6) }
  } catch {
    return null
  }
}

function normalizedEdge(content: string, fromEnd = false): string {
  const normalized = content.replace(/[\s，。！？、“”‘’：；]/g, '')
  return fromEnd ? normalized.slice(-14) : normalized.slice(0, 9)
}

export function deterministicYinyiIssues(
  content: string,
  bundle: YinyiEvidenceBundle,
  relations: VerifiedTimeRelation[],
  recentEntries: string[],
): string[] {
  const issues: string[] = []
  const knownTitles = new Set(bundle.items.flatMap((item) => {
    const titles = item.title ? [item.title] : []
    if (item.content) titles.push(...[...item.content.matchAll(/《([^》]+)》/g)].map((match) => match[1]))
    return titles
  }))
  const mentionedTitles = [...content.matchAll(/《([^》]+)》/g)].map((match) => match[1])
  if (mentionedTitles.some((title) => !knownTitles.has(title))) issues.push('出现了证据中不存在的歌名')

  for (const item of bundle.items) {
    if (!item.title || (item.attribution !== 'echo_recommendation' && item.attribution !== 'echo_continuation')) continue
    const escapedTitle = item.title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    const userChoice = new RegExp(`你.{0,12}(?:主动|点了|选了|循环|反复听|听完).{0,8}《${escapedTitle}》|《${escapedTitle}》.{0,8}你.{0,12}(?:主动|点了|选了|循环|反复听|听完)`)
    if (userChoice.test(content)) {
      issues.push('把 Echo 自动提供的歌曲写成了用户主动选择')
      break
    }
  }

  const knownTimes = new Set(bundle.items.map((item) => item.time.replace(':', '[：:]')))
  const mentionedTimes = [...content.matchAll(/\b(\d{1,2})[：:](\d{2})\b/g)].map((match) => `${match[1].padStart(2, '0')}[：:]${match[2]}`)
  if (mentionedTimes.some((time) => !knownTimes.has(time))) issues.push('出现了证据中不存在的具体时间')

  const knownMinutes = new Set(relations.map((relation) => relation.minutes))
  const mentionedMinutes = [...content.matchAll(/(\d+)\s*分钟/g)].map((match) => Number(match[1]))
  if (mentionedMinutes.some((minutes) => !knownMinutes.has(minutes))) issues.push('出现了未经代码验证的时间间隔')
  const knownPeriods = new Set(bundle.items.map((item) => item.dayPeriod))
  const periodClaims = [...content.matchAll(/凌晨|早上|上午|中午|下午|晚上/g)].map((match) => match[0])
  if (periodClaims.some((period) => !knownPeriods.has(period as YinyiEvidenceItem['dayPeriod']))) issues.push('事件时段与选中证据不一致')
  if (/(先是|然后|接着|随后|最后).{0,80}(先是|然后|接着|随后|最后)/s.test(content)) issues.push('按事件顺序罗列，仍有流水账感')

  const opening = normalizedEdge(content)
  const ending = normalizedEdge(content, true)
  if (recentEntries.some((entry) => normalizedEdge(entry) === opening)) issues.push('开头与近期风信重复')
  if (recentEntries.some((entry) => normalizedEdge(entry, true) === ending)) issues.push('结尾与近期风信重复')
  return issues
}
