import { getDb } from './index'

export interface ActiveEvent {
  kind: string
  content: string
  confidence?: number
  weight?: number
  startedAt?: string
}

export function loadActiveEvents(limit = 8): ActiveEvent[] {
  return getDb()
    .prepare(`
      SELECT kind, content, confidence, weight, started_at
      FROM events
      WHERE user_id = 1
        AND (expected_end_at IS NULL OR expected_end_at > datetime('now', 'localtime'))
        AND weight > 0.2
      ORDER BY weight DESC, created_at DESC
      LIMIT ?
    `)
    .all(limit)
    .map((row) => {
      const typed = row as { kind: string; content: string; confidence?: number; weight?: number; started_at?: string }
      return {
        kind: typed.kind,
        content: typed.content,
        confidence: typed.confidence,
        weight: typed.weight,
        startedAt: typed.started_at,
      }
    })
}
