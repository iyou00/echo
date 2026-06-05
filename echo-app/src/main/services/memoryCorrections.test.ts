import { describe, expect, it } from 'vitest'
import { isBareTrackLabelCorrection, isTrustedCorrectionEvent } from './memoryCorrections'

describe('memory correction trust filter', () => {
  it('filters bare track labels created by mistaken taste-question capture', () => {
    expect(isBareTrackLabelCorrection('晓月老板 / Q.MARK邱马克 / 老徐 / 文人墨客')).toBe(true)
    expect(isTrustedCorrectionEvent({ kind: 'correction', content: '晓月老板 / Q.MARK邱马克 / 老徐 / 文人墨客' })).toBe(false)
  })

  it('keeps corrections with explicit user meaning', () => {
    expect(isBareTrackLabelCorrection('陈奕迅 / 冷夜: 这首不好听，换激情一点的')).toBe(false)
    expect(isTrustedCorrectionEvent({ kind: 'correction', content: '我不喜欢电子音墙，少推一点' })).toBe(true)
  })
})
