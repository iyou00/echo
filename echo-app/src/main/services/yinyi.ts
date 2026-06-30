import type { YinyiEntry } from '../../types/ipc'
import { loadUserConversationsForDate } from '../db/conversations'
import { isExternalListeningSource, loadMeaningfulTrackEventsForDate, type TodayTrackEvent } from '../db/tracks'
import { getRandomYinyi, getYinyiByDate, getYinyiRange, upsertYinyi } from '../db/yinyi'
import { getSettings } from '../db/settings'
import { buildYinyiContext } from '../llm/prompt'
import { completeChat, LlmError } from '../llm/client'
import { stripKnownSystemBlocks } from '../llm/outputSanitize'
import { recordHealth } from './health'
import { getWeather } from '../weather/client'
import { hasMemorySourceLeak } from './memorySourceGuard'

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
    '这一版有报告感或过度解读。重写:',
    '像朋友在台灯下嘀咕,短一点,有自己的想法在里面。',
    '可以引用今天真实发生的歌和话,不要提画像、轨迹、数据、记忆策略。',
    '把判断写得轻一点,多用“我猜”“像是”“也许”。',
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

function compactLine(value: string, max = 42): string {
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
  const secondTrack = positiveTracks.find((track) => track.title !== firstTrack?.title || track.artist !== firstTrack?.artist)
  const hasDismissedTracks = tracks.length > 0 && positiveTracks.length === 0
  const opening = lastUserMessage
    ? `今天先写短一点。你最后留在我这里的一句是“${compactLine(lastUserMessage)}”,像把一天的声音轻轻按住了一下。`
    : '今天先写短一点。你留下的声音不多,我就按最近这一点余温往下写。'
  const musicLine = firstTrack
    ? `耳边还放着${firstTrack.artist}的《${firstTrack.title}》${secondTrack ? `,后面又接过${secondTrack.artist}的《${secondTrack.title}》` : ''}。我喜欢这种不急着解释的时刻,歌先在旁边放着。`
    : hasDismissedTracks
      ? '今天有几首歌来过又被你放下。我会把它们记作路过；有些声音只是擦肩，擦肩也算今天的一部分。'
    : '今天没有新的歌落下来,但空白也算一种记录。它说明有些时候你只是路过,没有非要把什么说完整。'

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

export async function generateYinyi(date = todayIso(), options: GenerateYinyiOptions = {}): Promise<YinyiEntry> {
  if (!isValidIsoDate(date)) {
    throw new Error('风信日期无效')
  }
  if (date > todayIso()) {
    throw new Error('未来的风信还没有发生')
  }
  assertYinyiActive(options.signal)
  const recentMessages = loadUserConversationsForDate(date, 20)
  const recentTracks = loadMeaningfulTrackEventsForDate(date, 20)
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
    const messages = buildYinyiContext(date, weather?.summary)
    let content = cleanYinyiContent(await completeChat(settings, messages, { temperature: 0.85, signal: options.signal, maxTokens: 800 }))
    assertYinyiActive(options.signal)
    let qualityPassed = Boolean(content && hasYinyiQuality(content))
    if (content && !qualityPassed) {
      try {
        const retry = cleanYinyiContent(await completeChat(settings, [
          ...messages,
          {
            role: 'user',
            content: yinyiQualityRetryInstruction(),
          },
        ], { temperature: 0.85, signal: options.signal, maxTokens: 800 }))
        assertYinyiActive(options.signal)
        if (retry && hasYinyiQuality(retry)) {
          content = retry
          qualityPassed = true
        }
      } catch (retryError) {
        assertYinyiActive(options.signal)
        if (retryError instanceof LlmError) {
          recordHealth('llm', retryError.kind === 'auth' || retryError.kind === 'config' ? 'error' : 'degraded', '风信重写失败，已保留第一版。', retryError.message)
        }
      }
    }
    if (!content) return upsertYinyi(failedEntry(date, 'LLM 返回空内容'))
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
