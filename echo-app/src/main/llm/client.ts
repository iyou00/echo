import type { Settings } from '../../types/ipc'

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
}

export interface LlmChunk {
  content: string
}

export class LlmError extends Error {
  constructor(
    message: string,
    public kind: 'config' | 'network' | 'auth' | 'rate_limit' | 'server',
  ) {
    super(message)
  }
}

function endpoint(baseUrl: string): string {
  const trimmed = baseUrl.replace(/\/+$/, '')
  return trimmed.endsWith('/chat/completions') ? trimmed : `${trimmed}/chat/completions`
}

function assertConfig(settings: Settings): void {
  if (!settings.llm.baseUrl || !settings.llm.apiKey || !settings.llm.model) {
    throw new LlmError('LLM 配置还没填完整', 'config')
  }
}

export async function* streamChat(settings: Settings, messages: LlmMessage[]): AsyncIterable<LlmChunk> {
  assertConfig(settings)
  const response = await fetch(endpoint(settings.llm.baseUrl), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${settings.llm.apiKey}`,
    },
    body: JSON.stringify({
      model: settings.llm.model,
      messages,
      stream: true,
      temperature: 0.8,
    }),
  }).catch((error) => {
    throw new LlmError(error instanceof Error ? error.message : '网络请求失败', 'network')
  })

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new LlmError('鉴权失败', 'auth')
    if (response.status === 429) throw new LlmError('请求太频繁', 'rate_limit')
    throw new LlmError(`服务端返回 ${response.status}`, 'server')
  }

  const reader = response.body?.getReader()
  if (!reader) return
  const decoder = new TextDecoder()
  let buffer = ''

  while (true) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })
    const lines = buffer.split(/\r?\n/)
    buffer = lines.pop() ?? ''

    for (const line of lines) {
      const trimmed = line.trim()
      if (!trimmed.startsWith('data:')) continue
      const data = trimmed.slice(5).trim()
      if (data === '[DONE]') return
      try {
        const parsed = JSON.parse(data) as { choices?: Array<{ delta?: { content?: string } }> }
        const content = parsed.choices?.[0]?.delta?.content
        if (content) yield { content }
      } catch {
        continue
      }
    }
  }
}

export async function completeChat(settings: Settings, messages: LlmMessage[], options?: { temperature?: number }): Promise<string> {
  assertConfig(settings)
  const response = await fetch(endpoint(settings.llm.baseUrl), {
    method: 'POST',
    headers: {
      'content-type': 'application/json',
      authorization: `Bearer ${settings.llm.apiKey}`,
    },
    body: JSON.stringify({
      model: settings.llm.model,
      messages,
      stream: false,
      temperature: options?.temperature ?? 0.8,
    }),
  }).catch((error) => {
    throw new LlmError(error instanceof Error ? error.message : '网络请求失败', 'network')
  })

  if (!response.ok) {
    if (response.status === 401 || response.status === 403) throw new LlmError('鉴权失败', 'auth')
    if (response.status === 429) throw new LlmError('请求太频繁', 'rate_limit')
    throw new LlmError(`服务端返回 ${response.status}`, 'server')
  }

  const parsed = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> }
  return parsed.choices?.[0]?.message?.content ?? ''
}
