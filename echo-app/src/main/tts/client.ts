import { getSettings } from '../db/settings'
import { upsertHealth } from '../db/health'

export interface SynthesizeResult {
  ok: boolean
  audioUrl?: string
  error?: { kind: string; message: string }
}

function humanize(error: unknown): string {
  if (error instanceof Error) return error.message
  return '语音服务暂时不可用'
}

export async function synthesize(text: string): Promise<SynthesizeResult> {
  const settings = getSettings()
  const { baseUrl, voice, speed, pitch } = settings.tts
  const input = text.trim().slice(0, 240)
  if (!input) return { ok: false, error: { kind: 'EMPTY_INPUT', message: '没有可朗读的文字' } }

  try {
    const response = await fetch(`${baseUrl.replace(/\/$/, '')}/v1/audio/speech`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ input, voice, speed, pitch }),
      signal: AbortSignal.timeout(30000),
    })

    if (!response.ok) {
      const message = `TTS 返回 ${response.status}`
      upsertHealth('tts', 'degraded', 'Echo 现在说不出声音，文字会保留。', message)
      return { ok: false, error: { kind: 'HTTP_ERROR', message } }
    }

    const bytes = Buffer.from(await response.arrayBuffer())
    if (bytes.length === 0) {
      upsertHealth('tts', 'degraded', 'Echo 现在说不出声音，文字会保留。', 'TTS 没有返回音频')
      return { ok: false, error: { kind: 'EMPTY_AUDIO', message: 'TTS 没有返回音频' } }
    }

    const mime = response.headers.get('content-type')?.split(';')[0] || 'audio/mpeg'
    upsertHealth('tts', 'ok', '语音服务正常。')
    return { ok: true, audioUrl: `data:${mime};base64,${bytes.toString('base64')}` }
  } catch (error) {
    const message = humanize(error)
    upsertHealth('tts', 'degraded', 'Echo 现在说不出声音，文字会保留。', message)
    return { ok: false, error: { kind: 'NETWORK_ERROR', message } }
  }
}

export async function testTts(): Promise<{ ok: boolean; latencyMs?: number; message: string }> {
  const started = Date.now()
  const result = await synthesize('Echo 试音')
  const latencyMs = Date.now() - started
  if (result.ok) {
    return { ok: true, latencyMs, message: `语音服务正常 · ${latencyMs} ms` }
  }
  return { ok: false, message: result.error?.message ?? '语音服务测试失败' }
}
