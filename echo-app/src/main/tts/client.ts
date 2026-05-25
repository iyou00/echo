import { getSettings } from '../db/settings'
import { upsertHealth } from '../db/health'

export interface SynthesizeResult {
  ok: boolean
  audioUrl?: string
  error?: { kind: string; message: string }
}

export interface TtsRequestOptions {
  signal?: AbortSignal
  timeoutMs?: number
}

function humanize(error: unknown): string {
  if (error instanceof Error) return error.message
  return '语音服务暂时不可用'
}

function createRequestSignal(options: TtsRequestOptions = {}): { signal: AbortSignal; cleanup: () => void; timedOut: () => boolean } {
  const controller = new AbortController()
  const timeoutMs = options.timeoutMs ?? 30_000
  let timedOut = false
  const timer = setTimeout(() => {
    timedOut = true
    controller.abort(new DOMException('TTS 请求超时', 'TimeoutError'))
  }, timeoutMs)
  const abortFromParent = () => controller.abort(options.signal?.reason)
  if (options.signal) {
    if (options.signal.aborted) controller.abort(options.signal.reason)
    else options.signal.addEventListener('abort', abortFromParent, { once: true })
  }
  return {
    signal: controller.signal,
    cleanup: () => {
      clearTimeout(timer)
      options.signal?.removeEventListener('abort', abortFromParent)
    },
    timedOut: () => timedOut,
  }
}

function assertTtsActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('任务已取消', 'AbortError')
}

export async function synthesize(text: string, options: TtsRequestOptions = {}): Promise<SynthesizeResult> {
  assertTtsActive(options.signal)
  const settings = getSettings()
  const { baseUrl, voice, speed, pitch } = settings.tts
  const input = text.trim().slice(0, 240)
  if (!input) return { ok: false, error: { kind: 'EMPTY_INPUT', message: '没有可朗读的文字' } }
  const request = createRequestSignal(options)

  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/v1/audio/speech`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input, voice, speed, pitch }),
      signal: request.signal,
    })
    assertTtsActive(options.signal)

    if (!response.ok) {
      const message = `TTS 返回 ${response.status}`
      upsertHealth('tts', 'degraded', 'Echo 现在说不出声音，文字会保留。', message)
      return { ok: false, error: { kind: 'HTTP_ERROR', message } }
    }

    const bytes = Buffer.from(await response.arrayBuffer())
    assertTtsActive(options.signal)
    if (bytes.length === 0) {
      upsertHealth('tts', 'degraded', 'Echo 现在说不出声音，文字会保留。', 'TTS 没有返回音频')
      return { ok: false, error: { kind: 'EMPTY_AUDIO', message: 'TTS 没有返回音频' } }
    }

    const mime = response.headers.get('content-type')?.split(';')[0] || 'audio/mpeg'
    upsertHealth('tts', 'ok', '语音服务正常。')
    return { ok: true, audioUrl: `data:${mime};base64,${bytes.toString('base64')}` }
  } catch (error) {
    assertTtsActive(options.signal)
    if (request.timedOut() || error instanceof DOMException && error.name === 'TimeoutError') {
      const message = 'TTS 请求超时'
      upsertHealth('tts', 'degraded', 'Echo 现在说不出声音，文字会保留。', message)
      return { ok: false, error: { kind: 'TIMEOUT_ERROR', message } }
    }
    const message = humanize(error)
    upsertHealth('tts', 'degraded', 'Echo 现在说不出声音，文字会保留。', message)
    return { ok: false, error: { kind: 'NETWORK_ERROR', message } }
  } finally {
    request.cleanup()
  }
}

export async function testTts(options: TtsRequestOptions = {}): Promise<{ ok: boolean; latencyMs?: number; message: string }> {
  const started = Date.now()
  const result = await synthesize('Echo 试音', options)
  const latencyMs = Date.now() - started
  if (result.ok) {
    return { ok: true, latencyMs, message: `语音服务正常 · ${latencyMs} ms` }
  }
  return { ok: false, message: result.error?.message ?? '语音服务测试失败' }
}
