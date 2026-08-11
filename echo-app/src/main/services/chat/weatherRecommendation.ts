import type { WeatherInfo } from '../../weather/client'
import type { IntentOverride } from '../recommendation/intent'
import type { ChatIntent } from '../../skills/intent/chat'

export interface RecommendationWeatherContext {
  requested: true
  city: string
  available: boolean
  condition?: string
  summary?: string
  tempC?: number
  humidity?: number
  unavailableReason?: 'city_missing' | 'service_unavailable'
}

interface WeatherRecommendationCues {
  moods: string[]
  scenes: string[]
  energy?: 'low' | 'medium' | 'high'
  tempo?: 'slow' | 'medium' | 'fast'
}

const WEATHER_CUE_PATTERN = /天气|气温|温度|下雨|降雨|雨天|下雪|雪天|晴天|阴天|多云|冷不冷|热不热|冷吗|热吗|几度|多少度/i
const WEATHER_FIT_PATTERN = /适合|合适|贴合|配|根据|按照|按|结合|对应|应景|这个天气|这种天气|今天天气|当前天气|外面天气/i

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)))
}

export function isWeatherAwareMusicRequest(text: string, intent: ChatIntent): boolean {
  return intent.wantsMusic
    && WEATHER_CUE_PATTERN.test(text)
    && (WEATHER_FIT_PATTERN.test(text) || /天气.*歌|雨天.*歌|下雨.*听|雪天.*歌|晴天.*歌/.test(text))
}

export function unavailableWeatherContext(city: string): RecommendationWeatherContext {
  return {
    requested: true,
    city,
    available: false,
    unavailableReason: city ? 'service_unavailable' : 'city_missing',
  }
}
export function availableWeatherContext(city: string, weather: WeatherInfo): RecommendationWeatherContext {
  return {
    requested: true,
    city,
    available: true,
    condition: weather.condition,
    summary: weather.summary,
    tempC: weather.tempC,
    humidity: weather.humidity,
  }
}

export function weatherRecommendationCues(context: RecommendationWeatherContext): WeatherRecommendationCues {
  if (!context.available) return { moods: [], scenes: [] }
  const condition = context.condition ?? ''
  const tempC = context.tempC
  if (/雷|暴雨|大雨|thunder|storm|heavy rain/i.test(condition)) {
    return { moods: ['陪伴', '治愈'], scenes: ['雨天', '独处'], energy: 'low', tempo: 'slow' }
  }
  if (/雨|drizzle|shower/i.test(condition)) {
    return { moods: ['治愈', '陪伴'], scenes: ['雨天'], energy: 'low', tempo: 'slow' }
  }
  if (/雪|snow/i.test(condition)) {
    return { moods: ['治愈', '陪伴'], scenes: ['独处'], energy: 'low', tempo: 'slow' }
  }
  if (/雾|霾|阴|多云|fog|mist|overcast|cloud/i.test(condition)) {
    return { moods: ['放松', '治愈'], scenes: ['独处'], energy: 'low', tempo: 'slow' }
  }
  if (/晴|sun|clear/i.test(condition)) {
    return { moods: ['轻快'], scenes: [], energy: 'medium', tempo: 'medium' }
  }
  if (typeof tempC === 'number' && tempC <= 8) {
    return { moods: ['治愈', '陪伴'], scenes: ['独处'], energy: 'low', tempo: 'slow' }
  }
  if (typeof tempC === 'number' && tempC >= 30) {
    return { moods: ['放松', '松弛'], scenes: [], energy: 'medium', tempo: 'medium' }
  }
  return { moods: ['陪伴'], scenes: [], energy: 'medium', tempo: 'medium' }
}

export function applyWeatherToChatIntent(intent: ChatIntent, context: RecommendationWeatherContext): ChatIntent {
  const cues = weatherRecommendationCues(context)
  if (!context.available || (cues.moods.length === 0 && cues.scenes.length === 0)) return intent
  const currentOverride = intent.llmIntentOverride ?? {}
  const weatherEvidence = context.summary ? [`天气:${context.summary}`] : []
  const override: IntentOverride = {
    ...currentOverride,
    moods: unique([...(currentOverride.moods ?? []), ...cues.moods]),
    scenes: unique([...(currentOverride.scenes ?? []), ...cues.scenes]),
    energy: currentOverride.energy ?? cues.energy,
    tempo: currentOverride.tempo ?? cues.tempo,
    evidence: unique([...(currentOverride.evidence ?? []), ...weatherEvidence]).slice(0, 8),
  }
  return {
    ...intent,
    llmIntentOverride: override,
    recommendationIntent: {
      ...intent.recommendationIntent,
      moods: unique([...intent.recommendationIntent.moods, ...cues.moods]),
      scenes: unique([...intent.recommendationIntent.scenes, ...cues.scenes]),
      energy: intent.recommendationIntent.energy ?? cues.energy,
      tempo: intent.recommendationIntent.tempo ?? cues.tempo,
      evidence: unique([...(intent.recommendationIntent.evidence ?? []), ...weatherEvidence]).slice(0, 8),
      source: 'hybrid',
    },
    moodTerms: unique([...intent.moodTerms, ...cues.moods, ...cues.scenes]).slice(0, 8),
  }
}
