import { describe, expect, it } from 'vitest'
import { remainingStartupDelay } from './startupPresentation'

describe('startup presentation timing', () => {
  it('keeps a fast startup visible long enough to read', () => {
    expect(remainingStartupDelay(100, 350)).toBe(650)
  })

  it('does not delay a startup that already took long enough', () => {
    expect(remainingStartupDelay(100, 1400)).toBe(0)
  })
})
