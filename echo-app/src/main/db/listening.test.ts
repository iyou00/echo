import { beforeEach, describe, expect, it, vi } from 'vitest'

const dbMock = vi.hoisted(() => ({
  sql: [] as string[],
  runs: [] as unknown[][],
  rows: [] as Array<Record<string, unknown>>,
  row: undefined as Record<string, unknown> | undefined,
  insertId: 1,
}))

vi.mock('./index', () => ({
  getDb: vi.fn(() => ({
    prepare: (sql: string) => {
      dbMock.sql.push(sql)
      return {
        all: () => dbMock.rows,
        get: () => dbMock.row,
        run: (...args: unknown[]) => {
          dbMock.runs.push(args)
          return { lastInsertRowid: dbMock.insertId }
        },
      }
    },
    transaction: (fn: () => unknown) => () => fn(),
  })),
}))

import { appendListeningSegment, endListeningSession, loadActiveListeningSession, loadListeningSegments } from './listening'

describe('continuous listening persistence', () => {
  beforeEach(() => {
    dbMock.sql = []
    dbMock.runs = []
    dbMock.rows = []
    dbMock.row = undefined
    dbMock.insertId = 1
  })

  it('loads only the current user active session inside the idle window', () => {
    dbMock.row = {
      id: 4,
      status: 'active',
      started_at: '2026-08-10T12:00:00.000Z',
      last_active_at: '2026-08-10T12:10:00.000Z',
      ended_at: null,
      segment_count: 3,
      companion_mode: 'serious_care',
      consumed_event_keys_json: '["event:12"]',
    }

    const session = loadActiveListeningSession(new Date('2026-08-10T12:20:00.000Z'))

    expect(session?.segmentCount).toBe(3)
    expect(session?.companionMode).toBe('serious_care')
    expect(session?.consumedEventKeys).toEqual(['event:12'])
    expect(dbMock.sql[0]).toContain('user_id = current_user_id()')
    expect(dbMock.sql[0]).toContain("status = 'active'")
    expect(dbMock.sql[0]).toContain('datetime(last_active_at)')
  })

  it('maps persisted segment planning fields back into session context', () => {
    dbMock.rows = [{
      id: 7,
      session_id: 4,
      track_key: 'id:42',
      track_json: JSON.stringify({ title: '主角', artist: '王菲' }),
      text: '王菲的《主角》先唱，我少说两句。',
      delivery: 'spoken',
      density: 'micro',
      move: 'self_silence',
      sentence_form: 'leave_space',
      topic_source: 'music_transition',
      signature: '签名',
      generated_at: '2026-08-10T12:10:00.000Z',
    }]

    const segments = loadListeningSegments(4, 8)

    expect(segments[0]).toEqual(expect.objectContaining({
      move: 'self_silence',
      sentenceForm: 'leave_space',
      track: expect.objectContaining({ title: '主角', artist: '王菲' }),
    }))
    expect(dbMock.sql[0]).toContain('session_id = ?')
  })

  it('persists the segment and advances the session count in one transaction', () => {
    dbMock.row = {
      id: 9,
      session_id: 4,
      track_key: 'id:42',
      track_json: JSON.stringify({ id: '42', title: '主角', artist: '王菲' }),
      text: '王菲的《主角》先唱，我少说两句。',
      delivery: 'spoken',
      density: 'micro',
      move: 'self_silence',
      sentence_form: 'leave_space',
      topic_source: 'music_transition',
      signature: '签名',
      generated_at: '2026-08-10T12:10:00.000Z',
    }

    appendListeningSegment({
      sessionId: 4,
      track: { id: '42', title: '主角', artist: '王菲' },
      text: '王菲的《主角》先唱，我少说两句。',
      delivery: 'spoken',
      density: 'micro',
      move: 'self_silence',
      sentenceForm: 'leave_space',
      topicSource: 'music_transition',
      signature: '签名',
      companionMode: 'serious_care',
      consumedEventKeys: ['event:12'],
      generatedAt: '2026-08-10T12:10:00.000Z',
    })

    expect(dbMock.sql.some((sql) => sql.includes('INSERT INTO listening_segments'))).toBe(true)
    expect(dbMock.sql.some((sql) => sql.includes('segment_count = segment_count + 1'))).toBe(true)
    expect(dbMock.sql.some((sql) => sql.includes('consumed_event_keys_json = ?'))).toBe(true)
    expect(dbMock.runs.some((args) => args.includes('serious_care') && args.includes('["event:12"]'))).toBe(true)
  })

  it('ends only the current user listening session', () => {
    endListeningSession(4, new Date('2026-08-10T12:20:00.000Z'))

    expect(dbMock.sql[0]).toContain("SET status = 'ended'")
    expect(dbMock.sql[0]).toContain('user_id = current_user_id()')
    expect(dbMock.runs[0]).toEqual([
      '2026-08-10T12:20:00.000Z',
      '2026-08-10T12:20:00.000Z',
      4,
    ])
  })

  it('can close the current user active session before a generated id returns', () => {
    endListeningSession(undefined, new Date('2026-08-10T12:21:00.000Z'))

    expect(dbMock.sql[0]).toContain("status = 'active'")
    expect(dbMock.sql[0]).toContain('user_id = current_user_id()')
    expect(dbMock.runs[0]).toEqual([
      '2026-08-10T12:21:00.000Z',
      '2026-08-10T12:21:00.000Z',
    ])
  })
})
