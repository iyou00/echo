import Database from 'better-sqlite3'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { loadProactiveActionSnapshot } from './agentActions'

let database: Database.Database

describe('proactive action snapshot', () => {
  beforeEach(() => {
    database = new Database(':memory:')
    database.function('current_user_id', () => 1)
    database.exec(`
      CREATE TABLE agent_actions (
        id TEXT PRIMARY KEY, user_id INTEGER, origin TEXT, action_type TEXT,
        status TEXT, finished_at TEXT
      );
      CREATE TABLE agent_action_outcomes (
        id INTEGER PRIMARY KEY AUTOINCREMENT, user_id INTEGER, action_id TEXT,
        outcome_type TEXT, occurred_at TEXT
      );
    `)
  })

  afterEach(() => database.close())

  it('uses one final user outcome per care action and excludes system failures', () => {
    database.exec(`
      INSERT INTO agent_actions VALUES
        ('care-1', 1, 'care', 'reply', 'succeeded', '2026-08-13T08:00:00.000Z'),
        ('care-2', 1, 'care', 'reply', 'succeeded', '2026-08-13T09:00:00.000Z'),
        ('care-3', 1, 'care', 'reply', 'succeeded', '2026-08-13T10:00:00.000Z');
      INSERT INTO agent_action_outcomes (user_id, action_id, outcome_type, occurred_at) VALUES
        (1, 'care-1', 'opened', '2026-08-13T08:05:00.000Z'),
        (1, 'care-1', 'dismissed', '2026-08-13T08:06:00.000Z'),
        (1, 'care-2', 'ignored', '2026-08-13T09:05:00.000Z'),
        (1, 'care-3', 'system_failure', '2026-08-13T10:05:00.000Z');
    `)

    expect(loadProactiveActionSnapshot('2026-08-13', 10, database).recentOutcomes).toEqual([
      { type: 'ignored', occurredAt: '2026-08-13T09:05:00.000Z' },
      { type: 'dismissed', occurredAt: '2026-08-13T08:06:00.000Z' },
    ])
  })
})
