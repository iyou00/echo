import type { Settings, Track } from '../../../types/ipc'
import { completeChat } from '../../llm/client'
import { safePromptJson } from '../../llm/promptData'
import { buildSoulPolicyPrompt } from '../../skills/soul/policy'
import { sanitizeAssistantOutput } from './responseStream'
import type { CompanionResponseStrategy } from './companionTypes'

function preservesRequiredDetails(content: string, requiredDetails: string[]): boolean {
  return requiredDetails.every((detail) => !detail.trim() || content.includes(detail.trim()))
}

function throwIfAborted(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('任务已取消', 'AbortError')
}

export async function composePlannedReply(input: {
  userText: string
  factualContent: string
  settings: Settings
  strategy?: CompanionResponseStrategy
  tracks?: Track[]
  requiredDetails?: string[]
  signal?: AbortSignal
}): Promise<string> {
  if (!input.strategy) return input.factualContent
  throwIfAborted(input.signal)
  try {
    const rawContent = await completeChat(input.settings, [
      {
        role: 'system',
        content: `${buildSoulPolicyPrompt('chat')}

你负责把已经完成的业务结果写成一条自然回复。
- factualContent 是已经确认的事实和动作，完整保留它的含义。
- responseStrategy 决定语气、分寸和长度，不要展示任何字段名或内部机制。
- 不新增歌手、歌名、天气数字、用户经历或系统动作。
- serious_care 禁止调侃；playful_tease 最多一句善意调侃，随后落到具体关心。
- 只输出最终回复正文。`,
      },
      {
        role: 'user',
        content: safePromptJson({
          input: input.userText,
          factualContent: input.factualContent,
          responseStrategy: input.strategy,
          tracks: (input.tracks ?? []).map((track) => ({ title: track.title, artist: track.artist })),
        }),
      },
    ], { signal: input.signal, maxTokens: 260, temperature: 0.75 }).catch((error) => {
      throwIfAborted(input.signal)
      throw error
    })
    const content = sanitizeAssistantOutput(rawContent)
    if (!content.trim()) return input.factualContent
    if (!preservesRequiredDetails(content, input.requiredDetails ?? [])) return input.factualContent
    return content.trim()
  } catch (error) {
    throwIfAborted(input.signal)
    return input.factualContent
  }
}
