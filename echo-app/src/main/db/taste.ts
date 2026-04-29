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

export function addTasteQuestion(kind: string, content: string, context: Record<string, unknown> = {}): void {
  getDb()
    .prepare('INSERT INTO taste_questions (user_id, kind, content, context_json) VALUES (1, ?, ?, ?)')
    .run(kind, content, JSON.stringify(context))
}

export function getPendingQuestions(limit = 3): TasteQuestion[] {
  return getDb()
    .prepare(
      `SELECT id, kind, content, status, answered_content
       FROM taste_questions
       WHERE user_id = 1 AND status = 'pending'
       ORDER BY created_at DESC
       LIMIT ?`,
    )
    .all(limit) as TasteQuestion[]
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
