import { describe, expect, it } from 'vitest'
import { isQuickAskShortcut, shouldOpenQuickAsk } from './quickAskGuard'

describe('quick ask guard', () => {
  it('recognizes ctrl/cmd+k regardless of case', () => {
    expect(isQuickAskShortcut({ ctrlKey: true, metaKey: false, key: 'k' })).toBe(true)
    expect(isQuickAskShortcut({ ctrlKey: false, metaKey: true, key: 'K' })).toBe(true)
    expect(isQuickAskShortcut({ ctrlKey: true, metaKey: false, key: 'j' })).toBe(false)
    expect(isQuickAskShortcut({ ctrlKey: false, metaKey: false, key: 'k' })).toBe(false)
  })

  it('requires a configured model and no blocking dialog', () => {
    const base = { hasLlmConfig: true, firstRunOpen: false, onboardingOpen: false, closeDialogOpen: false }
    expect(shouldOpenQuickAsk(base)).toBe(true)
    expect(shouldOpenQuickAsk({ ...base, hasLlmConfig: false })).toBe(false)
    expect(shouldOpenQuickAsk({ ...base, firstRunOpen: true })).toBe(false)
    expect(shouldOpenQuickAsk({ ...base, onboardingOpen: true })).toBe(false)
    expect(shouldOpenQuickAsk({ ...base, closeDialogOpen: true })).toBe(false)
  })
})
