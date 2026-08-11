import { describe, expect, it } from 'vitest'
import type { ChatMessage, Track } from '../../types/ipc'
import { mergeReturnedTracksIntoMessage } from './chatMessageTracks'

describe('chat message track merging', () => {
  it('keeps top-level returned tracks when the final message has no tracks', () => {
    const message: ChatMessage = {
      id: 1,
      role: 'assistant',
      content: '先听《沉溺》。',
      createdAt: '2026-06-22T00:00:00.000Z',
      tracks: [],
    }
    const tracks: Track[] = [
      { id: 'track-1', title: '沉溺', artist: '陈默之', source: 'netease' },
    ]

    expect(mergeReturnedTracksIntoMessage(message, tracks).tracks).toEqual(tracks)
  })

  it('keeps message tracks as authoritative when they are present', () => {
    const messageTrack: Track = { id: 'message-track', title: '主角', artist: '王菲', source: 'netease' }
    const fallbackTrack: Track = { id: 'fallback-track', title: '沉溺', artist: '陈默之', source: 'netease' }
    const message: ChatMessage = {
      id: 1,
      role: 'assistant',
      content: '先听《主角》。',
      createdAt: '2026-06-22T00:00:00.000Z',
      tracks: [messageTrack],
    }

    expect(mergeReturnedTracksIntoMessage(message, [fallbackTrack]).tracks).toEqual([messageTrack])
  })
})
