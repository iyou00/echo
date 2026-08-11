import { describe, expect, it } from 'vitest'
import { createDefaultCompanionProfile, type CompanionResponseStrategy } from './companionTypes'
import {
  createFallbackResponseStrategy,
  applySignalsToCompanionProfile,
  decayImplicitCompanionProfile,
  extractExplicitCompanionSignals,
  inferCompanionReactionSignals,
  normalizeCompanionResponseStrategy,
  normalizeCompanionSignals,
} from './companionStrategy'
import { applyCompanionResponseStyle } from './companionResponse'

describe('companion response strategy', () => {
  it('allows one playful response for repeated fatigue with the default relationship profile', () => {
    const strategy = createFallbackResponseStrategy({
      userText: '今天加班又累死了',
      wantsMusic: false,
      profile: createDefaultCompanionProfile(),
      brief: {
        topic: 'fatigue',
        tone: 'playful_concern',
        pattern: 'same_day_repeat',
        sameDayMentions: 2,
        guidance: [],
      },
    })

    expect(strategy.mode).toBe('playful_tease')
    expect(strategy.playfulness).toBeGreaterThanOrEqual(0.58)
  })

  it('immediately suppresses teasing when the user sets a boundary', () => {
    const strategy = normalizeCompanionResponseStrategy({
      mode: 'playful_tease',
      warmth: 0.5,
      playfulness: 0.9,
      directness: 0.7,
      vulnerability: 'low',
    }, {
      userText: '我今天很累，别调侃我',
      wantsMusic: false,
      profile: createDefaultCompanionProfile(),
    })

    expect(strategy.mode).toBe('warm_care')
    expect(strategy.playfulness).toBeLessThanOrEqual(0.05)
  })

  it('forces serious care for immediate safety risk', () => {
    const strategy = normalizeCompanionResponseStrategy({
      mode: 'playful_tease',
      warmth: 0.2,
      playfulness: 0.8,
      directness: 0.2,
      vulnerability: 'low',
    }, {
      userText: '我撑不下去了，甚至有点不想活',
      wantsMusic: false,
    })

    expect(strategy.mode).toBe('serious_care')
    expect(strategy.vulnerability).toBe('high')
    expect(strategy.playfulness).toBe(0)
  })

  it('extracts explicit relationship preferences from natural language', () => {
    const signals = extractExplicitCompanionSignals('以后你可以损我，但回答简短点')

    expect(signals).toEqual(expect.arrayContaining([
      expect.objectContaining({ dimension: 'playfulness', direction: 'more', explicit: true }),
      expect.objectContaining({ dimension: 'verbosity', direction: 'less', explicit: true }),
    ]))
  })

  it('treats less comforting as a request for directness without inferring teasing', () => {
    const signals = extractExplicitCompanionSignals('别一味安慰我，直接说重点')

    expect(signals).toEqual(expect.arrayContaining([
      expect.objectContaining({ dimension: 'warmth', direction: 'less' }),
      expect.objectContaining({ dimension: 'directness', direction: 'more' }),
    ]))
    expect(signals).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ dimension: 'playfulness', direction: 'more' }),
    ]))
  })

  it('keeps LLM preference evidence grounded in the current input', () => {
    const signals = normalizeCompanionSignals([
      { dimension: 'directness', direction: 'more', confidence: 0.9, explicit: true, evidence: '直接说' },
      { dimension: 'playfulness', direction: 'more', confidence: 0.9, explicit: true, evidence: '用户喜欢玩笑' },
    ], '以后直接说，别绕弯')

    expect(signals).toEqual([
      expect.objectContaining({ dimension: 'directness', direction: 'more', evidence: '直接说' }),
    ])
  })

  it('respects a learned low-playfulness profile during repeated fatigue', () => {
    const profile = createDefaultCompanionProfile()
    profile.playfulness = { value: 0.1, confidence: 0.9, evidenceCount: 3, updatedAt: profile.updatedAt }
    const strategy = createFallbackResponseStrategy({
      userText: '今天又累了',
      wantsMusic: false,
      profile,
      brief: {
        topic: 'fatigue',
        tone: 'playful_concern',
        pattern: 'same_day_repeat',
        sameDayMentions: 2,
        guidance: [],
      },
    })

    expect(strategy.mode).not.toBe('playful_tease')
    expect(strategy.playfulness).toBe(0)
  })

  it('turns a direct reaction to a playful reply into a bounded learning signal', () => {
    const previous = createFallbackResponseStrategy({
      userText: '今天又累了',
      wantsMusic: false,
      brief: {
        topic: 'fatigue',
        tone: 'playful_concern',
        pattern: 'same_day_repeat',
        sameDayMentions: 2,
        guidance: [],
      },
    })

    expect(inferCompanionReactionSignals('你刚才这样说挺好，就这样和我说', previous)).toEqual([
      expect.objectContaining({ dimension: 'playfulness', direction: 'more', explicit: false }),
    ])
    expect(inferCompanionReactionSignals('别再这么说，我不喜欢', previous)).toEqual([
      expect.objectContaining({ dimension: 'playfulness', direction: 'less', explicit: false }),
    ])
    expect(inferCompanionReactionSignals('那继续放歌吧', previous)).toEqual([])
  })

  it('learns that approval of quiet company means less initiative', () => {
    const quiet: CompanionResponseStrategy = {
      mode: 'quiet_company',
      warmth: 0.7,
      playfulness: 0,
      directness: 0.35,
      initiative: 'reply_only',
      verbosity: 'short',
      vulnerability: 'medium',
      reasonCodes: ['current_vulnerability'],
    }

    expect(inferCompanionReactionSignals('你刚才这样说挺好', quiet)).toEqual([
      expect.objectContaining({ dimension: 'initiative', direction: 'less' }),
    ])
    expect(inferCompanionReactionSignals('别再这么说', quiet)).toEqual([
      expect.objectContaining({ dimension: 'initiative', direction: 'more' }),
    ])
  })

  it('lets the calibrated strategy suppress an older playful fatigue brief', () => {
    const content = applyCompanionResponseStyle('先休息一会儿。', '我又累了，别调侃我', {
      topic: 'fatigue',
      tone: 'playful_concern',
      pattern: 'same_day_repeat',
      sameDayMentions: 2,
      guidance: [],
    }, {
      mode: 'warm_care',
      warmth: 0.9,
      playfulness: 0,
      directness: 0.5,
      initiative: 'reply_only',
      verbosity: 'short',
      vulnerability: 'medium',
      reasonCodes: ['explicit_boundary'],
    })

    expect(content).toBe('累了就先别硬撑，给自己留口气。先休息一会儿。')
    expect(content).not.toContain('发财')
    expect(content).not.toContain('活该')
  })

  it('learns explicit preferences faster and decays only implicit preferences', () => {
    const profile = createDefaultCompanionProfile('2026-01-01T00:00:00.000Z')
    const explicit = applySignalsToCompanionProfile(profile, [{
      dimension: 'playfulness',
      direction: 'more',
      confidence: 1,
      explicit: true,
      evidence: '你可以损我',
    }], '2026-01-01T00:00:00.000Z')
    const implicit = applySignalsToCompanionProfile(profile, [{
      dimension: 'directness',
      direction: 'more',
      confidence: 0.8,
      explicit: false,
      evidence: '你刚才这样说挺好',
    }], '2026-01-01T00:00:00.000Z')
    const explicitAfterTime = decayImplicitCompanionProfile(explicit, new Date('2026-08-01T00:00:00.000Z'))
    const implicitAfterTime = decayImplicitCompanionProfile(implicit, new Date('2026-08-01T00:00:00.000Z'))

    expect(explicit.playfulness.value).toBeGreaterThan(profile.playfulness.value)
    expect(explicitAfterTime.playfulness.value).toBe(explicit.playfulness.value)
    expect(implicitAfterTime.directness.value).toBeLessThan(implicit.directness.value)
  })
})
