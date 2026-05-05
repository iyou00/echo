import type { TasteProfile, TasteQuestion } from '../../types/ipc'
import { getDb } from './index'

export function getTasteProfile(): TasteProfile | null {
  const row = getDb().prepare('SELECT profile_json FROM taste_profile WHERE user_id = 1').get() as { profile_json: string } | undefined
  return row ? (JSON.parse(row.profile_json) as TasteProfile) : null
}

export function saveTasteProfile(profile: TasteProfile, summary = ''): TasteProfile {
  getDb()
    .prepare(
      `INSERT INTO taste_profile (user_id, profile_json, summary, updated_at)
       VALUES (1, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(user_id) DO UPDATE SET profile_json = excluded.profile_json, summary = excluded.summary, updated_at = CURRENT_TIMESTAMP`,
    )
    .run(JSON.stringify(profile), summary || profile.echo_portrait)
  return profile
}

export function addTasteQuestion(kind: string, content: string, context: Record<string, unknown> = {}, expiresAt?: string): void {
  const existing = getDb()
    .prepare("SELECT id FROM taste_questions WHERE user_id = 1 AND status = 'pending' AND content = ? LIMIT 1")
    .get(content) as { id: number } | undefined
  if (existing) return
  getDb()
    .prepare('INSERT INTO taste_questions (user_id, kind, content, context_json, expires_at) VALUES (1, ?, ?, ?, ?)')
    .run(kind, content, JSON.stringify(context), expiresAt ?? null)
}

function toQuestion(row: Record<string, unknown>): TasteQuestion {
  let context: Record<string, unknown> | undefined
  if (typeof row.context_json === 'string' && row.context_json.trim()) {
    try {
      context = JSON.parse(row.context_json) as Record<string, unknown>
    } catch {
      context = undefined
    }
  }
  return {
    id: Number(row.id),
    kind: String(row.kind),
    content: String(row.content),
    status: String(row.status) as TasteQuestion['status'],
    answered_content: typeof row.answered_content === 'string' ? row.answered_content : undefined,
    context,
  }
}

export function hasRecentTasteQuestionForTrack(kind: string, title: string, artist: string, days: number): boolean {
  const normalizedTitle = title.trim().toLowerCase()
  const normalizedArtist = artist.trim().toLowerCase()
  if (!normalizedTitle) return false
  const rows = getDb()
    .prepare(`
      SELECT context_json
      FROM taste_questions
      WHERE user_id = 1
        AND kind = ?
        AND datetime(created_at) >= datetime('now', ?)
    `)
    .all(kind, `-${days} days`) as Array<{ context_json?: string | null }>
  return rows.some((row) => {
    if (!row.context_json) return false
    try {
      const context = JSON.parse(row.context_json) as Record<string, unknown>
      const contextTitle = String(context.title ?? '').trim().toLowerCase()
      const contextArtist = String(context.artist ?? '').trim().toLowerCase()
      return contextTitle === normalizedTitle && (!normalizedArtist || contextArtist === normalizedArtist)
    } catch {
      return false
    }
  })
}

export function getPendingQuestions(limit = 3): TasteQuestion[] {
  const rows = getDb()
    .prepare(
      `SELECT id, kind, content, context_json, status, answered_content
       FROM taste_questions
       WHERE user_id = 1 AND status = 'pending'
         AND (expires_at IS NULL OR expires_at > CURRENT_TIMESTAMP)
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(limit) as Record<string, unknown>[]
  return rows.map(toQuestion)
}

export function answerTasteQuestion(id: number, answer: string): void {
  getDb()
    .prepare(
      `UPDATE taste_questions
       SET status = 'answered', answered_content = ?, answered_at = CURRENT_TIMESTAMP
       WHERE id = ?`,
    )
    .run(answer, id)
}

export function countTasteQuestionsAskedToday(): number {
  const row = getDb()
    .prepare(`
      SELECT COUNT(*) AS total
      FROM taste_question_prompts
      WHERE user_id = 1
        AND date(asked_at, 'localtime') = date('now', 'localtime')
    `)
    .get() as { total: number }
  return row.total
}

export function getLatestAskedPendingQuestion(): { question: TasteQuestion; conversationId: number | null } | null {
  const row = getDb()
    .prepare(`
      SELECT q.id, q.kind, q.content, q.context_json, q.status, q.answered_content, p.conversation_id
      FROM taste_question_prompts p
      JOIN taste_questions q ON q.id = p.question_id
      WHERE p.user_id = 1 AND q.status = 'pending'
      ORDER BY p.asked_at DESC, p.id DESC
      LIMIT 1
    `)
    .get() as (Record<string, unknown> & { conversation_id?: number | null }) | undefined
  if (!row) return null
  return {
    question: toQuestion(row),
    conversationId: typeof row.conversation_id === 'number' ? row.conversation_id : null,
  }
}

export function getLatestQuestionPromptConversationId(): number | null {
  const row = getDb()
    .prepare(`
      SELECT conversation_id
      FROM taste_question_prompts
      WHERE user_id = 1 AND conversation_id IS NOT NULL
      ORDER BY asked_at DESC, id DESC
      LIMIT 1
    `)
    .get() as { conversation_id?: number | null } | undefined
  return typeof row?.conversation_id === 'number' ? row.conversation_id : null
}

export function countUserMessagesAfterConversation(conversationId: number): number {
  const row = getDb()
    .prepare(`
      SELECT COUNT(*) AS total
      FROM conversations
      WHERE user_id = 1 AND role = 'user' AND id > ?
    `)
    .get(conversationId) as { total: number }
  return row.total
}

export function hasTasteQuestionBeenAsked(questionId: number): boolean {
  const row = getDb()
    .prepare('SELECT id FROM taste_question_prompts WHERE user_id = 1 AND question_id = ? LIMIT 1')
    .get(questionId) as { id: number } | undefined
  return Boolean(row)
}

export function markTasteQuestionAsked(questionId: number, conversationId: number): void {
  getDb()
    .prepare('INSERT INTO taste_question_prompts (user_id, question_id, conversation_id) VALUES (1, ?, ?)')
    .run(questionId, conversationId)
}
