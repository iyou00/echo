import { stableChoice, stableDaySeed } from '../shared/deterministic'

export const HEADER_GREETINGS = {
  morning: ['上午好', '早,精神点了吗', '上午这个点 · 慢慢启动'],
  noon: ['中午了 · 吃饭吗', '中午好 · 我陪你', '正午 · 这会儿适合慢一点'],
  afternoon: ['下午有点犯困,放点慢的?', '下午这个点 · 节奏松一些', '下午 · 你休息一下'],
  evening: ['下班了吗 · 这会儿挺安静', '傍晚 · 给一天收个尾', '今天快过去了'],
  night: ['晚上好 · 工作终于结束了吧', '晚上 · 慢慢来', '夜里 · 我陪你'],
  late_night: ['凌晨了 · 我陪你', '深夜 · 你还在', '这个点该睡了 · 但我在'],
  rain: ['雨在外面 · 你在里面', '雨天 · 慢一点'],
  snow: ['下雪了 · 安静点听'],
  hot: ['今天热 · 来点凉的'],
  cold: ['今天冷 · 多穿一点'],
  long_absence: ['好久没见 · 你回来就好', '一阵子没见 · 都好吗'],
  fallback: ['给今天找一个入口'],
} as const

type GreetingKey = keyof typeof HEADER_GREETINGS

function pick(items: readonly string[], seed: string) {
  return stableChoice(items, seed, HEADER_GREETINGS.fallback[0])
}

function periodKey(date = new Date()): GreetingKey {
  const hour = date.getHours()
  if (hour < 6) return 'late_night'
  if (hour < 11) return 'morning'
  if (hour < 14) return 'noon'
  if (hour < 17) return 'afternoon'
  if (hour < 19) return 'evening'
  return 'night'
}

export function pickHeaderGreeting(weather?: { condition?: string; tempC?: number } | null) {
  const now = new Date()
  const lastUsed = Number(window.localStorage.getItem('echo:lastUsedAt') ?? 0)
  const current = Date.now()
  const seed = `${stableDaySeed(now)}:${now.getHours()}`
  window.localStorage.setItem('echo:lastUsedAt', String(current))
  if (lastUsed > 0 && current - lastUsed > 5 * 86400000) return pick(HEADER_GREETINGS.long_absence, `${seed}:long_absence`)

  const condition = weather?.condition ?? ''
  if (condition.includes('雨')) return pick(HEADER_GREETINGS.rain, `${seed}:rain`)
  if (condition.includes('雪')) return pick(HEADER_GREETINGS.snow, `${seed}:snow`)
  if (typeof weather?.tempC === 'number' && weather.tempC > 32) return pick(HEADER_GREETINGS.hot, `${seed}:hot`)
  if (typeof weather?.tempC === 'number' && weather.tempC < 0) return pick(HEADER_GREETINGS.cold, `${seed}:cold`)

  const period = periodKey(now)
  return pick(HEADER_GREETINGS[period], `${seed}:${period}`)
}

export function formatHeaderTime(date = new Date()) {
  const h = date.getHours().toString().padStart(2, '0')
  const m = date.getMinutes().toString().padStart(2, '0')
  return `${h}:${m}`
}
