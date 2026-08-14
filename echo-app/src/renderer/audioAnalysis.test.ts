import { describe, expect, it } from 'vitest'
import { energyFromLevels, levelsFromFrequencyData } from './audioAnalysis'

describe('audio analysis', () => {
  it('condenses frequency bins into normalized display levels', () => {
    expect(levelsFromFrequencyData(new Uint8Array([0, 64, 128, 255]), 2)).toEqual([
      32 / 255,
      191.5 / 255,
    ])
  })

  it('returns silence for missing data and bounds aggregate energy', () => {
    expect(levelsFromFrequencyData(new Uint8Array(), 3)).toEqual([0, 0, 0])
    expect(energyFromLevels([0.25, 0.75])).toBe(0.5)
  })
})
