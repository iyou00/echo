import { afterEach, describe, expect, it, vi } from 'vitest'
import type { Settings } from '../../types/ipc'
import { completeChat, LlmError } from './client'

const settings = {
  llm: { baseUrl: 'https://api.test/v1', apiKey: 'test-key', model: 'test-model' },
} as unknown as Settings

type FetchMock = ReturnType<typeof vi.fn<(...args: never[]) => Promise<Response>>>

function mockFetchOnce(body: unknown): FetchMock {
  const response = new Response(JSON.stringify(body), { status: 200, headers: { 'content-type': 'application/json' } })
  return vi.fn(async () => response)
}

function sentMaxTokens(fetchMock: FetchMock): number {
  const call = fetchMock.mock.calls[0] as unknown as [unknown, { body: string }] | undefined
  const body = JSON.parse(call?.[1]?.body ?? '{}') as { max_tokens?: number }
  return body.max_tokens ?? -1
}

afterEach(() => {
  vi.unstubAllGlobals()
})

describe('completeChat reasoning-model budgets', () => {
  it('发送的 max_tokens 在调用方正文预算之上附带思考余量', async () => {
    const fetchMock = mockFetchOnce({ choices: [{ message: { content: '好的' }, finish_reason: 'stop' }] })
    vi.stubGlobal('fetch', fetchMock)

    await completeChat(settings, [{ role: 'user', content: 'hi' }], { maxTokens: 200 })

    expect(sentMaxTokens(fetchMock)).toBe(200 * 2 + 800)
  })

  it('思考余量有上限，避免超出常见模型输出窗口', async () => {
    const fetchMock = mockFetchOnce({ choices: [{ message: { content: '好的' }, finish_reason: 'stop' }] })
    vi.stubGlobal('fetch', fetchMock)

    await completeChat(settings, [{ role: 'user', content: 'hi' }], { maxTokens: 9000 })

    expect(sentMaxTokens(fetchMock)).toBe(8000)
  })

  it('思考烧尽预算（finish_reason=length 且正文为空）时抛出可诊断错误而不是返回空字符串', async () => {
    vi.stubGlobal('fetch', mockFetchOnce({ choices: [{ message: { content: '' }, finish_reason: 'length' }] }))

    await expect(completeChat(settings, [{ role: 'user', content: 'hi' }], { maxTokens: 200 }))
      .rejects.toThrow(LlmError)
  })

  it('服务端省略 finish_reason 时保持旧行为：返回空字符串', async () => {
    vi.stubGlobal('fetch', mockFetchOnce({ choices: [{ message: { content: '' } }] }))

    await expect(completeChat(settings, [{ role: 'user', content: 'hi' }])).resolves.toBe('')
  })
})
