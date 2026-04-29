import type { ServiceHealth, ServiceHealthKind, ServiceHealthStatus } from '../../types/ipc'
import { getSettings } from '../db/settings'
import { listHealth, upsertHealth } from '../db/health'
import { completeChat, LlmError } from '../llm/client'
import { getNeteaseLoginState } from '../netease/auth'
import { synthesize } from '../tts/client'
import { getWeather } from '../weather/client'
import { checkSecureStorage } from '../utils/secureStorage'

export { listHealth as getServiceHealth }

export function recordHealth(
  service: ServiceHealthKind,
  status: ServiceHealthStatus,
  message: string,
  technical = '',
): ServiceHealth {
  return upsertHealth(service, status, message, technical)
}

function technicalMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return typeof error === 'string' ? error : ''
}

async function checkLlm(): Promise<void> {
  const settings = getSettings()
  if (!settings.llm.baseUrl || !settings.llm.apiKey || !settings.llm.model) {
    recordHealth('llm', 'degraded', 'Echo 还没连上模型。去设置里填好 API key。')
    return
  }
  try {
    await completeChat(settings, [
      { role: 'system', content: '只回答 ok。' },
      { role: 'user', content: 'hi' },
    ], { temperature: 0 })
    recordHealth('llm', 'ok', '模型连接正常。')
  } catch (error) {
    const auth = error instanceof LlmError && (error.kind === 'auth' || error.kind === 'config')
    recordHealth('llm', auth ? 'error' : 'degraded', 'Echo 连不上模型。去设置里检查 API key。', technicalMessage(error))
  }
}

async function checkNetease(): Promise<void> {
  try {
    const state = await getNeteaseLoginState()
    recordHealth(
      'netease',
      state.loggedIn ? 'ok' : 'degraded',
      state.loggedIn ? `网易云已登录：${state.nickname ?? '网易云用户'}` : '网易云登录可能过期了。重新扫码后我再拿播放链接。',
    )
  } catch (error) {
    recordHealth('netease', 'error', '网易云状态检查失败。', technicalMessage(error))
  }
}

async function checkTts(): Promise<void> {
  const result = await synthesize('Echo')
  if (result.ok) {
    recordHealth('tts', 'ok', '语音服务正常。')
    return
  }
  recordHealth('tts', 'degraded', 'Echo 现在说不出声音，文字会保留。', result.error?.message ?? '')
}

async function checkWeather(): Promise<void> {
  const settings = getSettings()
  if (!settings.user.city.trim()) {
    recordHealth('weather', 'degraded', '还没设置城市。我会跳过天气开场。')
    return
  }
  const weather = await getWeather(settings.user.city)
  recordHealth(
    'weather',
    weather ? 'ok' : 'degraded',
    weather ? `天气可用：${weather.summary}` : '天气暂时拿不到，我会跳过天气开场。',
  )
}

export async function checkServiceHealth(): Promise<ServiceHealth[]> {
  await Promise.all([
    checkLlm(),
    checkNetease(),
    checkTts(),
    checkWeather(),
    Promise.resolve(recordHealth('scheduler', 'ok', '定时任务已恢复。')),
    Promise.resolve(checkSecureStorage()),
  ])
  return listHealth()
}
