export const DAILY_RECONNECT_MS = 1500
export const DAILY_RECONNECT_FADE_MS = 360

export function dailyReconnectDuration(reducedMotion: boolean): number {
  return reducedMotion ? 0 : DAILY_RECONNECT_MS
}
