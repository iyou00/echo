import type { ChatMessage, Track } from '../../types/ipc'

export function mergeReturnedTracksIntoMessage(message: ChatMessage, tracks: Track[]): ChatMessage {
  if (message.tracks?.length || tracks.length === 0) return message
  return { ...message, tracks }
}
