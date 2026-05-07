import type { YinyiEntry } from '../../types/ipc'
import { loadRecentConversations } from '../db/conversations'
import { loadRecentTracks } from '../db/tracks'
import { getRandomYinyi, getYinyiByDate, getYinyiRange, upsertYinyi } from '../db/yinyi'
import { getSettings } from '../db/settings'
import { buildYinyiContext } from '../llm/prompt'
import { completeChat, LlmError } from '../llm/client'
import { recordHealth } from './health'
import { getWeather } from '../weather/client'

function todayIso(): string {
  const date = new Date()
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function countWords(content: string): number {
  return content.replace(/\s+/g, '').length
}

function cleanYinyiContent(content: string): string {
  const cleaned = content
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

function hasYinyiQuality(content: string): boolean {
  const hasFirstPerson = content.includes('我')
  const hasUserMention = content.includes('你')
  const noAIRollup = !/(总共|一共).{0,4}\d+\s*(首|次|条)/.test(content)
  const noAI = !/(总的来说|由此可见|有什么可以|为您|用户)/.test(content)
  return hasFirstPerson && hasUserMention && noAIRollup && noAI
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

export async function generateYinyi(date = todayIso()): Promise<YinyiEntry> {
  const recentMessages = loadRecentConversations(20)
  const recentTracks = loadRecentTracks(20)

  if (recentMessages.length === 0 && recentTracks.length === 0) {
    return upsertYinyi(absentEntry(date))
  }

  const settings = getSettings()
  const started = Date.now()
  try {
    const weather = await getWeather(settings.user.city).catch(() => null)
    const messages = buildYinyiContext(date, weather?.summary)
    let content = cleanYinyiContent(await completeChat(settings, messages, { temperature: 0.85 }))
    if (content && !hasYinyiQuality(content)) {
      const retry = cleanYinyiContent(await completeChat(settings, [
        ...messages,
        {
          role: 'user',
          content: '这一版太像报告了。重写:像朋友在台灯下嘀咕,短一点,有自己的想法在里面。只输出风信正文。',
        },
      ], { temperature: 0.85 }))
      if (retry) content = retry
    }
    if (!content) return upsertYinyi(failedEntry(date, 'LLM 返回空内容'))

    return upsertYinyi({
      date,
      content,
      style: 'dialogue',
      meta: {
        status: 'ok',
        tracks: recentTracks.slice(0, 5),
        word_count: countWords(content),
        conversations_count: recentMessages.length,
        duration_ms: Date.now() - started,
        model: settings.llm.model,
      } as YinyiEntry['meta'],
    })
  } catch (error) {
    const message = error instanceof LlmError ? error.message : '风信生成失败'
    if (error instanceof LlmError) {
      recordHealth('llm', error.kind === 'auth' || error.kind === 'config' ? 'error' : 'degraded', 'Echo 连不上模型。去设置里检查 API key。', error.message)
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
