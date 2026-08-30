import { beforeEach, describe, expect, it, vi } from 'vitest'

const dbMock = vi.hoisted(() => ({ sql: [] as string[] }))

vi.mock('./index', () => ({
  getDb: vi.fn(() => ({
    prepare: (sql: string) => {
      dbMock.sql.push(sql)
      return { run: () => ({ changes: 1 }), get: () => undefined }
    },
  })),
}))

import { incrementLearnedCaseHit, insertLearnedCase, pruneDecayedLearnedCases } from './learnedCases'

describe('learned case lifetime', () => {
  beforeEach(() => { dbMock.sql = [] })

  it('records a route match without turning it into fresh evidence', () => {
    incrementLearnedCaseHit('case-1')
    expect(dbMock.sql[0]).toContain('last_matched_at = CURRENT_TIMESTAMP')
    expect(dbMock.sql[0]).not.toContain('updated_at = CURRENT_TIMESTAMP')
    expect(dbMock.sql[0]).not.toContain('last_evidence_at = CURRENT_TIMESTAMP')
  })

  it('expires active cases by their last grounded evidence', () => {
    expect(pruneDecayedLearnedCases(new Date('2026-08-30T00:00:00.000Z'))).toBe(1)
    expect(dbMock.sql[0]).toContain('COALESCE(last_evidence_at, created_at) < ?')
    expect(dbMock.sql[0]).not.toContain('updated_at < ?')
  })

  it('gives new evidence a timestamp on databases upgraded from the old schema', () => {
    insertLearnedCase({
      kind: 'phrasing_precedent', triggerText: '累了', learned: { expectedKind: 'casual_chat' },
      evidence: { conversationIds: [1], quotes: ['累了'], sourceDate: '2026-08-30' },
      confidence: 0.9, status: 'active',
    })
    expect(dbMock.sql[0]).toContain('last_evidence_at')
    expect(dbMock.sql[0]).toContain('CURRENT_TIMESTAMP')
  })
})
