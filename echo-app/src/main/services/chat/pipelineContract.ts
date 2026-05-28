import type { SendChatResult, Track } from '../../../types/ipc'

export const CHAT_PIPELINE_INVARIANTS = [
  {
    id: 'direct-song-plays-selected-track',
    input: '我要听王菲的《主角》',
    invariant: '音乐动作回复有可播放候选时，最终 tracks 至少包含一首，并且回复文案绑定实际卡片。',
  },
  {
    id: 'session-affirmation-needs-armed-action',
    input: '嗯',
    invariant: '裸确认语只在上一轮明确邀请继续、换歌或播放时触发音乐动作。',
  },
  {
    id: 'session-change-has-candidate-fallback',
    input: '换一首',
    invariant: '上一轮候选过滤为空时，回退原候选池，并继续避开当前正在播放的歌。',
  },
] as const

export function assertAssistantReplyInputContract(content: string, tracks: Track[]): void {
  if (typeof content !== 'string') {
    throw new Error('chat pipeline contract failed: assistant content missing')
  }
  if (!Array.isArray(tracks)) {
    throw new Error('chat pipeline contract failed: reply tracks must be an array')
  }
  for (const track of tracks) {
    if (!track.title || !track.artist) {
      throw new Error('chat pipeline contract failed: track title and artist are required')
    }
  }
}

export function assertSendChatResultContract(result: SendChatResult): SendChatResult {
  if (!result.message || result.message.role !== 'assistant') {
    throw new Error('chat pipeline contract failed: assistant message missing')
  }
  if (typeof result.message.content !== 'string') {
    throw new Error('chat pipeline contract failed: assistant content missing')
  }
  if (!Array.isArray(result.tracks)) {
    throw new Error('chat pipeline contract failed: result tracks must be an array')
  }
  assertAssistantReplyInputContract(result.message.content, result.tracks)
  const messageTracks = result.message.tracks ?? []
  if (messageTracks.length !== result.tracks.length) {
    throw new Error('chat pipeline contract failed: message tracks and result tracks diverged')
  }
  return result
}
