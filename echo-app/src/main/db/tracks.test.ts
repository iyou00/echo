import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Track } from '../../types/ipc'

const dbMock = vi.hoisted(() => ({
  sql: [] as string[],
  rows: [] as Array<{ id: number; meta_json?: string }>,
  runs: [] as unknown[][],
}))

vi.mock('./index', () => ({
  getDb: vi.fn(() => ({
    prepare: (sql: string) => {
      dbMock.sql.push(sql)
      return {
        all: () => dbMock.rows,
        run: (...args: unknown[]) => {
          dbMock.runs.push(args)
          return { lastInsertRowid: 1 }
        },
      }
    },
  })),
}))

import { updateRecommendedTrackStatus } from './tracks'

describe('recommended track status persistence', () => {
  beforeEach(() => {
    dbMock.sql = []
    dbMock.rows = []
    dbMock.runs = []
  })

  it('updates a matching recent recommendation across midnight with an outcome timestamp', () => {
    const track: Track = { id: '42', title: '跨午夜', artist: 'Echo', sceneSessionId: 7 }
    dbMock.rows = [{ id: 3, meta_json: JSON.stringify(track) }]

    updateRecommendedTrackStatus(track, 'completed', 'playback_completed')

    expect(dbMock.sql[0]).not.toContain("date(listened_at, 'localtime')")
    expect(dbMock.sql[0]).toContain('LIMIT 500')
    const persisted = JSON.parse(String(dbMock.runs[0][0])) as Track
    expect(persisted).toMatchObject({ queueStatus: 'completed', queueStatusReason: 'playback_completed' })
    expect(Date.parse(persisted.queueStatusAt ?? '')).not.toBeNaN()
  })
})
