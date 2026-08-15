import { describe, expect, it } from 'vitest'
import { favoriteNote, feedbackFallbackNote, FEEDBACK_NOTE_MS } from './feedbackNote'

describe('feedback notes', () => {
  it('confirms favoriting and unfavoriting with distinct copy', () => {
    expect(favoriteNote(true)).toContain('收好')
    expect(favoriteNote(false)).toContain('拿掉')
  })

  it('keeps the fallback note short and non-committal', () => {
    expect(feedbackFallbackNote().length).toBeLessThanOrEqual(8)
  })

  it('keeps the auto-hide window in a gentle range', () => {
    expect(FEEDBACK_NOTE_MS).toBeGreaterThanOrEqual(2500)
    expect(FEEDBACK_NOTE_MS).toBeLessThanOrEqual(5000)
  })
})
