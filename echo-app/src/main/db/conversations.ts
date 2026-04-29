import type { ChatMessage, Track } from '../../types/ipc'
import { getDb } from './index'

function normalizeCreatedAt(value: string): string {
  if (!value) return new Date().toISOString()
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(value)) return value
  return `${value.replace(' ', 'T')}Z`
}

function toMessage(row: { id: number; role: string; content: string; created_at: string; meta_json?: string | null }): ChatMessage {
  const meta = row.meta_json ? JSON.parse(row.meta_json) : {}
  return {
    id: row.id,
    role: row.role === 'user' ? 'user' : 'assistant',
    content: row.content,
    createdAt: normalizeCreatedAt(row.created_at),
    tracks: meta.tracks ?? [],
  }
}

export function appendConversation(role: 'user' | 'assistant', content: string, tracks: Track[] = []): ChatMessage {
  const result = getDb()
    .prepare('INSERT INTO conversations (user_id, role, content, meta_json) VALUES (1, ?, ?, ?)')
    .run(role, content, JSON.stringify({ tracks }))
  const row = getDb().prepare('SELECT * FROM conversations WHERE id = ?').get(result.lastInsertRowid) as Parameters<typeof toMessage>[0]
  return toMessage(row)
}

export function loadRecentConversations(limit = 30): ChatMessage[] {
  const rows = getDb()
    .prepare('SELECT * FROM conversations WHERE user_id = 1 ORDER BY created_at DESC, id DESC LIMIT ?')
    .all(limit) as Parameters<typeof toMessage>[0][]
  return rows.reverse().map(toMessage)
}

export function loadTodayConversations(limit = 30): ChatMessage[] {
  const rows = getDb()
    .prepare(`
      SELECT *
      FROM conversations
      WHERE user_id = 1
        AND date(created_at, 'localtime') = date('now', 'localtime')
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `)
    .all(limit) as Parameters<typeof toMessage>[0][]
  return rows.reverse().map(toMessage)
}

export function countConversations(): number {
  const row = getDb().prepare('SELECT COUNT(*) AS total FROM conversations WHERE user_id = 1').get() as { total: number }
  return row.total
}
