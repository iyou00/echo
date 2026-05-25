import type { WebContents } from 'electron'
import type { ChatMessage, SendChatResult } from '../../types/ipc'
import { loadTodayConversations } from '../db/conversations'
import type { EchoAgent } from '../runtime/agent'
import { cancelTasksByKind, runAgent } from '../runtime/runtime'
import { runChatSendPipeline } from './chat/sendPipeline'

interface ChatAgentInput {
  text: string
  sender?: WebContents
}

export const chatAgent: EchoAgent<ChatAgentInput, SendChatResult> = {
  kind: 'chat-send',
  async run(input, context) {
    context.report({ phase: 'chat', current: 0, total: 5 })
    const result = await runChatSendPipeline(input.text, input.sender, context.signal, context.emit, context.report)
    context.report({ phase: 'done', current: 5, total: 5 })
    return result
  },
}

export async function send(text: string, sender?: WebContents): Promise<SendChatResult> {
  return runAgent(chatAgent, { text, sender }, {
    phase: 'chat',
    current: 0,
    total: 5,
    sourceName: text.slice(0, 64),
    cancellable: true,
    uniqueKey: 'chat-send',
  })
}

export function loadRecent(limit = 30): ChatMessage[] {
  return loadTodayConversations(limit)
}

export function cancel(): { ok: boolean } {
  cancelTasksByKind('chat-send')
  return { ok: true }
}
