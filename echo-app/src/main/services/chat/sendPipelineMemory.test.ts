import { describe, expect, it } from 'vitest'
import { chatSendPipelineTestHelpers } from './sendPipeline'
import { classifyChatIntent } from './intent'
import type { Track } from '../../../types/ipc'

describe('chat weak memory signal boundaries', () => {
  it('maps music focus words to vibe signals instead of artists', () => {
    const voice = chatSendPipelineTestHelpers.buildChatTasteSignal('我喜欢人声更近一点的歌')
    expect(voice?.kind).toBe('reinforce_vibe')
    expect(voice?.payload.target).toBe('人声')

    const melody = chatSendPipelineTestHelpers.buildChatTasteSignal('我喜欢旋律舒服一点的歌')
    expect(melody?.kind).toBe('reinforce_vibe')
    expect(melody?.payload.target).toBe('旋律')
  })

  it('still treats explicit artist preference as artist signal', () => {
    const signal = chatSendPipelineTestHelpers.buildChatTasteSignal('我喜欢陈奕迅的歌')
    expect(signal?.kind).toBe('like_artist')
    expect(signal?.payload.target).toBe('陈奕迅')
  })

  it('does not attach explicit external song preference to the current track', () => {
    const currentTrack = {
      id: 'current',
      title: '为爱痴狂',
      artist: '金志文',
      duration: 142,
    } as Track
    const intent = classifyChatIntent('王菲的主角这个首歌，我还蛮喜欢听的', { currentTrack })

    expect(intent.kind).not.toBe('feedback_current_track')
    expect(intent.artistQuery).toBe('王菲')
    expect(intent.seedTitle).toBe('主角')
  })

  it('keeps obvious current track replacement as current feedback', () => {
    const currentTrack = {
      id: 'current',
      title: '为爱痴狂',
      artist: '金志文',
      duration: 142,
    } as Track
    const intent = classifyChatIntent('这首歌不好听，换一首激情一点的', { currentTrack })

    expect(intent.kind).toBe('feedback_current_track')
    expect(intent.feedbackAction).toBe('not_right')
  })

  it('treats bare song preference as preference instead of current feedback', () => {
    const currentTrack = {
      id: 'current',
      title: '为爱痴狂',
      artist: '金志文',
      duration: 142,
    } as Track
    const intent = classifyChatIntent('我喜欢《主角》这首歌', { currentTrack })

    expect(intent.kind).not.toBe('feedback_current_track')
    expect(intent.seedTitle).toBe('主角')
  })
})
