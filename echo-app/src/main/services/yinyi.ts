import type { YinyiEntry } from '../../types/ipc'
import { loadConversationsForDate, loadUserConversationsForDate } from '../db/conversations'
import { isExternalListeningSource, loadMeaningfulTrackEventsForDate, type TodayTrackEvent } from '../db/tracks'
import { getRandomYinyi, getYinyiByDate, getYinyiRange, upsertYinyi } from '../db/yinyi'
import { getSettings } from '../db/settings'
import { completeChat, LlmError } from '../llm/client'
import { stripKnownSystemBlocks } from '../llm/outputSanitize'
import { recordHealth } from './health'
import { getWeather } from '../weather/client'
import { hasMemorySourceLeak } from './memorySourceGuard'
import {
  buildYinyiCriticMessages,
  buildYinyiDirectorMessages,
  buildYinyiEvidenceBundle,
  buildYinyiWriterMessages,
  deterministicYinyiIssues,
  fallbackYinyiWritingBrief,
  parseYinyiCritique,
  parseYinyiWritingBrief,
  selectedYinyiEvidence,
  verifyYinyiTimeRelations,
  yinyiStyleSignature,
  yinyiStyleConflicts,
  type YinyiStyleSignature,
  type YinyiWritingBrief,
} from './yinyiWriting'

function todayIso(): string {
  const date = new Date()
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function isValidIsoDate(value: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(value)) return false
  const parsed = new Date(`${value}T12:00:00`)
  if (Number.isNaN(parsed.getTime())) return false
  const year = parsed.getFullYear()
  const month = String(parsed.getMonth() + 1).padStart(2, '0')
  const day = String(parsed.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}` === value
}

export interface GenerateYinyiOptions {
  signal?: AbortSignal
}

function assertYinyiActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('任务已取消', 'AbortError')
}

function countWords(content: string): number {
  return content.replace(/\s+/g, '').length
}

function cleanYinyiContent(content: string): string {
  const cleaned = stripKnownSystemBlocks(content)
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```[a-z]*|```/gi, ''))
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^>\s*/, ''))
    .filter(Boolean)
    .join('\n\n')
    .replace(/^["“”'‘’]+|["“”'‘’]+$/g, '')
    .trim()

  if (countWords(cleaned) <= 380) return cleaned
  const sliced = cleaned.slice(0, 380)
  const stop = Math.max(sliced.lastIndexOf('。'), sliced.lastIndexOf('？'), sliced.lastIndexOf('\n\n'))
  return sliced.slice(0, stop > 180 ? stop + 1 : 380).trim()
}

const BANNED_YINYI_TEXT_PATTERN = /我给你接上|给你安排|安排上|让你稳稳的|接住你|把情绪接住|把空气撑住|太满|太猛|上头|燃爆|往里收|音乐是治愈的力量|完全理解你的心情/

function hasYinyiQuality(content: string): boolean {
  const hasFirstPerson = content.includes('我')
  const hasUserMention = content.includes('你')
  const noAIRollup = !/(总共|一共).{0,4}\d+\s*(首|次|条)/.test(content)
  const noAI = !/(总的来说|由此可见|有什么可以|为您|用户)/.test(content)
  const noOverread = !/(从你这几天|从你这段时间|从你的轨迹|从画像|你的轮廓|说明你|你其实|你总是|你一直|潜意识|人格|诊断|标签|算法|数据)/.test(content)
  const noMemoryLeak = !/(记忆策略|memory|纠正过|用户纠正|画像证据|信号审计)/i.test(content)
  const noMemorySourceLeak = !hasMemorySourceLeak(content)
  const noBannedPhrasing = !BANNED_YINYI_TEXT_PATTERN.test(content)
  return hasFirstPerson && hasUserMention && noAIRollup && noAI && noOverread && noMemoryLeak && noMemorySourceLeak && noBannedPhrasing
}

function yinyiQualityRetryInstruction(): string {
  return [
    '这一版没有通过风信质量检查，请重写。',
    '保留 writing_brief 的内在线索，只写 selected_evidence，不补写其他事件。',
    '用选材、节奏和留白改善表达，不堆意象，也不要机械增加“我猜”“也许”。',
    '不要提画像、轨迹、数据、记忆策略。',
    '只输出风信正文。',
  ].join('\n')
}

function absentEntry(date: string): YinyiEntry {
  return {
    date,
    content: '今天没见到你。我在这里等了一会儿。',
    style: 'dialogue',
    meta: { status: 'absent', tracks: [] },
  }
}

function failedEntry(date: string, message: string): YinyiEntry {
  return {
    date,
    content: '那天的风信我没写好。你想看的时候,我可以重新写一次。',
    style: 'dialogue',
    meta: { status: 'failed', error: message, tracks: [] },
  }
}

function compactLine(value: string, max = 8): string {
  const clean = value.replace(/\s+/g, ' ').trim()
  return clean.length > max ? `${clean.slice(0, max)}...` : clean
}

function isPositiveYinyiTrackEvent(track: Pick<TodayTrackEvent, 'source' | 'queueStatus'>): boolean {
  if (track.queueStatus === 'skipped' || track.queueStatus === 'pending') return false
  if (track.queueStatus === 'playing' || track.queueStatus === 'completed') return true
  return isExternalListeningSource(track.source)
}

function pickPositiveYinyiTracks(tracks: TodayTrackEvent[]): TodayTrackEvent[] {
  return tracks.filter(isPositiveYinyiTrackEvent)
}

function pickDismissedYinyiTracks(tracks: TodayTrackEvent[]): TodayTrackEvent[] {
  return tracks.filter((track) => track.queueStatus === 'skipped')
}

function yinyiMetaTrack(track: TodayTrackEvent) {
  return {
    title: track.title,
    artist: track.artist,
    album: track.album,
    source: track.source,
    queueStatus: track.queueStatus,
    queueStatusReason: track.queueStatusReason,
  }
}

function fallbackYinyiEntry(date: string, messages: ReturnType<typeof loadUserConversationsForDate>, tracks: ReturnType<typeof loadMeaningfulTrackEventsForDate>, error: string): YinyiEntry {
  const lastUserMessage = messages.at(-1)?.content
  const positiveTracks = pickPositiveYinyiTracks(tracks)
  const dismissedTracks = pickDismissedYinyiTracks(tracks)
  const firstTrack = positiveTracks[0]
  const hasDismissedTracks = tracks.length > 0 && positiveTracks.length === 0
  const hasExplicitDismissal = dismissedTracks.some((track) => track.queueStatusReason === 'explicit_feedback')
  const opening = lastUserMessage
    ? `你今天最后留下的一句话是“${compactLine(lastUserMessage)}”。我不替你解释，只把它认真记在这里。`
    : '你今天留下的话不多。我不替这段安静找理由，只把它记在这里。'
  const musicLine = firstTrack
    ? isExternalListeningSource(firstTrack.source)
      ? `你还主动放过${firstTrack.artist}的《${firstTrack.title}》。歌和那句话并排留着，就够了。`
      : `我今天还放过${firstTrack.artist}的《${firstTrack.title}》。这是我递过去的歌，不替你说明什么。`
    : hasDismissedTracks
      ? hasExplicitDismissal
        ? '今天也有歌被你放下。放下就是放下，我不替它添加别的意思。'
        : '今天也有歌很快停下。停下就是停下，我不替它添加别的意思。'
      : '今天没有可确认的播放留下来，这封信就停在这句话旁边。'

  return {
    date,
    content: `${opening}\n\n${musicLine}`,
    style: 'dialogue',
    meta: {
      status: 'ok',
      tracks: positiveTracks.slice(0, 5).map(yinyiMetaTrack),
      dismissed_tracks: dismissedTracks.slice(0, 5).map(yinyiMetaTrack),
      word_count: countWords(`${opening}${musicLine}`),
      conversations_count: messages.length,
      fallback: true,
      fallback_error: error,
    } as YinyiEntry['meta'],
  }
}

function shouldUseFallback(error: unknown): boolean {
  if (!(error instanceof LlmError)) return false
  return error.kind !== 'config' && error.kind !== 'auth'
}

function recentStyleSignatures(entries: YinyiEntry[]): YinyiStyleSignature[] {
  return entries.flatMap((entry) => {
    const value = entry.meta?.style_signature
    if (!value || typeof value !== 'object') return []
    return [value as unknown as YinyiStyleSignature]
  })
}

async function reviewYinyi(
  settings: ReturnType<typeof getSettings>,
  content: string,
  brief: YinyiWritingBrief,
  bundle: ReturnType<typeof buildYinyiEvidenceBundle>,
  relations: ReturnType<typeof verifyYinyiTimeRelations>,
  recentEntries: YinyiEntry[],
  signal?: AbortSignal,
): Promise<string[]> {
  const selectedBundle = { ...bundle, items: selectedYinyiEvidence(brief, bundle) }
  const localIssues = deterministicYinyiIssues(content, selectedBundle, relations, recentEntries.map((entry) => entry.content))
  if (localIssues.length > 0) return localIssues
  try {
    const raw = await completeChat(settings, buildYinyiCriticMessages(content, brief, bundle, relations, recentEntries.map((entry) => entry.content)), {
      temperature: 0.2,
      maxTokens: 220,
      signal,
    })
    assertYinyiActive(signal)
    const critique = parseYinyiCritique(raw)
    if (!critique) {
      recordHealth('llm', 'degraded', '风信文学质检结果无法解析，将重写或使用事实兜底。')
      return ['文学质检结果无法解析']
    }
    return critique && !critique.passed ? critique.issues.length > 0 ? critique.issues : ['整体仍不像写给一个具体人的观察信'] : []
  } catch (error) {
    assertYinyiActive(signal)
    const message = error instanceof Error ? error.message : '未知错误'
    recordHealth('llm', 'degraded', '风信文学质检失败，将重写或使用事实兜底。', message)
    return ['文学质检不可用']
  }
}

export async function generateYinyi(date = todayIso(), options: GenerateYinyiOptions = {}): Promise<YinyiEntry> {
  if (!isValidIsoDate(date)) {
    throw new Error('风信日期无效')
  }
  if (date > todayIso()) {
    throw new Error('未来的风信还没有发生')
  }
  assertYinyiActive(options.signal)
  const recentMessages = loadUserConversationsForDate(date, 20)
  const allConversations = loadConversationsForDate(date, 40)
  const recentTracks = loadMeaningfulTrackEventsForDate(date, 60)
  const positiveTracks = pickPositiveYinyiTracks(recentTracks)
  const dismissedTracks = pickDismissedYinyiTracks(recentTracks)

  if (recentMessages.length === 0 && recentTracks.length === 0) {
    return absentEntry(date)
  }

  const settings = getSettings()
  const started = Date.now()
  try {
    const weather = date === todayIso()
      ? await getWeather(settings.user.city, { signal: options.signal })
      : null
    assertYinyiActive(options.signal)
    const recentEntries = getYinyiRange(7).filter((entry) => entry.date !== date)
    const bundle = buildYinyiEvidenceBundle(date, allConversations, recentTracks, weather?.summary)
    const recentStyles = recentStyleSignatures(recentEntries)
    const directorMessages = buildYinyiDirectorMessages(bundle, recentStyles)
    const directorRaw = await completeChat(settings, directorMessages, {
      temperature: 0.55,
      signal: options.signal,
      maxTokens: 520,
    })
    assertYinyiActive(options.signal)
    let brief = parseYinyiWritingBrief(directorRaw, bundle)
    const styleIssues = brief ? yinyiStyleConflicts(brief, recentStyles) : []
    if (brief && styleIssues.length > 0) {
      try {
        const revisedRaw = await completeChat(settings, [...directorMessages, {
          role: 'user',
          content: `上一版写法计划与近期风信重复。只重做写法计划并返回 JSON：\n${styleIssues.map((issue) => `- ${issue}`).join('\n')}`,
        }], { temperature: 0.55, signal: options.signal, maxTokens: 520 })
        assertYinyiActive(options.signal)
        const revised = parseYinyiWritingBrief(revisedRaw, bundle)
        if (revised && yinyiStyleConflicts(revised, recentStyles).length === 0) brief = revised
        else brief = null
      } catch (error) {
        assertYinyiActive(options.signal)
        recordHealth('llm', 'degraded', '风信写法去重失败，已使用安全写法计划。', error instanceof Error ? error.message : String(error))
        brief = null
      }
    }
    brief ??= fallbackYinyiWritingBrief(bundle, recentStyles)
    const relations = verifyYinyiTimeRelations(brief, bundle)
    const writerMessages = buildYinyiWriterMessages(brief, bundle, relations)
    let content = cleanYinyiContent(await completeChat(settings, writerMessages, { temperature: 0.88, signal: options.signal, maxTokens: 800 }))
    assertYinyiActive(options.signal)
    let issues = content && hasYinyiQuality(content)
      ? await reviewYinyi(settings, content, brief, bundle, relations, recentEntries, options.signal)
      : content
        ? ['存在报告腔、过度解读、内部信息或禁用套话']
        : ['模型返回了空正文']
    let qualityPassed = Boolean(content && issues.length === 0)
    if (!qualityPassed) {
      try {
        const retry = cleanYinyiContent(await completeChat(settings, [
          ...writerMessages,
          {
            role: 'user',
            content: `${yinyiQualityRetryInstruction()}\n这次只修复以下问题：\n${issues.map((issue) => `- ${issue}`).join('\n')}`,
          },
        ], { temperature: 0.85, signal: options.signal, maxTokens: 800 }))
        assertYinyiActive(options.signal)
        issues = retry && hasYinyiQuality(retry)
          ? await reviewYinyi(settings, retry, brief, bundle, relations, recentEntries, options.signal)
          : ['重写仍未通过基础表达边界']
        if (retry && issues.length === 0) {
          content = retry
          qualityPassed = true
        }
      } catch (retryError) {
        assertYinyiActive(options.signal)
        if (retryError instanceof LlmError) {
          recordHealth('llm', retryError.kind === 'auth' || retryError.kind === 'config' ? 'error' : 'degraded', '风信重写失败，将使用事实兜底。', retryError.message)
        }
      }
    }
    if (!content) {
      recordHealth('llm', 'degraded', '风信模型连续返回空正文，已使用事实兜底。', 'LLM 连续返回空内容')
      return upsertYinyi(fallbackYinyiEntry(date, recentMessages, recentTracks, 'LLM 连续返回空内容'))
    }
    if (!qualityPassed) return upsertYinyi(fallbackYinyiEntry(date, recentMessages, recentTracks, '风信质量检查未通过'))

    return upsertYinyi({
      date,
      content,
      style: 'dialogue',
      meta: {
        status: 'ok',
        tracks: positiveTracks.slice(0, 5).map(yinyiMetaTrack),
        dismissed_tracks: dismissedTracks.slice(0, 5).map(yinyiMetaTrack),
        word_count: countWords(content),
        conversations_count: recentMessages.length,
        duration_ms: Date.now() - started,
        model: settings.llm.model,
        style_signature: yinyiStyleSignature(brief),
        evidence_ids: [...brief.anchorEvidenceIds, ...brief.supportingEvidenceIds],
        verified_time_relations: relations,
      } as YinyiEntry['meta'],
    })
  } catch (error) {
    assertYinyiActive(options.signal)
    const message = error instanceof LlmError ? error.message : '风信生成失败'
    if (error instanceof LlmError) {
      recordHealth('llm', error.kind === 'auth' || error.kind === 'config' ? 'error' : 'degraded', 'Echo 连不上模型。去设置里检查 API key。', error.message)
    }
    if (shouldUseFallback(error)) {
      return upsertYinyi(fallbackYinyiEntry(date, recentMessages, recentTracks, message))
    }
    return upsertYinyi(failedEntry(date, message))
  }
}

export function getByDate(date: string): YinyiEntry | null {
  return getYinyiByDate(date)
}

export function getRange(limit = 30): YinyiEntry[] {
  return getYinyiRange(limit)
}

export function getRandom(): YinyiEntry | null {
  return getRandomYinyi()
}

export const yinyiTestHelpers = {
  cleanYinyiContent,
  hasYinyiQuality,
  fallbackYinyiEntry,
  pickPositiveYinyiTracks,
  pickDismissedYinyiTracks,
}
