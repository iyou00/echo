import type { YinyiEntry } from '../../types/ipc'
import { getDb } from './index'

function toEntry(row: { id: number; date: string; content: string; style: string; meta_json?: string | null; created_at: string }): YinyiEntry {
  return {
    id: row.id,
    date: row.date,
    content: row.content,
    style: row.style,
    meta: row.meta_json ? JSON.parse(row.meta_json) : {},
    createdAt: row.created_at,
  }
}

export function upsertYinyi(entry: YinyiEntry): YinyiEntry {
  getDb()
    .prepare(
      `INSERT INTO yinyi (user_id, date, content, style, meta_json)
       VALUES (1, ?, ?, ?, ?)
       ON CONFLICT(date) DO UPDATE SET content = excluded.content, style = excluded.style, meta_json = excluded.meta_json, created_at = CURRENT_TIMESTAMP`,
    )
    .run(entry.date, entry.content, entry.style, JSON.stringify(entry.meta ?? {}))
  return getYinyiByDate(entry.date) as YinyiEntry
}

export function getYinyiByDate(date: string): YinyiEntry | null {
  const row = getDb().prepare('SELECT * FROM yinyi WHERE user_id = 1 AND date = ?').get(date) as Parameters<typeof toEntry>[0] | undefined
  return row ? toEntry(row) : null
}

export function getYinyiRange(limit = 30): YinyiEntry[] {
  const rows = getDb()
    .prepare('SELECT * FROM yinyi WHERE user_id = 1 ORDER BY date DESC LIMIT ?')
    .all(limit) as Parameters<typeof toEntry>[0][]
  return rows.map(toEntry)
}

export function getRandomYinyi(): YinyiEntry | null {
  const row = getDb().prepare('SELECT * FROM yinyi WHERE user_id = 1 ORDER BY RANDOM() LIMIT 1').get() as Parameters<typeof toEntry>[0] | undefined
  return row ? toEntry(row) : null
}
