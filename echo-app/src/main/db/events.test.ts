import { describe, expect, it, vi } from 'vitest'

const dbMock = vi.hoisted(() => ({
  sql: [] as string[],
  rows: [] as Array<{ kind: string; content: string; confidence?: number; weight?: number; started_at?: string; created_at?: string }>,
  row: undefined as Record<string, unknown> | undefined,
}))
const stageContextMock = vi.hoisted(() => ({ current: null as import('../../types/ipc').StageContext | null }))

vi.mock('./index', () => ({
  getDb: vi.fn(() => ({
    prepare: (sql: string) => {
      dbMock.sql.push(sql)
      return {
        all: () => dbMock.rows,
        get: () => dbMock.row,
      }
    },
  })),
}))

vi.mock('../domain/stageContext/repository', () => ({
  loadActiveStageContext: vi.fn(() => stageContextMock.current),
}))

import { getCorrectionEventCount, getLatestCorrectionCreatedAt, loadActiveEvents, loadRecentEvents } from './events'

describe('event queries', () => {
  it('keeps profile corrections out of active context events', () => {
    dbMock.sql = []
    dbMock.rows = [{ kind: 'context', content: '最近压力很大', weight: 0.8 }]

    const events = loadActiveEvents(8)

    expect(events).toEqual([{ kind: 'context', content: '最近压力很大', weight: 0.8, startedAt: undefined, createdAt: undefined }])
    expect(dbMock.sql[0]).toContain("kind != 'correction'")
    expect(dbMock.sql[0]).toContain("kind = 'context'")
    expect(dbMock.sql[0]).toContain("COALESCE(expected_end_at, datetime(COALESCE(started_at, created_at), '+6 hours'))")
  })

  it('still allows correction history to be loaded explicitly', () => {
    dbMock.sql = []
    dbMock.rows = [{ kind: 'correction', content: '我不喜欢电子音墙，少推一点。', weight: 0.8 }]

    const events = loadRecentEvents('correction', 8)

    expect(events[0]?.kind).toBe('correction')
    expect(dbMock.sql[0]).toContain('WHERE user_id = current_user_id() AND kind = ?')
  })

  it('projects the current stage ahead of duplicate legacy context', () => {
    dbMock.sql = []
    dbMock.rows = [{ kind: 'context', content: '今晚加班', weight: 0.8 }]
    stageContextMock.current = {
      id: 'stage-1', kind: 'work', status: 'active', summary: '今晚加班',
      state: { emotion: 'tired', energy: 'low', interactionPreference: 'music', safety: 'normal' },
      goal: 'focus', confidence: 0.95, revision: 1,
      startedAt: '2026-08-12T10:00:00.000Z', lastActiveAt: '2026-08-12T10:00:00.000Z', expiresAt: '2026-08-12T18:00:00.000Z',
    }

    expect(loadActiveEvents(8)).toHaveLength(1)
    expect(loadActiveEvents(8)[0]).toMatchObject({ content: '今晚加班', confidence: 0.95, weight: 1 })
    stageContextMock.current = null
  })

  it('reports correction event count for scheduler refresh decisions', () => {
    dbMock.sql = []
    dbMock.row = { total: 3 }

    expect(getCorrectionEventCount()).toBe(3)
    expect(dbMock.sql[0]).toContain("kind = 'correction'")
  })

  it('reports latest correction timestamp for scheduler refresh decisions', () => {
    dbMock.sql = []
    dbMock.row = { created_at: '2026-06-23 10:00:00' }

    expect(getLatestCorrectionCreatedAt()).toBe('2026-06-23 10:00:00')
    expect(dbMock.sql[0]).toContain('MAX(created_at)')
  })
})
