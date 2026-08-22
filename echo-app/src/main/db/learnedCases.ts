import { randomUUID } from 'node:crypto'
import { getDb } from './index'
import { parseJson } from './json'

export type LearnedCaseKind = 'entity_correction' | 'phrasing_precedent' | 'artist_alias'
export type LearnedCaseStatus = 'pending' | 'active' | 'retired' | 'deleted'

export interface LearnedCaseEvidence {
  conversationIds: number[]
  quotes: string[]
  sourceDate: string
}

export interface LearnedCaseRecord {
  id: string
  kind: LearnedCaseKind
  triggerText: string
  learned: Record<string, unknown>
  evidence: LearnedCaseEvidence
  confidence: number
  status: LearnedCaseStatus
  corroborations: number
  hitCount: number
  sourceDate: string
  createdAt: string
  updatedAt: string
}

interface LearnedCaseRow {
  id: string
  kind: string
  trigger_text: string
  learned_json: string
  evidence_json: string
  confidence: number
  status: string
  corroborations: number
  hit_count: number
  source_date: string
  created_at: string
  updated_at: string
}

const KINDS = new Set<LearnedCaseKind>(['entity_correction', 'phrasing_precedent', 'artist_alias'])
const STATUSES = new Set<LearnedCaseStatus>(['pending', 'active', 'retired', 'deleted'])

export const LEARNED_CASES_ACTIVE_LIMIT = 50
export const LEARNED_CASES_DECAY_DAYS = 30

function toRecord(row: LearnedCaseRow): LearnedCaseRecord {
  return {
    id: row.id,
    kind: (KINDS.has(row.kind as LearnedCaseKind) ? row.kind : 'phrasing_precedent') as LearnedCaseKind,
    triggerText: row.trigger_text,
    learned: parseJson<Record<string, unknown>>(row.learned_json, {}, 'learned_cases.learned_json'),
    evidence: parseJson<LearnedCaseEvidence>(row.evidence_json, { conversationIds: [], quotes: [], sourceDate: row.source_date }, 'learned_cases.evidence_json'),
    confidence: row.confidence,
    status: (STATUSES.has(row.status as LearnedCaseStatus) ? row.status : 'retired') as LearnedCaseStatus,
    corroborations: row.corroborations,
    hitCount: row.hit_count ?? 0,
    sourceDate: row.source_date,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

export function incrementLearnedCaseHit(id: string): void {
  getDb().prepare('UPDATE learned_cases SET hit_count = COALESCE(hit_count, 0) + 1, updated_at = CURRENT_TIMESTAMP WHERE id = ?').run(id)
}

export function insertLearnedCase(input: {
  kind: LearnedCaseKind
  triggerText: string
  learned: Record<string, unknown>
  evidence: LearnedCaseEvidence
  confidence: number
  status: LearnedCaseStatus
}): LearnedCaseRecord {
  const id = randomUUID()
  getDb()
    .prepare(
      `INSERT INTO learned_cases (id, user_id, kind, trigger_text, learned_json, evidence_json, confidence, status, corroborations, source_date)
       VALUES (?, current_user_id(), ?, ?, ?, ?, ?, ?, 0, ?)`,
    )
    .run(id, input.kind, input.triggerText.slice(0, 120), JSON.stringify(input.learned), JSON.stringify(input.evidence), input.confidence, input.status, input.evidence.sourceDate)
  return getLearnedCaseById(id) as LearnedCaseRecord
}

export function getLearnedCaseById(id: string): LearnedCaseRecord | null {
  const row = getDb().prepare('SELECT * FROM learned_cases WHERE user_id = current_user_id() AND id = ?').get(id) as LearnedCaseRow | undefined
  return row ? toRecord(row) : null
}

export function listLearnedCases(statuses: LearnedCaseStatus[]): LearnedCaseRecord[] {
  const placeholders = statuses.map(() => '?').join(', ')
  const rows = getDb()
    .prepare(`SELECT * FROM learned_cases WHERE user_id = current_user_id() AND status IN (${placeholders}) ORDER BY updated_at DESC`)
    .all(...statuses) as LearnedCaseRow[]
  return rows.map(toRecord)
}

export function countActiveLearnedCases(): number {
  const row = getDb().prepare("SELECT COUNT(*) AS n FROM learned_cases WHERE user_id = current_user_id() AND status = 'active'").get() as { n: number }
  return row.n
}

/** 规范化 learned 内容用于佐证匹配：键排序 + 值字符串化的稳定形态。 */
export function learnedCaseFingerprint(record: Pick<LearnedCaseRecord, 'kind' | 'learned'>): string {
  const stable = Object.keys(record.learned).sort()
    .map((key) => `${key}=${String(record.learned[key] ?? '')}`)
    .join('|')
  return `${record.kind}::${stable}`
}

export function corroborateLearnedCase(id: string): LearnedCaseRecord | null {
  getDb()
    .prepare(
      `UPDATE learned_cases
       SET corroborations = corroborations + 1,
           status = CASE WHEN status = 'pending' AND corroborations + 1 >= 2 THEN 'active' ELSE status END,
           updated_at = CURRENT_TIMESTAMP
       WHERE user_id = current_user_id() AND id = ?`,
    )
    .run(id)
  return getLearnedCaseById(id)
}

export function setLearnedCaseStatus(id: string, status: LearnedCaseStatus): LearnedCaseRecord | null {
  getDb()
    .prepare('UPDATE learned_cases SET status = ?, updated_at = CURRENT_TIMESTAMP WHERE user_id = current_user_id() AND id = ?')
    .run(status, id)
  return getLearnedCaseById(id)
}

/** 夜跑顺带的衰减：active 且超过 decayDays 无更新（佐证/命中都会刷新 updated_at）→ retired。返回退役数。 */
export function pruneDecayedLearnedCases(now = new Date(), decayDays = LEARNED_CASES_DECAY_DAYS): number {
  const cutoff = new Date(now.getTime() - decayDays * 24 * 60 * 60 * 1000).toISOString().replace('T', ' ').slice(0, 19)
  const result = getDb()
    .prepare("UPDATE learned_cases SET status = 'retired' WHERE user_id = current_user_id() AND status = 'active' AND updated_at < ?")
    .run(cutoff)
  return result.changes
}

/** active 超上限时按最旧退役，返回退役数。 */
export function enforceLearnedCasesLimit(limit = LEARNED_CASES_ACTIVE_LIMIT): number {
  const excess = countActiveLearnedCases() - limit
  if (excess <= 0) return 0
  const result = getDb()
    .prepare(
      `UPDATE learned_cases SET status = 'retired'
       WHERE user_id = current_user_id() AND status = 'active'
         AND id IN (
           SELECT id FROM learned_cases WHERE user_id = current_user_id() AND status = 'active'
           ORDER BY updated_at ASC LIMIT ?
         )`,
    )
    .run(excess)
  return result.changes
}
