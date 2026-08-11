import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Settings } from '../../../types/ipc'
import type { CompanionResponseStrategy } from './companionTypes'

const mocks = vi.hoisted(() => ({ completeChat: vi.fn() }))

vi.mock('../../llm/client', () => ({
  completeChat: mocks.completeChat,
  streamChat: vi.fn(),
  LlmError: class LlmError extends Error {
    kind = 'server'
  },
}))

import { composePlannedReply } from './plannedReply'

const settings = {
  llm: { provider: 'openai', baseUrl: 'https://example.com/v1', apiKey: 'test-key', model: 'test-model' },
} as unknown as Settings

const strategy: CompanionResponseStrategy = {
  mode: 'warm_care',
  warmth: 0.85,
  playfulness: 0.05,
  directness: 0.5,
  initiative: 'suggest_action',
  verbosity: 'short',
  vulnerability: 'medium',
  reasonCodes: ['current_vulnerability'],
}

describe('planned fixed-branch reply', () => {
  beforeEach(() => {
    mocks.completeChat.mockReset()
  })

  it('uses the calibrated strategy to rewrite a factual result', async () => {
    mocks.completeChat.mockResolvedValue('上海现在有小雨，出门记得带伞，别让今天再添堵。')

    const content = await composePlannedReply({
      userText: '今天被骂了，上海天气怎么样',
      factualContent: '上海现在有小雨。',
      settings,
      strategy,
      requiredDetails: ['上海'],
    })

    expect(content).toContain('上海')
    expect(content).toContain('带伞')
  })

  it('falls back to the factual result when required details disappear', async () => {
    mocks.completeChat.mockResolvedValue('外面天气还行，出去走走吧。')

    const content = await composePlannedReply({
      userText: '上海天气怎么样',
      factualContent: '上海现在有小雨。',
      settings,
      strategy,
      requiredDetails: ['上海'],
    })

    expect(content).toBe('上海现在有小雨。')
  })

  it('propagates cancellation instead of persisting a fallback reply', async () => {
    const controller = new AbortController()
    controller.abort()

    await expect(composePlannedReply({
      userText: '上海天气怎么样',
      factualContent: '上海现在有小雨。',
      settings,
      strategy,
      signal: controller.signal,
    })).rejects.toMatchObject({ name: 'AbortError' })
    expect(mocks.completeChat).not.toHaveBeenCalled()
  })

  it('propagates cancellation that happens while the model call is running', async () => {
    const controller = new AbortController()
    mocks.completeChat.mockImplementation((_settings, _messages, options) => new Promise<string>((_resolve, reject) => {
      const rejectAsAborted = () => reject(new Error('aborted'))
      if (options?.signal?.aborted) rejectAsAborted()
      else options?.signal?.addEventListener('abort', rejectAsAborted, { once: true })
    }))

    const pendingReply = composePlannedReply({
      userText: '上海天气怎么样',
      factualContent: '上海现在有小雨。',
      settings,
      strategy,
      signal: controller.signal,
    })
    await vi.waitFor(() => expect(mocks.completeChat).toHaveBeenCalledOnce())
    controller.abort()

    await expect(pendingReply).rejects.toMatchObject({ name: 'AbortError' })
  })
})
