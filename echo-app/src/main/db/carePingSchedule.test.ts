import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { restoreCarePingPlan } from './carePingSchedule'

let database: Database.Database

describe('care ping schedule restore', () => {
  beforeEach(() => {
    database = new Database(':memory:')
    database.exec(`
      CREATE TABLE care_ping_schedule (
        id INTEGER PRIMARY KEY, date TEXT, window_key TEXT, label TEXT, planned_at TEXT,
        status TEXT, ran_at TEXT, message TEXT, error TEXT, eligible_after TEXT,
        defer_count INTEGER DEFAULT 0, decision_code TEXT
      );
    `)
  })

  afterEach(() => database.close())

  it('returns the persisted restored state without stale defer fields', () => {
    database.prepare(`
      INSERT INTO care_ping_schedule VALUES
        (1, '2026-08-13', 'afternoon', '午后提醒', '2026-08-13 14:10',
         'skipped', '2026-08-13 14:15', '当前频率已关闭这个提醒时段。', '',
         '2026-08-13T06:30:00.000Z', 1, 'recent_user_activity')
    `).run()

    expect(restoreCarePingPlan(1, false, database)).toMatchObject({
      status: 'planned', eligibleAfter: null, deferCount: 0, decisionCode: null,
    })
  })

  it('can restore a frequency-disabled plan without losing its deferred time', () => {
    database.prepare(`
      INSERT INTO care_ping_schedule VALUES
        (2, '2026-08-13', 'afternoon', '午后提醒', '2026-08-13 14:10',
         'skipped', '2026-08-13 14:15', '当前频率已关闭这个提醒时段。', '',
         '2026-08-13T06:30:00.000Z', 1, 'recent_user_activity')
    `).run()

    expect(restoreCarePingPlan(2, true, database)).toMatchObject({
      status: 'planned', eligibleAfter: '2026-08-13T06:30:00.000Z', deferCount: 1,
      decisionCode: 'recent_user_activity',
    })
  })
})
