import type { ChatMessage, Track } from '../../types/ipc'
import type { CompanionResponseStrategy } from '../services/chat/companionTypes'
import { getDb } from './index'
import { parseJson } from './json'

function normalizeCreatedAt(value: string): string {
  if (!value) return new Date().toISOString()
  if (/[zZ]|[+-]\d{2}:?\d{2}$/.test(value)) return value
  return `${value.replace(' ', 'T')}Z`
}

function toMessage(row: { id: number; role: string; content: string; created_at: string; meta_json?: string | null }): ChatMessage {
  const meta = parseJson<{ tracks?: Track[] }>(row.meta_json, {}, 'conversations.meta_json')
  return {
    id: row.id,
    role: row.role === 'user' ? 'user' : 'assistant',
    content: row.content,
    createdAt: normalizeCreatedAt(row.created_at),
    tracks: Array.isArray(meta.tracks) ? meta.tracks : [],
  }
}

export interface ConversationMeta {
  responseStrategy?: CompanionResponseStrategy
}

export function appendConversation(role: 'user' | 'assistant', content: string, tracks: Track[] = [], meta: ConversationMeta = {}): ChatMessage {
  const result = getDb()
    .prepare('INSERT INTO conversations (user_id, role, content, meta_json) VALUES (current_user_id(), ?, ?, ?)')
    .run(role, content, JSON.stringify({ tracks, ...meta }))
  const row = getDb().prepare('SELECT * FROM conversations WHERE id = ?').get(result.lastInsertRowid) as Parameters<typeof toMessage>[0]
  return toMessage(row)
}

export function loadRecentConversations(limit = 30): ChatMessage[] {
  const rows = getDb()
    .prepare('SELECT * FROM conversations WHERE user_id = current_user_id() ORDER BY created_at DESC, id DESC LIMIT ?')
    .all(limit) as Parameters<typeof toMessage>[0][]
  return rows.reverse().map(toMessage)
}

export function loadTodayConversations(limit = 30): ChatMessage[] {
  return loadConversationsForDate(new Date().toLocaleDateString('sv-SE'), limit)
}

export function loadConversationsForDate(date: string, limit = 30): ChatMessage[] {
  const rows = getDb()
    .prepare(`
      SELECT *
      FROM conversations
      WHERE user_id = current_user_id()
        AND date(created_at, 'localtime') = date(?)
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `)
    .all(date, limit) as Parameters<typeof toMessage>[0][]
  return rows.reverse().map(toMessage)
}

export function loadUserConversationsForDate(date: string, limit = 30): ChatMessage[] {
  const rows = getDb()
    .prepare(`
      SELECT *
      FROM conversations
      WHERE user_id = current_user_id()
        AND role = 'user'
        AND date(created_at, 'localtime') = date(?)
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `)
    .all(date, limit) as Parameters<typeof toMessage>[0][]
  return rows.reverse().map(toMessage)
}

export function loadUserConversationsSince(createdAfter: string, limit = 300): ChatMessage[] {
  const rows = getDb()
    .prepare(`
      SELECT *
      FROM conversations
      WHERE user_id = current_user_id()
        AND role = 'user'
        AND created_at >= ?
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `)
    .all(createdAfter, limit) as Parameters<typeof toMessage>[0][]
  return rows.reverse().map(toMessage)
}

export function countConversations(): number {
  const row = getDb().prepare('SELECT COUNT(*) AS total FROM conversations WHERE user_id = current_user_id()').get() as { total: number }
  return row.total
}

export function countUserConversations(): number {
  const row = getDb()
    .prepare("SELECT COUNT(*) AS total FROM conversations WHERE user_id = current_user_id() AND role = 'user'")
    .get() as { total: number }
  return row.total
}
