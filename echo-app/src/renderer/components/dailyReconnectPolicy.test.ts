import { describe, expect, it } from 'vitest'
import { dailyReconnectDuration, DAILY_RECONNECT_MS } from './dailyReconnectPolicy'

describe('daily reconnect policy', () => {
  it('keeps the reconnect beat short', () => {
    expect(DAILY_RECONNECT_MS).toBeLessThanOrEqual(2000)
    expect(DAILY_RECONNECT_MS).toBeGreaterThanOrEqual(1000)
  })

  it('skips the animation entirely under reduced motion', () => {
    expect(dailyReconnectDuration(true)).toBe(0)
    expect(dailyReconnectDuration(false)).toBe(DAILY_RECONNECT_MS)
  })
})
