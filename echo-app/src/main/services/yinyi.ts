import type { YinyiEntry } from '../../types/ipc'
import { loadRecentConversations } from '../db/conversations'
import { loadRecentTracks } from '../db/tracks'
import { getRandomYinyi, getYinyiByDate, getYinyiRange, upsertYinyi } from '../db/yinyi'
import { getSettings } from '../db/settings'
import { buildYinyiContext } from '../llm/prompt'
import { completeChat, LlmError } from '../llm/client'
import { recordHealth } from './health'

function todayIso(): string {
  return new Date().toISOString().slice(0, 10)
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

  if (countWords(cleaned) <= 450) return cleaned
  const sliced = cleaned.slice(0, 450)
  const stop = Math.max(sliced.lastIndexOf('。'), sliced.lastIndexOf('？'), sliced.lastIndexOf('\n\n'))
  return sliced.slice(0, stop > 180 ? stop + 1 : 450).trim()
}

function hasYinyiV4Signals(content: string): boolean {
  const observer = /我(?:看到|听到|注意到|看你)/.test(content)
  const restraint = /我(?:不知道|说不准|猜不到|没问)/.test(content)
  const insight = /我(?:想到|意识到|才发现)|这让我想到/.test(content)
  return observer && restraint && insight
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
    content: '那天的音忆我没写好。你想看的时候,我可以重新写一次。',
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
    const messages = buildYinyiContext(date)
    let content = cleanYinyiContent(await completeChat(settings, messages, { temperature: 0.85 }))
    if (content && !hasYinyiV4Signals(content)) {
      const retry = cleanYinyiContent(await completeChat(settings, [
        ...messages,
        {
          role: 'user',
          content: '上一版没有通过 v4 checklist。请重写:必须有“我看到/我听到/我注意到/我看你”,必须有“我不知道/我说不准/我猜不到/我没问”,必须有“我想到/我意识到/我才发现/这让我想到”。自然分段即可,不用强制“· · ·”。只输出音忆正文。',
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
    const message = error instanceof LlmError ? error.message : '音忆生成失败'
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
