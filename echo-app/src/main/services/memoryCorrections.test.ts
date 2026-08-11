import { describe, expect, it } from 'vitest'
import { decideMemorySignal } from '../skills/memory/policy'
import { isBareTrackLabelCorrection, isTrustedCorrectionEvent, isVagueCorrection } from './memoryCorrections'

describe('memory correction trust filter', () => {
  it('filters bare track labels created by mistaken taste-question capture', () => {
    expect(isBareTrackLabelCorrection('晓月老板 / Q.MARK邱马克 / 老徐 / 文人墨客')).toBe(true)
    expect(isTrustedCorrectionEvent({ kind: 'correction', content: '晓月老板 / Q.MARK邱马克 / 老徐 / 文人墨客' })).toBe(false)
  })

  it('keeps corrections with explicit user meaning', () => {
    expect(isBareTrackLabelCorrection('陈奕迅 / 冷夜: 这首不好听，换激情一点的')).toBe(false)
    expect(isTrustedCorrectionEvent({ kind: 'correction', content: '我不喜欢电子音墙，少推一点' })).toBe(true)
  })

  it('filters stale vague profile corrections before they reach prompts or recommendations', () => {
    expect(isVagueCorrection('这段理解不准')).toBe(true)
    expect(isVagueCorrection('你写得怪怪的')).toBe(true)
    expect(isTrustedCorrectionEvent({ kind: 'correction', content: '这段理解不准' })).toBe(false)
    expect(isTrustedCorrectionEvent({ kind: 'correction', content: '你写得怪怪的' })).toBe(false)
  })

  it('keeps concrete portrait corrections that include a musical direction', () => {
    expect(isVagueCorrection('别把我写成一直很悲伤的人，我最近更想听轻快一点。')).toBe(false)
    expect(isTrustedCorrectionEvent({
      kind: 'correction',
      content: '别把我写成一直很悲伤的人，我最近更想听轻快一点。',
    })).toBe(true)
  })

  it('applies unfavorite as an explicit preference rollback', () => {
    const decision = decideMemorySignal({
      kind: 'unfavorited',
      payload: { artist: '陈奕迅', title: '冷夜' },
      source: 'favorite',
      track: { title: '冷夜', artist: '陈奕迅' },
    })

    expect(decision.apply).toBe(true)
    expect(decision.kind).toBe('unfavorited')
    expect(decision.payload.strength).toBe(0.09)
  })
})
