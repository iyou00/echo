import { describe, expect, it } from 'vitest'
import { shouldShowYinyiArrival, yinyiArrivalDuration, YINYI_ARRIVAL_MS } from './yinyiArrival'

describe('yinyi arrival ritual', () => {
  it('triggers only on the yinyi page for an unseen letter', () => {
    expect(shouldShowYinyiArrival({ page: 'yinyi', unread: true, latestDate: '2026-08-15', alreadyShownFor: '' })).toBe(true)
    expect(shouldShowYinyiArrival({ page: 'chat', unread: true, latestDate: '2026-08-15', alreadyShownFor: '' })).toBe(false)
    expect(shouldShowYinyiArrival({ page: 'yinyi', unread: false, latestDate: '2026-08-15', alreadyShownFor: '' })).toBe(false)
  })

  it('plays at most once per letter per session', () => {
    expect(shouldShowYinyiArrival({ page: 'yinyi', unread: true, latestDate: '2026-08-15', alreadyShownFor: '2026-08-15' })).toBe(false)
    expect(shouldShowYinyiArrival({ page: 'yinyi', unread: true, latestDate: '2026-08-16', alreadyShownFor: '2026-08-15' })).toBe(true)
  })

  it('requires a letter to exist', () => {
    expect(shouldShowYinyiArrival({ page: 'yinyi', unread: true, latestDate: '', alreadyShownFor: '' })).toBe(false)
  })

  it('keeps the ritual brief and skips it under reduced motion', () => {
    expect(YINYI_ARRIVAL_MS).toBeLessThanOrEqual(2500)
    expect(yinyiArrivalDuration(true)).toBe(0)
    expect(yinyiArrivalDuration(false)).toBe(YINYI_ARRIVAL_MS)
  })
})
