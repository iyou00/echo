import { describe, expect, it } from 'vitest'
import {
  DEFAULT_WINDOW_SIZE_PRESET,
  isWindowSizePreset,
  normalizeWindowSizePreset,
  windowSizeForPreset,
} from './windowSize'

describe('window size presets', () => {
  it('keeps every supported window at the approved 16:10 ratio', () => {
    expect(windowSizeForPreset('compact')).toEqual({ width: 1152, height: 720 })
    expect(windowSizeForPreset('standard')).toEqual({ width: 1280, height: 800 })
    expect(windowSizeForPreset('large')).toEqual({ width: 1440, height: 900 })
  })

  it('falls back to the stable default for old or invalid settings', () => {
    expect(normalizeWindowSizePreset(undefined)).toBe(DEFAULT_WINDOW_SIZE_PRESET)
    expect(normalizeWindowSizePreset('freeform')).toBe(DEFAULT_WINDOW_SIZE_PRESET)
  })

  it('accepts only the controlled preset names', () => {
    expect(isWindowSizePreset('compact')).toBe(true)
    expect(isWindowSizePreset('standard')).toBe(true)
    expect(isWindowSizePreset('large')).toBe(true)
    expect(isWindowSizePreset('1280x800')).toBe(false)
  })
})
