import { completeChat } from '../../llm/client'
import type { Settings } from '../../../types/ipc'
import { buildSoulPolicyPrompt } from '../../skills/soul/policy'
import { readRootFile } from '../../utils/paths'

/**
 * 输入翻译器：把用户的任何话翻译成 searchQuery + intent + entities。
 * 「翻译制」架构的核心——LLM 只做翻译，不做分类。
 * 替代旧的 routeChatIntentWithLlm 分类路径。
 */

export interface TranslatedInput {
  /** 2-4 个搜索关键词，null = 非音乐请求 */
  searchQuery: string | null
  /** 一句话描述用户意图（自然语言） */
  intent: string | null
  /** 具体歌手/歌名（如有） */
  artist: string | null
  title: string | null
}

export interface TranslatorContext {
  recentDialog?: Array<{ role: 'user' | 'assistant'; content: string }>
  musicSession?: { artistQuery?: string | null } | null
  currentTrack?: { title: string; artist: string } | null
  pendingIntent?: { continuationTarget?: string } | null
}

function readTranslatorPrompt(): string {
  const raw = readRootFile('prompts/input-translator.md') ?? ''
  // 截取 System 部分（到 ## User 之前）
  const userMarker = raw.indexOf('\n## User')
  return userMarker > 0 ? raw.slice(0, userMarker).trim() : raw.trim()
}

function sanitizeTranslated(raw: unknown): TranslatedInput | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null
  const record = raw as Record<string, unknown>

  const sq = typeof record.searchQuery === 'string' ? record.searchQuery.trim().replace(/\s+/g, ' ').slice(0, 30) : ''
  const searchQuery = sq.length >= 2 && !/[.!?！？。]/.test(sq) ? sq : null

  const intent = typeof record.intent === 'string' ? record.intent.trim().slice(0, 120) || null : null

  const entities = record.entities && typeof record.entities === 'object' && !Array.isArray(record.entities)
    ? record.entities as Record<string, unknown> : {}
  const artist = typeof entities.artist === 'string' && entities.artist.trim() ? entities.artist.trim().slice(0, 40) : null
  const title = typeof entities.title === 'string' && entities.title.trim() ? entities.title.trim().slice(0, 60) : null

  // 描述性短语不是歌名
  if (title && isDescriptivePhrase(title)) return { searchQuery, intent, artist, title: null }

  return { searchQuery, intent, artist, title }
}

function isDescriptivePhrase(text: string): boolean {
  const t = text.trim()
  if (t.length > 12) return true
  return /能把|让.{0,4}(心情|感觉|情绪)|适合.{0,4}(听|现在)|调整|散掉|放松|安静|开心|好起来|想.{0,3}听|的效果|的感觉|心里/.test(t)
}

function buildTranslatorUserPrompt(text: string, context: TranslatorContext): string {
  const ctx: Record<string, unknown> = {}
  const dialog = (context.recentDialog ?? []).slice(-8).map((m) => `${m.role}: ${m.content.slice(0, 200)}`)
  if (dialog.length > 0) ctx.recentDialog = dialog
  if (context.musicSession?.artistQuery) ctx.musicSession = { artistQuery: context.musicSession.artistQuery }
  if (context.currentTrack) ctx.currentTrack = context.currentTrack
  if (context.pendingIntent?.continuationTarget) ctx.pendingIntent = { continuationTarget: context.pendingIntent.continuationTarget }

  return JSON.stringify({ context: ctx, input: text })
}

export async function translateUserInput(
  text: string,
  settings: Settings,
  context: TranslatorContext,
  signal?: AbortSignal,
): Promise<TranslatedInput | null> {
  const trimmed = text.trim()
  if (!trimmed) return null

  const system = `${buildSoulPolicyPrompt('chat')}\n\n${readTranslatorPrompt()}`

  try {
    const raw = await completeChat(settings, [
      { role: 'system', content: system },
      { role: 'user', content: buildTranslatorUserPrompt(trimmed, context) },
    ], { temperature: 0, signal, maxTokens: 200 })

    // 解析 JSON（LLM 可能带 markdown 围栏）
    const cleaned = raw.replace(/```(?:json)?/gi, '').replace(/```/g, '').trim()
    const parsed = JSON.parse(cleaned)
    const result = sanitizeTranslated(parsed)
    if (!result) return null

    console.info(`[translator] sq=${result.searchQuery ?? 'null'} artist=${result.artist ?? '-'} title=${result.title ?? '-'}`)
    return result
  } catch (error) {
    if (signal?.aborted) return null
    console.warn('[translator] failed', error instanceof Error ? error.message : error)
    return null
  }
}
