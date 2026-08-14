import { describe, expect, it } from 'vitest'
import { settingsTestHelpers } from './settings'

describe('care ping settings contract', () => {
  it('adds quiet-hour defaults when loading a pre-Phase-2 settings shape', () => {
    const settings = settingsTestHelpers.mergeDefaults({
      carePings: { enabled: true, frequency: 'gentle', detectFullscreen: false },
    } as Parameters<typeof settingsTestHelpers.mergeDefaults>[0])

    expect(settings.carePings).toMatchObject({
      enabled: true,
      frequency: 'gentle',
      detectFullscreen: false,
      quietHours: { enabled: true, start: '22:30', end: '08:30' },
      pausedUntil: '',
    })
  })

  it('validates clock values and pause timestamps at the persistence boundary', () => {
    expect(settingsTestHelpers.validateSettingValue('carePings.quietHours.start', '23:45')).toBe('23:45')
    expect(settingsTestHelpers.validateSettingValue('carePings.pausedUntil', '2026-08-20T08:00:00.000Z')).toBe('2026-08-20T08:00:00.000Z')
    expect(() => settingsTestHelpers.validateSettingValue('carePings.quietHours.end', '25:00')).toThrow('HH:mm')
    expect(() => settingsTestHelpers.validateSettingValue('carePings.pausedUntil', '明天')).toThrow('暂停截止时间无效')
  })
})

describe('window size settings contract', () => {
  it('migrates old settings to the standard fixed-size preset', () => {
    const settings = settingsTestHelpers.mergeDefaults({
      ui: { theme: 'system', closeBehavior: 'ask' },
    } as Parameters<typeof settingsTestHelpers.mergeDefaults>[0])

    expect(settings.ui.windowSize).toBe('standard')
  })

  it('rejects free-form window dimensions at the persistence boundary', () => {
    expect(settingsTestHelpers.validateSettingValue('ui.windowSize', 'large')).toBe('large')
    expect(() => settingsTestHelpers.validateSettingValue('ui.windowSize', '1280x720')).toThrow('值无效')
  })
})
