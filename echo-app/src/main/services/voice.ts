import type { VoiceLine } from '../../types/ipc'
import { getSettings } from '../db/settings'
import { loadRecentConversations } from '../db/conversations'
import { isExternalListeningSource, isMeaningfulSkippedReason, loadMeaningfulTrackEventsForDate, type TodayTrackEvent } from '../db/tracks'
import { completeChat, LlmError } from '../llm/client'
import { stripKnownSystemBlocks } from '../llm/outputSanitize'
import { safePromptJson } from '../llm/promptData'
import { getTasteProfile } from '../db/taste'
import { buildMemoryEvidencePrompt } from './memoryEvidence'
import { buildSoulPolicyPrompt } from '../skills/soul/policy'
import { recordHealth } from './health'
import { hasMemorySourceLeak } from './memorySourceGuard'

export interface GenerateVoiceLineOptions {
  signal?: AbortSignal
}

function assertVoiceActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('任务已取消', 'AbortError')
}

function todayIso(): string {
  const date = new Date()
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function cleanVoiceLine(content: string): string {
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

const BANNED_VOICE_LINE_PATTERN = /我给你接上|给你安排|安排上|让你稳稳的|接住你|把情绪接住|把空气撑住|治愈的力量|完全理解你的心情|根据你的画像|根据你的轨迹|根据你的数据|画像|轨迹|数据|算法|记忆策略|纠正过|用户|标签|诊断|人格|你其实|你总是|你一直|太满|太猛|上头|燃爆|往里收/

function hasVoiceLineQuality(content: string): boolean {
  const clean = cleanVoiceLine(content)
  const compactLength = clean.replace(/\s+/g, '').length
  if (compactLength < 8 || compactLength > 90) return false
  if (!clean.includes('我') && !clean.includes('你')) return false
  if (BANNED_VOICE_LINE_PATTERN.test(clean)) return false
  if (hasMemorySourceLeak(clean)) return false
  if (/[-*#]|^\d+[.、]/m.test(clean)) return false
  return true
}

function isPositiveVoiceTrackEvent(event: Pick<TodayTrackEvent, 'source' | 'queueStatus'>): boolean {
  if (event.queueStatus === 'skipped' || event.queueStatus === 'pending') return false
  if (event.queueStatus === 'playing' || event.queueStatus === 'completed') return true
  return isExternalListeningSource(event.source)
}

function latestPositiveTrackEvent(events: TodayTrackEvent[]): TodayTrackEvent | undefined {
  return [...events].reverse().find(isPositiveVoiceTrackEvent)
}

function pickPositiveVoiceTrackEvents(events: TodayTrackEvent[]): TodayTrackEvent[] {
  return events.filter(isPositiveVoiceTrackEvent)
}

function pickDismissedVoiceTrackEvents(events: TodayTrackEvent[]): TodayTrackEvent[] {
  return events.filter((event) => event.queueStatus === 'skipped' && isMeaningfulSkippedReason(event.queueStatusReason))
}

function hasDismissedTrackEvent(events: TodayTrackEvent[]): boolean {
  return events.some((event) => event.queueStatus === 'skipped' && isMeaningfulSkippedReason(event.queueStatusReason))
}

export async function generateVoiceLine(options: GenerateVoiceLineOptions = {}): Promise<VoiceLine> {
  assertVoiceActive(options.signal)
  const conversations = loadRecentConversations(8)
  const trackEvents = loadMeaningfulTrackEventsForDate(todayIso(), 6)
  const settings = getSettings()
  const profile = getTasteProfile()
  const positiveTrackEvents = pickPositiveVoiceTrackEvents(trackEvents)
  const dismissedTrackEvents = pickDismissedVoiceTrackEvents(trackEvents)
  const tracks = positiveTrackEvents.map((event) => `${event.title} - ${event.artist} · ${event.queueStatus ?? 'listened'}`)
  const dismissedTracks = dismissedTrackEvents.map((event) => `${event.title} - ${event.artist} · ${event.queueStatusReason ?? 'skipped'}`)

  const latestTrack = latestPositiveTrackEvent(trackEvents)
  const fallback = latestTrack
    ? `刚才那首《${latestTrack.title}》还在这里。你可以先别急着换，听到副歌再决定。`
    : hasDismissedTrackEvent(trackEvents)
      ? '刚才那首你已经放下了。我顺着你的选择，换口气，我们慢慢来。'
    : '我在。你今天可以不用急着解释什么，先给自己留一点安静。'

  try {
    const content = await completeChat(settings, [
      {
        role: 'system',
        content: `${buildSoulPolicyPrompt('voice')}

生成一段 60 字以内的中文口播，像说给用户听。直接输出正文，温和、克制、具体。
记忆只用于校准语气边界,不要提画像、轨迹、数据、纠正或策略。`,
      },
      {
        role: 'user',
        content: [
          buildMemoryEvidencePrompt(profile),
          safePromptJson({
            recentConversations: conversations.map((item) => ({
              role: item.role,
              content: item.content,
            })),
            positiveTracks: tracks,
            dismissedTracks,
            instruction: '请说一段。',
          }),
        ].join('\n'),
      },
    ], { signal: options.signal, maxTokens: 200 })
    assertVoiceActive(options.signal)
    const clean = cleanVoiceLine(content)
    return { content: clean && hasVoiceLineQuality(clean) ? clean : fallback, status: 'done' }
  } catch (error) {
    assertVoiceActive(options.signal)
    if (error instanceof LlmError) {
      recordHealth('llm', error.kind === 'auth' || error.kind === 'config' ? 'error' : 'degraded', '回声文案生成失败，已使用兜底文案。', error.message)
    }
    return { content: fallback, status: 'done' }
  }
}

export const voiceTestHelpers = {
  cleanVoiceLine,
  hasVoiceLineQuality,
  isPositiveVoiceTrackEvent,
  latestPositiveTrackEvent,
  pickPositiveVoiceTrackEvents,
  pickDismissedVoiceTrackEvents,
  hasDismissedTrackEvent,
}
