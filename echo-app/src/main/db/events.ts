import { getDb } from './index'

export interface ActiveEvent {
  kind: string
  content: string
  confidence?: number
  weight?: number
  startedAt?: string
  createdAt?: string
}

export function loadActiveEvents(limit = 8): ActiveEvent[] {
  return getDb()
    .prepare(`
      SELECT kind, content, confidence, weight, started_at, created_at
      FROM events
      WHERE user_id = current_user_id()
        AND kind != 'correction'
        AND (
          (
            kind = 'context'
            AND COALESCE(expected_end_at, datetime(COALESCE(started_at, created_at), '+6 hours')) > datetime('now', 'localtime')
          )
          OR (
            kind != 'context'
            AND (expected_end_at IS NULL OR expected_end_at > datetime('now', 'localtime'))
          )
        )
        AND weight > 0.2
      ORDER BY weight DESC, created_at DESC
      LIMIT ?
    `)
    .all(limit)
    .map((row) => {
      const typed = row as { kind: string; content: string; confidence?: number; weight?: number; started_at?: string; created_at?: string }
      return {
        kind: typed.kind,
        content: typed.content,
        confidence: typed.confidence,
        weight: typed.weight,
        startedAt: typed.started_at,
        createdAt: typed.created_at,
      }
    })
}

export function loadRecentEvents(kind: string, limit = 8): ActiveEvent[] {
  return getDb()
    .prepare(`
      SELECT kind, content, confidence, weight, started_at, created_at
      FROM events
      WHERE user_id = current_user_id() AND kind = ?
      ORDER BY created_at DESC, id DESC
      LIMIT ?
    `)
    .all(kind, limit)
    .map((row) => {
      const typed = row as { kind: string; content: string; confidence?: number; weight?: number; started_at?: string; created_at?: string }
      return {
        kind: typed.kind,
        content: typed.content,
        confidence: typed.confidence,
        weight: typed.weight,
        startedAt: typed.started_at,
        createdAt: typed.created_at,
      }
    })
}

export function getCorrectionEventCount(): number {
  const row = getDb()
    .prepare(`
      SELECT COUNT(*) AS total
      FROM events
      WHERE user_id = current_user_id()
        AND kind = 'correction'
    `)
    .get() as { total?: number } | undefined
  return Number(row?.total ?? 0)
}

export function getLatestCorrectionCreatedAt(): string | null {
  const row = getDb()
    .prepare(`
      SELECT MAX(created_at) AS created_at
      FROM events
      WHERE user_id = current_user_id()
        AND kind = 'correction'
    `)
    .get() as { created_at?: string | null } | undefined
  return row?.created_at ?? null
}
