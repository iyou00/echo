import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import type { CarePingRecord } from '../db/carePings'
import { carePingTestHelpers, reconcileCarePingOutcomes } from './carePings'

let database: Database.Database

function createRecord(id: number, actionId: string): CarePingRecord {
  return {
    id,
    type: 'casual_check',
    title: 'Echo',
    body: '歇一会儿。',
    payload: { type: 'casual_check', agentActionId: actionId },
    triggeredAt: '2026-08-13T08:00:00.000Z',
    shownAt: '2026-08-13T08:00:00.000Z',
    observationDueAt: '2026-08-13T12:00:00.000Z',
  }
}

function insertRecord(record: CarePingRecord): void {
  database.prepare(`
    INSERT INTO care_pings (
      id, type, title, body, payload_json, triggered_at, shown_at, observation_due_at, clicked_at, dismissed_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, NULL, NULL)
  `).run(record.id, record.type, record.title, record.body, JSON.stringify(record.payload),
    record.triggeredAt, record.shownAt, record.observationDueAt)
}

describe('care ping outcome reconciliation', () => {
  beforeEach(() => {
    database = new Database(':memory:')
    database.function('current_user_id', () => 1)
    database.exec(`
      CREATE TABLE care_pings (
        id INTEGER PRIMARY KEY, type TEXT, title TEXT, body TEXT, payload_json TEXT,
        triggered_at TEXT, shown_at TEXT, observation_due_at TEXT, clicked_at TEXT, dismissed_at TEXT
      );
      CREATE TABLE agent_action_outcomes (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, action_id TEXT, action_item_id TEXT,
        source_event_key TEXT UNIQUE, outcome_type TEXT, polarity TEXT, strength TEXT,
        occurred_at TEXT, metadata_json TEXT
      );
    `)
  })

  afterEach(() => database.close())

  it('writes one ignored outcome after the four-hour window', () => {
    insertRecord(createRecord(1, 'care-1'))

    expect(reconcileCarePingOutcomes(new Date('2026-08-13T12:01:00.000Z'), database)).toBe(1)
    expect(reconcileCarePingOutcomes(new Date('2026-08-13T12:02:00.000Z'), database)).toBe(0)
    const row = database.prepare('SELECT outcome_type, strength FROM agent_action_outcomes').get() as Record<string, string>
    expect(row).toEqual({ outcome_type: 'ignored', strength: 'weak' })
  })

  it('does not infer ignored after the notification was opened', () => {
    const record = createRecord(2, 'care-2')
    insertRecord(record)
    expect(carePingTestHelpers.recordCareTerminalOutcome(record, 'opened', new Date('2026-08-13T10:00:00.000Z'), database)).toBe(true)

    expect(reconcileCarePingOutcomes(new Date('2026-08-13T12:01:00.000Z'), database)).toBe(0)
    expect(database.prepare("SELECT COUNT(*) count FROM agent_action_outcomes WHERE outcome_type = 'ignored'").get()).toEqual({ count: 0 })
  })

  it('records explicit dismissal once and excludes it from later reconciliation', () => {
    const record = createRecord(3, 'care-3')
    insertRecord(record)
    expect(carePingTestHelpers.recordCareTerminalOutcome(record, 'dismissed', new Date('2026-08-13T10:00:00.000Z'), database)).toBe(true)
    expect(carePingTestHelpers.recordCareTerminalOutcome(record, 'dismissed', new Date('2026-08-13T10:01:00.000Z'), database)).toBe(false)

    expect(reconcileCarePingOutcomes(new Date('2026-08-13T12:01:00.000Z'), database)).toBe(0)
    expect(database.prepare("SELECT COUNT(*) count FROM agent_action_outcomes WHERE outcome_type = 'dismissed'").get()).toEqual({ count: 1 })
  })

  it('keeps an explicit dismissal after open and still prevents ignored', () => {
    const record = createRecord(4, 'care-4')
    insertRecord(record)
    expect(carePingTestHelpers.recordCareTerminalOutcome(record, 'opened', new Date('2026-08-13T09:00:00.000Z'), database)).toBe(true)
    expect(carePingTestHelpers.recordCareTerminalOutcome(record, 'dismissed', new Date('2026-08-13T09:01:00.000Z'), database)).toBe(true)

    expect(reconcileCarePingOutcomes(new Date('2026-08-13T12:01:00.000Z'), database)).toBe(0)
    expect(database.prepare('SELECT outcome_type FROM agent_action_outcomes ORDER BY id').all()).toEqual([
      { outcome_type: 'opened' },
      { outcome_type: 'dismissed' },
    ])
  })
})
