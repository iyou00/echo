export const STARTUP_MIN_VISIBLE_MS = 900

export function remainingStartupDelay(startedAt: number, now: number, minimumMs = STARTUP_MIN_VISIBLE_MS): number {
  return Math.max(0, minimumMs - Math.max(0, now - startedAt))
}
