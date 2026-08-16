import { describe, expect, it } from 'vitest'
import { dreamReviewTestHelpers } from './review'
import type { LearnedCaseRecord } from '../../db/learnedCases'

const { parseDreamEvents, evidenceIsGrounded, activationTier, mergeWithExistingCases } = dreamReviewTestHelpers

function draft(overrides: Partial<Parameters<typeof activationTier>[0]> = {}) {
  return {
    kind: 'entity_correction' as const,
    triggerText: '不是这首，是原唱的',
    learned: { expectArtistQuery: '陈默之' },
    evidenceQuotes: ['不是这首'],
    confidence: 0.9,
    ...overrides,
  }
}

function record(overrides: Partial<LearnedCaseRecord> = {}): LearnedCaseRecord {
  return {
    id: 'case-1',
    kind: 'entity_correction',
    triggerText: '不是这首，是原唱的',
    learned: { expectArtistQuery: '陈默之' },
    evidence: { conversationIds: [1], quotes: ['不是这首'], sourceDate: '2026-08-15' },
    confidence: 0.9,
    status: 'active',
    corroborations: 1,
    sourceDate: '2026-08-15',
    createdAt: '2026-08-15 23:30:00',
    updatedAt: '2026-08-15 23:30:00',
    ...overrides,
  }
}

describe('dream event parsing (defensive)', () => {
  it('accepts a well-formed event', () => {
    const events = parseDreamEvents({
      events: [{
        kind: 'artist_alias',
        trigger_text: '来点杰伦的',
        learned: { alias: '杰伦', expectArtistQuery: '周杰伦' },
        evidence_quotes: ['来点杰伦的'],
        confidence: 0.92,
      }],
    })
    expect(events).toHaveLength(1)
    expect(events[0].kind).toBe('artist_alias')
    expect(events[0].learned.expectArtistQuery).toBe('周杰伦')
  })

  it('drops entries with unknown kinds, empty learned, or missing trigger', () => {
    const events = parseDreamEvents({
      events: [
        { kind: 'random_stuff', trigger_text: 'x', learned: { a: 1 }, evidence_quotes: ['x'], confidence: 0.9 },
        { kind: 'entity_correction', trigger_text: '', learned: { a: 1 }, evidence_quotes: ['x'], confidence: 0.9 },
        { kind: 'entity_correction', trigger_text: 'ok', learned: {}, evidence_quotes: ['ok'], confidence: 0.9 },
      ],
    })
    expect(events).toHaveLength(0)
  })

  it('clamps confidence and ignores non-string quotes', () => {
    const events = parseDreamEvents({
      events: [{ kind: 'phrasing_precedent', trigger_text: '随便来一首X的', learned: { expectedKind: 'artist_request' }, evidence_quotes: ['随便来一首', 42], confidence: 5 }],
    })
    expect(events[0].confidence).toBe(1)
    expect(events[0].evidenceQuotes).toEqual(['随便来一首'])
  })

  it('returns empty for non-object payloads', () => {
    expect(parseDreamEvents(null)).toEqual([])
    expect(parseDreamEvents('events')).toEqual([])
    expect(parseDreamEvents({ events: 'nope' })).toEqual([])
  })
})

describe('dream evidence grounding', () => {
  const messages = [
    { content: '不是这首，我要陈默之的原唱版本' },
    { content: '好的，我重新找原唱。' },
  ]

  it('accepts quotes that literally appear in the dialog', () => {
    expect(evidenceIsGrounded(['不是这首', '原唱版本'], messages)).toBe(true)
  })

  it('rejects fabricated quotes entirely', () => {
    expect(evidenceIsGrounded(['用户纠正了歌手'], messages)).toBe(false)
  })

  it('rejects quotes too short to be distinguishing evidence', () => {
    // 单字/双字引用几乎能在任何对话里找到，等于没有证据。
    expect(evidenceIsGrounded(['不是'], messages)).toBe(false)
    expect(evidenceIsGrounded(['晴天'], messages)).toBe(false)
  })

  it('rejects empty quote lists', () => {
    expect(evidenceIsGrounded([], messages)).toBe(false)
  })
})

describe('dream activation tiers', () => {
  it('activates explicit high-confidence corrections with evidence', () => {
    expect(activationTier(draft())).toBe('active')
  })

  it('keeps lower-confidence or evidence-less drafts pending', () => {
    expect(activationTier(draft({ confidence: 0.7 }))).toBe('pending')
    expect(activationTier(draft({ evidenceQuotes: [] }))).toBe('pending')
  })

  it('never stores companion_adjustment or noise', () => {
    expect(activationTier(draft({ kind: 'companion_adjustment' }))).toBe('skip')
    expect(activationTier(draft({ kind: 'noise' }))).toBe('skip')
  })
})

describe('dream corroboration and contradiction', () => {
  it('matches an identical learned case for corroboration', () => {
    const result = mergeWithExistingCases(draft(), [record()], '2026-08-16')
    expect(result.matched?.id).toBe('case-1')
    expect(result.sameDateOnly).toBe(false)
  })

  it('flags same-date duplicates as non-independent', () => {
    const result = mergeWithExistingCases(draft(), [record()], '2026-08-15')
    expect(result.sameDateOnly).toBe(true)
  })

  it('retires an alias case when the same alias now points elsewhere', () => {
    const existing = record({
      kind: 'artist_alias',
      learned: { alias: '杰伦', expectArtistQuery: '周杰伦' },
    })
    const contradicted = mergeWithExistingCases(
      draft({ kind: 'artist_alias', learned: { alias: '杰伦', expectArtistQuery: '陈杰倫' } }),
      [existing],
      '2026-08-16',
    )
    expect(contradicted.contradicted?.id).toBe('case-1')
  })

  it('does not contradict entity corrections (no reliable contradiction key)', () => {
    const result = mergeWithExistingCases(
      draft({ learned: { expectArtistQuery: '苏星婕' } }),
      [record()],
      '2026-08-16',
    )
    expect(result.contradicted).toBeNull()
    expect(result.matched).toBeNull()
  })

  it('does not contradict phrasing precedents without entity keys', () => {
    const existing = record({ kind: 'phrasing_precedent', learned: { expectedKind: 'artist_request' } })
    const result = mergeWithExistingCases(
      draft({ kind: 'phrasing_precedent', learned: { expectedKind: 'mood_request' } }),
      [existing],
      '2026-08-16',
    )
    expect(result.contradicted).toBeNull()
  })
})
