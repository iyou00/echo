import type { ChatHints, RuntimeTaskSnapshot, SendChatResult, Track, UiBoundarySnapshot } from '../../../types/ipc'
import type {
  resolvePendingDirectSongChoiceReply,
  resolvePendingDirectSongReply,
  resolvePendingMusicEntityReply,
} from './pendingIntents'
import type { CompanionResponseStrategy } from './companionTypes'

export type ReplyFn = (
  content: string,
  tracks?: Track[],
  options?: { durationMs?: number; hints?: ChatHints; boundary?: UiBoundarySnapshot; persistTracks?: boolean; expectsMusicAction?: boolean; responseStrategy?: CompanionResponseStrategy },
) => SendChatResult

export interface PendingIntentState {
  pendingDirectSongReply: ReturnType<typeof resolvePendingDirectSongReply>
  pendingMusicEntityReply: ReturnType<typeof resolvePendingMusicEntityReply> | null
  pendingDirectSongChoiceReply: ReturnType<typeof resolvePendingDirectSongChoiceReply> | null
  effectiveText: string
}

export type RuntimeReportFn = (patch: Partial<RuntimeTaskSnapshot>) => void
