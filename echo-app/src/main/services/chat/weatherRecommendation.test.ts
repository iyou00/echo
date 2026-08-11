import { describe, expect, it } from 'vitest'
import { classifyFallbackChatIntent } from './intent'
import {
  applyWeatherToChatIntent,
  availableWeatherContext,
  isWeatherAwareMusicRequest,
  unavailableWeatherContext,
} from './weatherRecommendation'

describe('weather-aware music requests', () => {
  it('recognizes a combined weather and language request', () => {
    const text = '找一首适合今天天气的歌，韩国歌曲'
    const intent = classifyFallbackChatIntent(text)

    expect(intent.wantsMusic).toBe(true)
    expect(intent.recommendationIntent.language).toBe('韩语')
    expect(isWeatherAwareMusicRequest(text, intent)).toBe(true)
  })

  it('turns real rainy weather into recommendation evidence without losing language', () => {
    const text = '找一首适合今天天气的歌，韩国歌曲'
    const intent = classifyFallbackChatIntent(text)
    const context = availableWeatherContext('长沙', {
      city: '长沙',
      condition: '小雨',
      summary: '小雨 · 23°C',
      tempC: 23,
      humidity: 86,
    })

    const enriched = applyWeatherToChatIntent(intent, context)

    expect(enriched.recommendationIntent.language).toBe('韩语')
    expect(enriched.recommendationIntent.scenes).toContain('雨天')
    expect(enriched.recommendationIntent.moods).toContain('治愈')
    expect(enriched.llmIntentOverride?.evidence).toContain('天气:小雨 · 23°C')
  })

  it('recognizes the English weather description returned by the live provider', () => {
    const text = '按今天天气推荐一首泰语歌'
    const intent = classifyFallbackChatIntent(text)
    const context = availableWeatherContext('长沙', {
      city: '长沙',
      condition: 'Light drizzle',
      summary: 'Light drizzle · 31°C',
      tempC: 31,
      humidity: 72,
    })

    const enriched = applyWeatherToChatIntent(intent, context)

    expect(enriched.recommendationIntent.scenes).toContain('雨天')
    expect(enriched.recommendationIntent.language).toBe('泰语')
  })

  it('preserves an explicit energy request over the weather default', () => {
    const text = '雷雨天给我找一首激昂的日语歌'
    const intent = classifyFallbackChatIntent(text)
    const context = availableWeatherContext('长沙', {
      city: '长沙',
      condition: '雷阵雨',
      summary: '雷阵雨 · 27°C',
      tempC: 27,
      humidity: 90,
    })

    const enriched = applyWeatherToChatIntent(intent, context)

    expect(enriched.recommendationIntent.energy).toBe('high')
    expect(enriched.recommendationIntent.tempo).toBe('fast')
  })

  it('keeps the original intent when weather is unavailable', () => {
    const text = '找一首适合今天天气的法语歌'
    const intent = classifyFallbackChatIntent(text)

    expect(applyWeatherToChatIntent(intent, unavailableWeatherContext('长沙'))).toBe(intent)
  })
})
