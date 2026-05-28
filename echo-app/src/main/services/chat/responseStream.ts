import type { TasteQuestion, Track } from '../../../types/ipc'
import type { getSettings } from '../../db/settings'
import { LlmError, streamChat } from '../../llm/client'
import { buildChatContext } from '../../llm/prompt'
import { SYSTEM_CONTEXT_TAGS, escapeRegExp, stripKnownSystemBlocks } from '../../llm/outputSanitize'
import { recordHealth } from '../health'
import { checkOutputSafe } from '../safety/output-filter'
import { pickJailbreakResponse } from '../safety/jailbreak-filter'
import type { PendingQuestionReplyCapture } from '../tasteQuestionScheduler'
import { buildSoulPolicyPrompt } from '../../skills/soul/policy'

export interface ChatStreamActive {
  readonly canceled: boolean
  signal: AbortSignal
}

export type ChatChunkEmitter = (chunk: string) => void

const SYSTEM_OUTPUT_TAGS = SYSTEM_CONTEXT_TAGS

export function stripSystemBlocks(text: string): string {
  return stripKnownSystemBlocks(text, SYSTEM_OUTPUT_TAGS)
}

export function stripAssistantFormatting(text: string): string {
  return text
    .replace(/\*\*/g, '')
    .replace(/`{1,3}/g, '')
    .replace(/^#{1,6}\s+/gm, '')
    .replace(/^\s*[-*]\s+/gm, '')
    .replace(/^\s*\d+[.)、]\s+/gm, '')
}

export function sanitizeAssistantDisplayText(text: string): string {
  return stripAssistantFormatting(text)
    .replace(/^\s*收到[，。,.]\s*/, '')
}

function removeChatSurfacePhrasing(text: string): string {
  return text
    .replace(/^\s*(好的|好呀|好啊|嗯嗯)[，。,.]\s*/, '')
    .replace(/从你这(?:几天|段时间)?(?:的)?(?:画像|轨迹|轮廓|记录)看[，,]?\s*/g, '')
    .replace(/根据你的(?:画像|轨迹|数据|记录)[，,]?\s*/g, '')
    .replace(/你现在需要的是/g, '这会儿可以先试试')
    .replace(/被情绪顶了一下/g, '这句听着有点重')
    .replace(/我给你接上/g, '先放')
    .replace(/给你安排(?:上)?/g, '先放')
    .replace(/让你稳稳的/g, '先听半分钟')
    .replace(/把情绪接住|接住你/g, '先放旁边')
    .replace(/撑住空气/g, '放着听')
}

function createStreamDisplaySanitizer(): (chunk: string, done?: boolean) => string {
  let prefixBuffer = ''
  let prefixResolved = false
  let systemBuffer = ''
  let activeSystemTag: string | null = null
  let surfaceBuffer = ''
  const surfaceHoldChars = 8
  const tagMatcher = new RegExp(`<\\/?(?:${SYSTEM_OUTPUT_TAGS.map(escapeRegExp).join('|')})(?:\\s+[^>]*)?>`, 'i')
  const systemTagPrefixes = [...SYSTEM_OUTPUT_TAGS, ...SYSTEM_OUTPUT_TAGS.map((tag) => `/${tag}`)]
  const isPotentialSystemTagPrefix = (fragment: string): boolean => {
    if (!fragment.startsWith('<')) return false
    const tagStart = fragment.slice(1).trimStart().toLowerCase()
    return systemTagPrefixes.some((prefix) => prefix.startsWith(tagStart) || tagStart.startsWith(prefix))
  }

  const stripSystemBlocksFromStream = (chunk: string): string => {
    systemBuffer += chunk
    let output = ''

    while (systemBuffer.length > 0) {
      if (activeSystemTag) {
        const closeMatcher = new RegExp(`</${escapeRegExp(activeSystemTag)}\\s*>`, 'i')
        const closeMatch = closeMatcher.exec(systemBuffer)
        if (!closeMatch) {
          systemBuffer = systemBuffer.slice(-Math.min(systemBuffer.length, activeSystemTag.length + 4))
          return output
        }
        systemBuffer = systemBuffer.slice(closeMatch.index + closeMatch[0].length)
        activeSystemTag = null
        continue
      }

      const tagMatch = tagMatcher.exec(systemBuffer)
      if (!tagMatch) {
        const partialTagIndex = systemBuffer.lastIndexOf('<')
        const partialTag = partialTagIndex >= 0 ? systemBuffer.slice(partialTagIndex) : ''
        if (partialTagIndex >= 0 && systemBuffer.length - partialTagIndex <= 192 && isPotentialSystemTagPrefix(partialTag)) {
          output += systemBuffer.slice(0, partialTagIndex)
          systemBuffer = systemBuffer.slice(partialTagIndex)
          return output
        }
        output += systemBuffer
        systemBuffer = ''
        return output
      }

      output += systemBuffer.slice(0, tagMatch.index)
      const rawTag = tagMatch[0]
      systemBuffer = systemBuffer.slice(tagMatch.index + rawTag.length)
      const tagName = rawTag.match(/^<\/?\s*([a-z_]+)/i)?.[1]?.toLowerCase()
      if (tagName && !rawTag.startsWith('</')) {
        activeSystemTag = tagName
      }
    }

    return output
  }

  const sanitizeSurface = (text: string, done = false): string => {
    if (!text && !done) return ''
    surfaceBuffer = removeChatSurfacePhrasing(surfaceBuffer + text)
    if (done) {
      const output = surfaceBuffer
      surfaceBuffer = ''
      return output
    }
    if (surfaceBuffer.length <= surfaceHoldChars) return ''
    const output = surfaceBuffer.slice(0, -surfaceHoldChars)
    surfaceBuffer = surfaceBuffer.slice(-surfaceHoldChars)
    return output
  }

  return (chunk: string, done = false) => {
    const clean = stripAssistantFormatting(stripSystemBlocksFromStream(chunk))
    if (prefixResolved) return sanitizeSurface(clean, done)
    prefixBuffer += clean
    const trimmed = prefixBuffer.replace(/^\s+/, '')
    const leadingAck = trimmed.match(/^收到[，。,.]\s*/)
    if (leadingAck) {
      prefixResolved = true
      return sanitizeSurface(trimmed.slice(leadingAck[0].length), done)
    }
    if (!done && ('收到'.startsWith(trimmed) || trimmed === '收到')) return ''
    prefixResolved = true
    return sanitizeSurface(prefixBuffer, done)
  }
}

export function sanitizeAssistantOutput(content: string): string {
  const clean = removeChatSurfacePhrasing(sanitizeAssistantDisplayText(stripSystemBlocks(content)))
  return checkOutputSafe(clean).safe ? clean : pickJailbreakResponse(clean)
}

export function friendlyError(error: unknown): string {
  if (error instanceof LlmError) {
    if (error.kind === 'config') return '我连不上自己脑子。去设置里看看 API key?'
    if (error.kind === 'auth') return '我连不上自己脑子。API key 好像过期了。'
    if (error.kind === 'rate_limit') return '我们今天聊得有点快,我这边被限速了。等一下再来。'
    return '我这会儿好像走神了,你刚说的我没跟上,再说一遍?'
  }
  return '我这会儿好像走神了,你刚说的我没跟上,再说一遍?'
}

export function recordChatStreamError(error: unknown): void {
  if (error instanceof LlmError) {
    recordHealth('llm', error.kind === 'auth' || error.kind === 'config' ? 'error' : 'degraded', 'Echo 连不上模型。去设置里检查 API key。', error.message)
  }
}

export function fallbackRecommendationContent(tracks: Track[], overLimitLine: string, overLimit = false): string {
  const first = tracks[0]
  if (!first) return friendlyError(new Error('empty_candidates'))
  const prefix = overLimit ? `${overLimitLine} ` : ''
  if (tracks.length === 1) {
    return `${prefix}我这会儿说得不太顺,但歌先给你挑好了——${first.artist}的《${first.title}》。${first.reason ?? '先听它,比较稳。'}`
  }
  const names = tracks.map((track) => `${track.artist}的《${track.title}》`).join('、')
  return `${prefix}我这会儿说得不太顺,但歌先给你挑好了: ${names}。先从第一首开始。`
}

function pendingAnswerFallback(capture: PendingQuestionReplyCapture): string {
  const title = typeof capture.question?.context?.title === 'string' ? capture.question.context.title.trim() : ''
  const artist = typeof capture.question?.context?.artist === 'string' ? capture.question.context.artist.trim() : ''
  const song = title ? `《${title}》` : '刚才那首'
  const focus = capture.focus || '整体感觉'
  if (capture.polarity === 'negative') {
    return `懂了，${song}这次没贴住你要的${focus}。我会把这个方向收一收，下次别再沿着它硬走。`
  }
  if (capture.polarity === 'mixed') {
    return `懂了，${song}${artist ? `这版${artist}` : ''}有一部分是对的，主要落在${focus}上。我先把这个细节记住。`
  }
  return `懂了，${song}${artist ? `这首${artist}` : ''}算挑对了，打中的是${focus}。我会把这个方向记住，先让它继续放着。`
}

export async function streamPendingAnswerReply(
  userText: string,
  capture: PendingQuestionReplyCapture,
  active: ChatStreamActive,
  settings: ReturnType<typeof getSettings>,
  emitChunk?: ChatChunkEmitter,
): Promise<string> {
  const fallback = pendingAnswerFallback(capture)
  let content = ''
  const sanitizeChunk = createStreamDisplaySanitizer()
  try {
    const title = typeof capture.question?.context?.title === 'string' ? capture.question.context.title.trim() : ''
    const artist = typeof capture.question?.context?.artist === 'string' ? capture.question.context.artist.trim() : ''
    for await (const chunk of streamChat(settings, [

      {
        role: 'system',
        content: `${buildSoulPolicyPrompt('pending_answer')}

你是 Echo。用户正在回答你刚才的追问。

你要做的事:
1. 只回应这次偏好确认。
2. 不推荐新歌,不换歌,不输出歌曲卡片。
3. 自然回应用户说出的偏好,语气像朋友。
4. 40-90 个中文字。

刚才追问:${capture.question?.content ?? ''}
关联歌曲:${artist || '未知艺人'} / ${title || '刚才那首'}
判断:${capture.polarity ?? 'neutral'}
焦点:${capture.focus || '未明确'}`,
      },
      { role: 'user', content: userText },
    ], { signal: active.signal, maxTokens: 300 })) {
      if (active.canceled) break
      content += chunk.content
      const displayChunk = sanitizeChunk(chunk.content)
      if (displayChunk) emitChunk?.(displayChunk)
    }
    const finalDisplayChunk = sanitizeChunk('', true)
    if (finalDisplayChunk) emitChunk?.(finalDisplayChunk)
    return content.trim() || fallback
  } catch (error) {
    recordChatStreamError(error)
    if (content.trim()) {
      const finalDisplayChunk = sanitizeChunk('', true)
      if (finalDisplayChunk) emitChunk?.(finalDisplayChunk)
      return content.trim()
    }
    emitChunk?.(fallback)
    return fallback
  }
}

export async function streamChatReply(options: {
  userText: string
  settings: ReturnType<typeof getSettings>
  active: ChatStreamActive
  candidates: Track[]
  authRequired: boolean
  followUpQuestion: TasteQuestion | null
  emitChunk?: ChatChunkEmitter
}): Promise<string> {
  let content = ''
  const sanitizeChunk = createStreamDisplaySanitizer()
  const messages = buildChatContext(options.userText, {
    recommendationCandidates: options.candidates,
    neteaseAuthRequired: options.authRequired,
    followUpQuestion: options.followUpQuestion,
  })
  try {
    for await (const chunk of streamChat(options.settings, messages, { signal: options.active.signal, maxTokens: 300 })) {
      if (options.active.canceled) break
      content += chunk.content
      const displayChunk = sanitizeChunk(chunk.content)
      if (displayChunk) options.emitChunk?.(displayChunk)
    }
  } catch (error) {
    if (content.trim()) {
      recordChatStreamError(error)
      const finalDisplayChunk = sanitizeChunk('', true)
      if (finalDisplayChunk) options.emitChunk?.(finalDisplayChunk)
      return content
    }
    throw error
  }
  const finalDisplayChunk = sanitizeChunk('', true)
  if (finalDisplayChunk) options.emitChunk?.(finalDisplayChunk)
  if (options.active.canceled) return content.trim() || '行,我先停在这里。'
  return content
}
