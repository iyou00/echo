import type { PlaybackState } from '../types/ipc'
import { stableChoice, stableDaySeed } from '../shared/deterministic'

const FIVE_DAYS = 5 * 86400000
const VOICE_LAST_SEEN_KEY = 'echo:voiceLastSeenAt'

export const VOICE_IDLE_GREETINGS = {
  morning: ['早,你今天想听什么?', '上午这会儿,来点音乐?', '睡醒了吗,该听歌了。'],
  noon: ['中午了,我有点话想说。', '这个点你该歇歇,要不让我陪你?', '正午了 — 赏曲?'],
  afternoon: ['下午有点犯困——我陪你说会话?', '这会儿状态可能不太好,听听我的声音吗?', '要是午休了,正好有几首歌不错'],
  evening: ['下班了吗?这会儿安静了。', '傍晚了 — 给一天收个尾。', '今天快过去了,时间真快'],
  night: ['晚上好——我有话想说。', '工作差不多了吧,我陪你说说?', '这会儿挺安静的,真好啊'],
  late_night: ['你还在啊。', '这个点都还不睡,莫非要听听歌吗', '深夜了,我陪你。'],
  rain: ['雨一直下,气氛不算融洽', '下雨天,慢慢听一段'],
  weekend_morning: ['周末早晨,慢慢来', '今天不用赶,慢慢听歌慢慢忙'],
  weekend_night: ['周末晚上要放松下', '没事的话,随便听听'],
  long_absence: ['好久没见 — 我太想你了。', '你回来了 — 我有点话想跟你说。', '一阵子没见,先听我说几句?'],
  music_playing: ['这首挺好 — 接着说点什么?', '听完这首,再来一首?'],
  fallback: ['让我陪你听一会儿?'],
} as const

type VoiceGreetingKey = keyof typeof VOICE_IDLE_GREETINGS

export interface VoiceIdleGreetingInput {
  weather?: { condition?: string; tempC?: number } | null
  playbackState?: Pick<PlaybackState, 'current' | 'status'> | null
  longAbsent?: boolean
  now?: Date
}

function pick(items: readonly string[], seed: string) {
  return stableChoice(items, seed, VOICE_IDLE_GREETINGS.fallback[0])
}

function periodKey(date = new Date()): VoiceGreetingKey {
  const hour = date.getHours()
  if (hour < 6) return 'late_night'
  if (hour < 11) return 'morning'
  if (hour < 14) return 'noon'
  if (hour < 17) return 'afternoon'
  if (hour < 19) return 'evening'
  return 'night'
}

function isWeekend(date = new Date()) {
  const day = date.getDay()
  return day === 0 || day === 6
}

export function getVoiceLongAbsence(now = Date.now()) {
  const lastSeen = Number(window.localStorage.getItem(VOICE_LAST_SEEN_KEY) ?? 0)
  return lastSeen > 0 && now - lastSeen > FIVE_DAYS
}

export function markVoiceSeen(now = Date.now()) {
  window.localStorage.setItem(VOICE_LAST_SEEN_KEY, String(now))
}

export function pickVoiceIdleGreeting(input: VoiceIdleGreetingInput = {}) {
  const now = input.now ?? new Date()
  const seed = `${stableDaySeed(now)}:${now.getHours()}`
  if (input.longAbsent) return pick(VOICE_IDLE_GREETINGS.long_absence, `${seed}:long_absence`)

  const hasCurrentTrack = Boolean(input.playbackState?.current)
  const playbackStatus = input.playbackState?.status
  if (hasCurrentTrack && (playbackStatus === 'playing' || playbackStatus === 'paused')) {
    return pick(VOICE_IDLE_GREETINGS.music_playing, `${seed}:music_playing:${input.playbackState?.current?.title ?? ''}`)
  }

  const condition = input.weather?.condition ?? ''
  if (condition.includes('雨')) return pick(VOICE_IDLE_GREETINGS.rain, `${seed}:rain`)

  if (isWeekend(now) && now.getHours() < 12) return pick(VOICE_IDLE_GREETINGS.weekend_morning, `${seed}:weekend_morning`)
  if (isWeekend(now) && now.getHours() >= 19) return pick(VOICE_IDLE_GREETINGS.weekend_night, `${seed}:weekend_night`)
  const period = periodKey(now)
  return pick(VOICE_IDLE_GREETINGS[period], `${seed}:${period}`)
}
