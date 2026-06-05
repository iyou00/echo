import type { Settings } from '../../types/ipc'

export interface LlmMessage {
  role: 'system' | 'user' | 'assistant' | 'tool'
  content: string
}

export interface LlmChunk {
  content: string
}

export interface LlmRequestOptions {
  signal?: AbortSignal
  timeoutMs?: number
  temperature?: number
  maxTokens?: number
}

function maxTokensFor(options?: LlmRequestOptions): number {
  return Math.max(1, Math.floor(options?.maxTokens ?? 600))
}

export class LlmError extends Error {
  constructor(
    message: string,
    public kind: 'config' | 'network' | 'auth' | 'rate_limit' | 'server' | 'timeout' | 'canceled',
  ) {
    super(message)
  }
}

const STREAM_READ_TIMEOUT_MS = 60_000

function createRequestSignal(options?: LlmRequestOptions): { signal: AbortSignal; cleanup: () => void; parentAborted: () => boolean; timedOut: () => boolean; timeoutMs: number; resetStreamTimeout: () => void } {
  const controller = new AbortController()
  const timeoutMs = options?.timeoutMs ?? 30_000
  let timedOut = false
  const timers: ReturnType<typeof setTimeout>[] = []
  let connectTimer: ReturnType<typeof setTimeout> | undefined = setTimeout(() => {
    timedOut = true
    controller.abort(new DOMException('LLM 请求超时', 'TimeoutError'))
  }, timeoutMs)
  timers.push(connectTimer)
  let streamTimer: ReturnType<typeof setTimeout> | undefined
  function resetStreamTimeout(): void {
    // Switch from connection timeout to per-chunk timeout.
    if (connectTimer !== undefined) {
      clearTimeout(connectTimer)
      connectTimer = undefined
    }
    if (streamTimer !== undefined) clearTimeout(streamTimer)
    if (controller.signal.aborted) return
    streamTimer = setTimeout(() => {
      timedOut = true
      controller.abort(new DOMException('LLM 流式响应超时', 'TimeoutError'))
    }, STREAM_READ_TIMEOUT_MS)
  }
  const abortFromParent = () => controller.abort(options?.signal?.reason ?? new DOMException('任务已取消', 'AbortError'))
  if (options?.signal) {
    if (options.signal.aborted) abortFromParent()
    else options.signal.addEventListener('abort', abortFromParent, { once: true })
  }
  return {
    signal: controller.signal,
    timeoutMs,
    parentAborted: () => Boolean(options?.signal?.aborted),
    timedOut: () => timedOut,
    resetStreamTimeout,
    cleanup: () => {
      timers.forEach((timer) => clearTimeout(timer))
      if (streamTimer !== undefined) clearTimeout(streamTimer)
      options?.signal?.removeEventListener('abort', abortFromParent)
    },
  }
}

function normalizeFetchError(error: unknown, request: ReturnType<typeof createRequestSignal>): never {
  if (request.parentAborted()) throw new LlmError('任务已取消', 'canceled')
  if (request.timedOut() || error instanceof DOMException && error.name === 'TimeoutError') {
    throw new LlmError(`请求超时（${Math.round(request.timeoutMs / 1000)} 秒），请检查网络或换一个端点`, 'timeout')
  }
  if (error instanceof DOMException && error.name === 'AbortError') {
    throw new LlmError('任务已取消', 'canceled')
  }
  throw new LlmError(error instanceof Error ? error.message : '网络请求失败', 'network')
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

export async function* streamChat(settings: Settings, messages: LlmMessage[], options?: LlmRequestOptions): AsyncIterable<LlmChunk> {
  assertConfig(settings)
  const request = createRequestSignal(options)
  let response: Response
  try {
    response = await fetch(endpoint(settings.llm.baseUrl), {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        authorization: `Bearer ${settings.llm.apiKey}`,
      },
      body: JSON.stringify({
        model: settings.llm.model,
        messages,
        stream: true,
        temperature: options?.temperature ?? 0.8,
        max_tokens: maxTokensFor(options),
      }),
      signal: request.signal,
    })
  } catch (error) {
    request.cleanup()
    normalizeFetchError(error, request)
  }

  if (!response.ok) {
    request.cleanup()
    if (response.status === 401 || response.status === 403) throw new LlmError('鉴权失败', 'auth')
    if (response.status === 429) throw new LlmError('请求太频繁', 'rate_limit')
    throw new LlmError(`服务端返回 ${response.status}`, 'server')
  }

  const reader = response.body?.getReader()
  if (!reader) {
    request.cleanup()
    return
  }
  const decoder = new TextDecoder()
  let buffer = ''

  // Wire the abort signal to the reader so that timeout/parent-cancel
  // breaks out of a hanging reader.read() call.
  const cancelReaderOnAbort = () => { void reader.cancel().catch(() => undefined) }
  request.signal.addEventListener('abort', cancelReaderOnAbort, { once: true })

  try {
    // Initial headers received — switch from connection timeout to per-chunk timeout.
    request.resetStreamTimeout()
    while (true) {
      const readPromise = reader.read()
      const { done, value } = await readPromise
      if (done) break
      request.resetStreamTimeout()
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
  } catch (error) {
    normalizeFetchError(error, request)
  } finally {
    request.signal.removeEventListener('abort', cancelReaderOnAbort)
    request.cleanup()
  }
}

export async function completeChat(settings: Settings, messages: LlmMessage[], options?: LlmRequestOptions): Promise<string> {
  assertConfig(settings)
  const request = createRequestSignal(options)
  let response: Response
  try {
    response = await fetch(endpoint(settings.llm.baseUrl), {
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
        max_tokens: maxTokensFor(options),
      }),
      signal: request.signal,
    })
  } catch (error) {
    request.cleanup()
    normalizeFetchError(error, request)
  }

  try {
    if (!response.ok) {
      if (response.status === 401 || response.status === 403) throw new LlmError('鉴权失败', 'auth')
      if (response.status === 429) throw new LlmError('请求太频繁', 'rate_limit')
      throw new LlmError(`服务端返回 ${response.status}`, 'server')
    }

    const parsed = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> }
    return parsed.choices?.[0]?.message?.content ?? ''
  } catch (error) {
    if (error instanceof LlmError) throw error
    if (error instanceof SyntaxError) throw new LlmError('LLM 响应格式异常', 'server')
    normalizeFetchError(error, request)
  } finally {
    request.cleanup()
  }
}
