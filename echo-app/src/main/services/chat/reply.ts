import type { WebContents } from 'electron'
import type { ChatHints, SendChatResult, Track, UiBoundarySnapshot } from '../../../types/ipc'
import { appendConversation } from '../../db/conversations'
import { appendRecommendedTracks } from '../../db/tracks'
import { assertAssistantReplyInputContract, assertSendChatResultContract, enforceAssistantTrackBinding } from './pipelineContract'
import type { CompanionResponseStrategy } from './companionTypes'
import { loadActiveStageContext } from '../../domain/stageContext/repository'
import { attributeTracksToAgentAction, beginAgentAction, completeAgentAction, failAgentAction } from '../../domain/agentAction/service'

export type ChatRuntimeEmit = (channel: string, payload: unknown) => void

export interface AssistantReplyOptions {
  content: string
  tracks?: Track[]
  hints?: ChatHints
  boundary?: UiBoundarySnapshot
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
  const stageContext = loadActiveStageContext()
  const action = beginAgentAction({
    origin: 'chat',
    actionType: 'reply',
    reasonCode: stageContext?.goal === 'companionship' ? 'context_companionship' : 'user_request',
    goalCode: stageContext?.goal ?? 'none',
    stageContextId: stageContext?.id,
    stageContextRevision: stageContext?.revision,
    items: [
      { itemType: 'message', ordinal: 0, payload: { characterCount: content.length } },
      ...tracks.map((track, index) => ({ itemType: 'track' as const, ordinal: index + 1, entityKey: `${track.id ?? track.neteaseId ?? ''}:${track.title}:${track.artist}`, payload: { title: track.title, artist: track.artist } })),
    ],
    decision: { policyVersion: 1, expectsMusicAction: options.expectsMusicAction ?? false },
  })
  const attributedTracks = attributeTracksToAgentAction(
    action,
    tracks.map((track) => ({ ...track, sourceContext: track.sourceContext ?? 'chat' })),
  )
  try {
    if (options.persistTracks) appendRecommendedTracks(attributedTracks)
    const message = appendConversation('assistant', content, attributedTracks, { responseStrategy: options.responseStrategy })
    const payload = {
      message,
      tracks: attributedTracks,
      durationMs: options.durationMs ?? 0,
      ...(options.hints ? { hints: options.hints } : {}),
      ...(options.boundary ? { boundary: { ...options.boundary, sourceId: String(message.id) } } : {}),
    }
    if (options.sender && !options.sender.isDestroyed()) options.sender.send('chat:stream:end', payload)
    options.runtimeEmit?.('runtime:chat-stream-end', payload)
    completeAgentAction(action)
    return assertSendChatResultContract({
      message,
      tracks: attributedTracks,
      ...(options.hints ? { hints: options.hints } : {}),
      ...(options.boundary ? { boundary: { ...options.boundary, sourceId: String(message.id) } } : {}),
    })
  } catch (error) {
    failAgentAction(action, 'reply_delivery_failed')
    throw error
  }
}
