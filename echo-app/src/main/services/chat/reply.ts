import type { WebContents } from 'electron'
import type { ChatHints, SendChatResult, Track } from '../../../types/ipc'
import { appendConversation } from '../../db/conversations'
import { appendRecommendedTracks } from '../../db/tracks'
import { assertAssistantReplyInputContract, assertSendChatResultContract, enforceAssistantTrackBinding } from './pipelineContract'
import type { CompanionResponseStrategy } from './companionTypes'

export type ChatRuntimeEmit = (channel: string, payload: unknown) => void

export interface AssistantReplyOptions {
  content: string
  tracks?: Track[]
  hints?: ChatHints
  durationMs?: number
  sender?: WebContents
  runtimeEmit?: ChatRuntimeEmit
  persistTracks?: boolean
  expectsMusicAction?: boolean
  responseStrategy?: CompanionResponseStrategy
}

export function appendAssistantReply(options: AssistantReplyOptions): SendChatResult {
  const tracks = options.tracks ?? []
  const content = enforceAssistantTrackBinding(options.content, tracks, options.expectsMusicAction ?? false)
  assertAssistantReplyInputContract(content, tracks)
  if (options.persistTracks) appendRecommendedTracks(tracks)
  const message = appendConversation('assistant', content, tracks, { responseStrategy: options.responseStrategy })
  const payload = {
    message,
    tracks,
    durationMs: options.durationMs ?? 0,
    ...(options.hints ? { hints: options.hints } : {}),
  }
  if (options.sender && !options.sender.isDestroyed()) options.sender.send('chat:stream:end', payload)
  options.runtimeEmit?.('runtime:chat-stream-end', payload)
  return assertSendChatResultContract({
    message,
    tracks,
    ...(options.hints ? { hints: options.hints } : {}),
  })
}
