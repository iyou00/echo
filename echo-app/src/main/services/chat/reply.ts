import type { WebContents } from 'electron'
import type { ChatHints, SendChatResult, Track } from '../../../types/ipc'
import { appendConversation } from '../../db/conversations'
import { appendRecommendedTracks } from '../../db/tracks'

export type ChatRuntimeEmit = (channel: string, payload: unknown) => void

export interface AssistantReplyOptions {
  content: string
  tracks?: Track[]
  hints?: ChatHints
  durationMs?: number
  sender?: WebContents
  runtimeEmit?: ChatRuntimeEmit
  persistTracks?: boolean
}

export function appendAssistantReply(options: AssistantReplyOptions): SendChatResult {
  const tracks = options.tracks ?? []
  if (options.persistTracks) appendRecommendedTracks(tracks)
  const message = appendConversation('assistant', options.content, tracks)
  const payload = {
    message,
    tracks,
    durationMs: options.durationMs ?? 0,
    ...(options.hints ? { hints: options.hints } : {}),
  }
  options.sender?.send('chat:stream:end', payload)
  options.runtimeEmit?.('runtime:chat-stream-end', payload)
  return {
    message,
    tracks,
    ...(options.hints ? { hints: options.hints } : {}),
  }
}
