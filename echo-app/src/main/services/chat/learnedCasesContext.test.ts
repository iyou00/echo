import { describe, expect, it } from 'vitest'
import { learnedCasesContextTestHelpers } from './learnedCasesContext'

const { summarizeLearned, buildBriefs } = learnedCasesContextTestHelpers

function record(overrides: Record<string, unknown> = {}) {
  return {
    id: 'case-1',
    kind: 'entity_correction',
    triggerText: '不是这首，是陈默之的原唱',
    learned: { expectArtistQuery: '陈默之' },
    evidence: { conversationIds: [], quotes: [], sourceDate: '' },
    confidence: 0.9,
    status: 'active',
    corroborations: 1,
    sourceDate: '',
    createdAt: '',
    updatedAt: '',
    ...overrides,
  } as Parameters<typeof summarizeLearned>[0]
}

describe('learned case summaries for the router prompt', () => {
  it('summarizes alias, entity, and phrasing kinds readably', () => {
    expect(summarizeLearned(record({ kind: 'artist_alias', learned: { alias: '杰伦', expectArtistQuery: '周杰伦' } })))
      .toBe('杰伦 指的是 周杰伦')
    expect(summarizeLearned(record({ learned: { expectArtistQuery: '陈默之', expectSeedTitle: '汽笛' } })))
      .toBe('该说法指 陈默之 的《汽笛》')
    expect(summarizeLearned(record({ kind: 'phrasing_precedent', learned: { expectedKind: 'artist_request' } })))
      .toBe('该说法应按 artist_request 理解')
  })

  it('caps briefs at 8 entries and truncates long text', () => {
    const briefs = buildBriefs(Array.from({ length: 12 }, (_, index) => record({
      id: `case-${index}`,
      triggerText: '很'.repeat(80),
    })))
    expect(briefs).toHaveLength(8)
    expect(briefs[0].trigger.length).toBeLessThanOrEqual(60)
  })
})
