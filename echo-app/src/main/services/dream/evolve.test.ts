import { describe, expect, it } from 'vitest'
import { parseDreamEvents, ROUTER_KIND_VOCAB } from './review'
import { normalizeForMatch } from '../chat/learnedPrecedentMatcher'

describe('dream extraction vocabulary constraint', () => {
  it('rejects phrasing_precedent with an invented expectedKind', () => {
    const events = parseDreamEvents({
      events: [{
        kind: 'phrasing_precedent',
        trigger_text: '轻一点',
        learned: { triggerPattern: '轻一点', expectedKind: 'low_intensity_request' },
        evidence_quotes: ['我说的轻一点，是指节奏感不要太强'],
        confidence: 0.9,
      }],
    })
    expect(events).toHaveLength(0)
  })

  it('accepts phrasing_precedent with a router-vocabulary kind and routeParams', () => {
    const events = parseDreamEvents({
      events: [{
        kind: 'phrasing_precedent',
        trigger_text: '轻一点',
        learned: { triggerPattern: '轻一点', expectedKind: 'mood_request', routeParams: { mood: '轻柔', energy: 'low', tempo: 'slow' } },
        evidence_quotes: ['我说的轻一点，是指节奏感不要太强'],
        confidence: 0.9,
      }],
    })
    expect(events).toHaveLength(1)
    expect(events[0].learned.expectedKind).toBe('mood_request')
    expect(events[0].learned.routeParams).toEqual({ mood: '轻柔', energy: 'low', tempo: 'slow' })
  })

  it('accepts entity_correction without expectedKind (different pipeline)', () => {
    const events = parseDreamEvents({
      events: [{
        kind: 'entity_correction',
        trigger_text: '不是这首，是原唱',
        learned: { expectArtistQuery: '周杰伦' },
        evidence_quotes: ['不是这首，我要的是原唱版本'],
        confidence: 0.9,
      }],
    })
    expect(events).toHaveLength(1)
  })
})

describe('deterministic precedent matcher', () => {
  it('normalizeForMatch strips whitespace, converts fullwidth, lowercases', () => {
    expect(normalizeForMatch('  轻 一点 ')).toBe('轻一点')
    expect(normalizeForMatch('ＡＢＣ')).toBe('abc')
  })

  it('trigger substring match works on normalized text', () => {
    const input = normalizeForMatch('来点轻一点的歌')
    const trigger = normalizeForMatch('轻一点')
    expect(input.includes(trigger)).toBe(true)
  })

  it('does not match unrelated text', () => {
    const input = normalizeForMatch('今天天气怎么样')
    const trigger = normalizeForMatch('轻一点')
    expect(input.includes(trigger)).toBe(false)
  })
})

describe('router kind vocabulary completeness', () => {
  it('contains the kinds the deterministic matcher can build intents for', () => {
    for (const kind of ['artist_request', 'direct_song', 'mood_request', 'music_search', 'weather', 'identity', 'casual_chat']) {
      expect(ROUTER_KIND_VOCAB.has(kind)).toBe(true)
    }
  })
})
