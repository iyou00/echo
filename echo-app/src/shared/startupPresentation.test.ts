import { describe, expect, it } from 'vitest'
import { remainingStartupDelay, STARTUP_MIN_VISIBLE_MS } from './startupPresentation'

describe('startup presentation timing', () => {
  it('keeps a fast startup visible long enough for the reconnect beat', () => {
    expect(remainingStartupDelay(100, 350)).toBe(STARTUP_MIN_VISIBLE_MS - 250)
  })

  it('does not delay a startup that already took long enough', () => {
    expect(remainingStartupDelay(100, 1700)).toBe(0)
  })

  it('matches the daily reconnect animation window', () => {
    expect(STARTUP_MIN_VISIBLE_MS).toBeGreaterThanOrEqual(1500)
  })
})
