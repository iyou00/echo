import { describe, expect, it } from 'vitest'
import { welcomeExitDelay } from './firstRunWelcomePolicy'

describe('first run welcome policy', () => {
  it('keeps the normal exit long enough for the audio fade', () => {
    expect(welcomeExitDelay(false)).toBe(800)
  })

  it('shortens the transition for reduced motion without skipping onboarding', () => {
    expect(welcomeExitDelay(true)).toBe(150)
  })
})
