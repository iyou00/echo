import type { ProfileInsight, ProfileInsightFeedbackAction, TasteProfile, TasteProfileVersion, TasteQuestion } from '../../types/ipc'
import { getDb } from './index'
import { parseJson } from './json'
import { clearRecommendationCache } from './recommendationCache'

export function getTasteProfile(): TasteProfile | null {
  const row = getDb().prepare('SELECT profile_json, summary FROM taste_profile WHERE user_id = current_user_id()').get() as { profile_json: string; summary?: string } | undefined
  if (!row) return null
  const profile = parseJson<TasteProfile | null>(row.profile_json, null, 'taste_profile.profile_json')
  if (!profile) return null
  return profile.work_summary || !row.summary ? profile : { ...profile, work_summary: row.summary }
}

export function saveTasteProfile(profile: TasteProfile, summary = ''): TasteProfile {
  const effectiveSummary = summary && summary !== profile.echo_portrait
    ? summary
    : profile.work_summary ?? summary
  const next = effectiveSummary ? { ...profile, work_summary: effectiveSummary } : profile
  getDb()
    .prepare(
      `INSERT INTO taste_profile (user_id, profile_json, summary, updated_at)
       VALUES (current_user_id(), ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(user_id) DO UPDATE SET profile_json = excluded.profile_json, summary = excluded.summary, updated_at = CURRENT_TIMESTAMP`,
    )
    .run(JSON.stringify(next), effectiveSummary || profile.echo_portrait)
  clearRecommendationCache()
  return next
}

export function saveTasteProfileVersion(profile: TasteProfile, summary: string, trigger: string): void {
  getDb()
    .prepare(`
      INSERT INTO taste_profile_versions (
        user_id, portrait, summary, profile_json, evidence_revision, trigger
      ) VALUES (current_user_id(), ?, ?, ?, ?, ?)
    `)
    .run(
      profile.echo_portrait,
      summary,
      JSON.stringify(profile),
      profile.profile_meta?.signalRevision ?? 0,
      trigger,
    )
  getDb()
    .prepare(`
      DELETE FROM taste_profile_versions
      WHERE user_id = current_user_id()
        AND id NOT IN (
          SELECT id FROM taste_profile_versions
          WHERE user_id = current_user_id()
          ORDER BY created_at DESC, id DESC
          LIMIT 24
        )
    `)
    .run()
}

export function publishTasteProfile(profile: TasteProfile, summary: string, trigger: string): TasteProfile {
  const database = getDb()
  return database.transaction(() => {
    const saved = saveTasteProfile(profile, summary)
    saveTasteProfileVersion(saved, summary, trigger)
    return saved
  })()
}

export function listTasteProfileVersions(limit = 12): TasteProfileVersion[] {
  const safeLimit = Math.max(1, Math.min(24, Math.floor(limit)))
  const rows = getDb().prepare(`
    SELECT id, portrait, summary, profile_json, evidence_revision, trigger, created_at
    FROM taste_profile_versions
    WHERE user_id = current_user_id()
    ORDER BY created_at DESC, id DESC
    LIMIT ?
  `).all(safeLimit) as Array<Record<string, unknown>>
  return rows.flatMap((row) => {
    const profile = parseJson<TasteProfile | null>(String(row.profile_json), null, 'taste_profile_versions.profile_json')
    if (!profile) return []
    return [{
      id: Number(row.id),
      portrait: String(row.portrait),
      summary: typeof row.summary === 'string' ? row.summary : undefined,
      profile,
      evidenceRevision: Number(row.evidence_revision ?? 0),
      trigger: typeof row.trigger === 'string' ? row.trigger : undefined,
      createdAt: String(row.created_at),
    }]
  })
}

export function restoreTasteProfileVersion(id: number): TasteProfile {
  const row = getDb().prepare(`
    SELECT summary, profile_json
    FROM taste_profile_versions
    WHERE user_id = current_user_id() AND id = ?
  `).get(id) as { summary?: string; profile_json: string } | undefined
  if (!row) throw new Error('画像版本不存在或已过期')
  const profile = parseJson<TasteProfile | null>(row.profile_json, null, 'taste_profile_versions.profile_json')
  if (!profile) throw new Error('画像版本内容损坏')
  return publishTasteProfile(profile, row.summary ?? profile.work_summary ?? profile.echo_portrait, 'restore')
}

export function saveProfileInsightFeedback(insight: ProfileInsight, action: ProfileInsightFeedbackAction): void {
  const retentionDays = action === 'temporary' ? 14 : 30
  getDb().prepare(`
    INSERT INTO taste_profile_insight_feedback (
      user_id, insight_id, action, kind, subject, direction, statement, expires_at
    ) VALUES (current_user_id(), ?, ?, ?, ?, ?, ?, datetime('now', ?))
    ON CONFLICT(user_id, insight_id) DO UPDATE SET
      action = excluded.action,
      kind = excluded.kind,
      subject = excluded.subject,
      direction = excluded.direction,
      statement = excluded.statement,
      created_at = CURRENT_TIMESTAMP,
      expires_at = excluded.expires_at
  `).run(insight.id, action, insight.kind, insight.subject, insight.direction, insight.statement, `+${retentionDays} days`)
}

export function listActiveProfileInsightFeedbackIds(): string[] {
  const rows = getDb().prepare(`
    SELECT insight_id
    FROM taste_profile_insight_feedback
    WHERE user_id = current_user_id() AND expires_at > CURRENT_TIMESTAMP
  `).all() as Array<{ insight_id: string }>
  return rows.map((row) => row.insight_id)
}

export function addTasteQuestion(kind: string, content: string, context: Record<string, unknown> = {}, expiresAt?: string): void {
  const existing = getDb()
    .prepare("SELECT id FROM taste_questions WHERE user_id = current_user_id() AND status = 'pending' AND content = ? LIMIT 1")
    .get(content) as { id: number } | undefined
  if (existing) return
  getDb()
    .prepare('INSERT INTO taste_questions (user_id, kind, content, context_json, expires_at) VALUES (current_user_id(), ?, ?, ?, ?)')
    .run(kind, content, JSON.stringify(context), expiresAt ?? null)
}

function toQuestion(row: Record<string, unknown>): TasteQuestion {
  let context: Record<string, unknown> | undefined
  if (typeof row.context_json === 'string' && row.context_json.trim()) {
    context = parseJson<Record<string, unknown> | undefined>(row.context_json, undefined, 'taste_questions.context_json')
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

export function getTasteQuestion(id: number): TasteQuestion | null {
  const row = getDb()
    .prepare(
      `SELECT id, kind, content, context_json, status, answered_content
       FROM taste_questions
       WHERE user_id = current_user_id() AND id = ?
       LIMIT 1`,
    )
    .get(id) as Record<string, unknown> | undefined
  return row ? toQuestion(row) : null
}

export function hasRecentTasteQuestionForTrack(kind: string, title: string, artist: string, days: number): boolean {
  const normalizedTitle = title.trim().toLowerCase()
  const normalizedArtist = artist.trim().toLowerCase()
  if (!normalizedTitle) return false
  const rows = getDb()
    .prepare(`
      SELECT context_json
      FROM taste_questions
      WHERE user_id = current_user_id()
        AND kind = ?
        AND datetime(created_at) >= datetime('now', ?)
    `)
    .all(kind, `-${days} days`) as Array<{ context_json?: string | null }>
  return rows.some((row) => {
    if (!row.context_json) return false
    try {
      const context = parseJson<Record<string, unknown>>(row.context_json, {}, 'taste_questions.context_json')
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
       WHERE user_id = current_user_id() AND status = 'pending'
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
       WHERE user_id = current_user_id() AND id = ?`,
    )
    .run(answer, id)
}

export function countTasteQuestionsAskedToday(): number {
  const row = getDb()
    .prepare(`
      SELECT COUNT(*) AS total
      FROM taste_question_prompts
      WHERE user_id = current_user_id()
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
      WHERE p.user_id = current_user_id() AND q.status = 'pending'
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
      WHERE user_id = current_user_id() AND conversation_id IS NOT NULL
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
      WHERE user_id = current_user_id() AND role = 'user' AND id > ?
    `)
    .get(conversationId) as { total: number }
  return row.total
}

export function hasTasteQuestionBeenAsked(questionId: number): boolean {
  const row = getDb()
    .prepare('SELECT id FROM taste_question_prompts WHERE user_id = current_user_id() AND question_id = ? LIMIT 1')
    .get(questionId) as { id: number } | undefined
  return Boolean(row)
}

export function markTasteQuestionAsked(questionId: number, conversationId: number): void {
  getDb()
    .prepare('INSERT INTO taste_question_prompts (user_id, question_id, conversation_id) VALUES (current_user_id(), ?, ?)')
    .run(questionId, conversationId)
}
