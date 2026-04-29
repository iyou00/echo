import { upsertHealth } from '../db/health'

export interface WeatherInfo {
  city: string
  condition: string
  tempC: number
  humidity: number
  summary: string
}

const cache = new Map<string, { expiresAt: number; value: WeatherInfo | null }>()

function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {}
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

export async function getWeather(city: string): Promise<WeatherInfo | null> {
  const normalized = city.trim()
  if (!normalized) return null
  const cached = cache.get(normalized.toLowerCase())
  if (cached && cached.expiresAt > Date.now()) return cached.value

  try {
    const response = await fetch(`https://wttr.in/${encodeURIComponent(normalized)}?format=j1&lang=zh`, {
      signal: AbortSignal.timeout(5000),
    })
    if (!response.ok) {
      upsertHealth('weather', 'degraded', '天气暂时拿不到，我会跳过天气开场。', `HTTP ${response.status}`)
      return null
    }
    const data = asObject(await response.json())
    const current = asObject(asArray(data.current_condition)[0])
    const zh = asObject(asArray(current.lang_zh)[0])
    const desc = asObject(asArray(current.weatherDesc)[0])
    const condition = String(zh.value ?? desc.value ?? '')
    const tempC = Number.parseInt(String(current.temp_C ?? '0'), 10)
    const humidity = Number.parseInt(String(current.humidity ?? '0'), 10)
    const value: WeatherInfo = {
      city: normalized,
      condition,
      tempC,
      humidity,
      summary: condition ? `${condition} · ${tempC}°C` : `${tempC}°C`,
    }
    cache.set(normalized.toLowerCase(), { expiresAt: Date.now() + 30 * 60 * 1000, value })
    upsertHealth('weather', 'ok', `天气可用：${value.summary}`)
    return value
  } catch (error) {
    cache.set(normalized.toLowerCase(), { expiresAt: Date.now() + 5 * 60 * 1000, value: null })
    upsertHealth('weather', 'degraded', '天气暂时拿不到，我会跳过天气开场。', error instanceof Error ? error.message : '')
    return null
  }
}
