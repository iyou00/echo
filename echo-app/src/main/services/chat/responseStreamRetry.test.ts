import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Settings } from '../../../types/ipc'

const mocks = vi.hoisted(() => ({
  completeChat: vi.fn(),
  streamChat: vi.fn(),
}))

vi.mock('../../llm/client', () => ({
  completeChat: mocks.completeChat,
  streamChat: mocks.streamChat,
  LlmError: class LlmError extends Error {
    kind = 'server'
  },
}))

vi.mock('../../llm/prompt', () => ({
  buildChatContext: (userText: string) => [{ role: 'user', content: userText }],
}))

import { streamChatReply } from './responseStream'

const settings = {
  llm: { provider: 'openai', baseUrl: 'https://example.com/v1', apiKey: 'test-key', model: 'test-model' },
} as unknown as Settings

describe('chat response empty-stream retry', () => {
  beforeEach(() => {
    mocks.completeChat.mockReset()
    mocks.streamChat.mockReset()
  })

  it('retries once with a non-streaming model call when the stream is empty', async () => {
    mocks.streamChat.mockImplementation(async function* () {})
    mocks.completeChat.mockResolvedValue('心情不好就先歇一下。我给你挑了3首，陪你缓一缓。')

    const content = await streamChatReply({
      userText: '最近心情不好，你推荐3首歌给我听。',
      settings,
      active: { signal: new AbortController().signal, canceled: false },
      candidates: [],
      authRequired: false,
      followUpQuestion: null,
    })

    expect(content).toContain('3首')
    expect(mocks.completeChat).toHaveBeenCalledTimes(1)
  })

  it('keeps a successful streamed response without issuing a retry', async () => {
    mocks.streamChat.mockImplementation(async function* () {
      yield { content: '我给你挑好了，先听听。' }
    })

    const content = await streamChatReply({
      userText: '推荐一首歌',
      settings,
      active: { signal: new AbortController().signal, canceled: false },
      candidates: [],
      authRequired: false,
      followUpQuestion: null,
    })

    expect(content).toBe('我给你挑好了，先听听。')
    expect(mocks.completeChat).not.toHaveBeenCalled()
  })
})
