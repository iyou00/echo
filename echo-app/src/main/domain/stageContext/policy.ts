import type { StageContext, StageContextKind, StageContextProposal, StageState } from '../../../types/ipc'

const DEFAULT_STATE: StageState = {
  emotion: 'unknown',
  energy: 'unknown',
  interactionPreference: 'unknown',
  safety: 'normal',
}

const DEFAULT_SUMMARY: Record<StageContextKind, string> = {
  work: '正在工作',
  rest: '正在休息',
  commute: '正在通勤',
  sleep: '准备睡觉或正在休息',
  exercise: '正在运动',
  emotional_support: '此刻需要一些陪伴',
  other: '正在经历一个暂时阶段',
}

const KIND_TTL_CLASS: Record<StageContextKind, NonNullable<StageContextProposal['ttlClass']>> = {
  work: 'day',
  rest: 'day',
  commute: 'short',
  sleep: 'day',
  exercise: 'short',
  emotional_support: 'day',
  other: 'short',
}

const TTL_MS = {
  short: 3 * 60 * 60 * 1000,
  day: 8 * 60 * 60 * 1000,
  multi_day: 48 * 60 * 60 * 1000,
} as const

export type StageContextDecision =
  | { type: 'none' }
  | { type: 'end'; current: StageContext; endedAt: string; reason: 'user_ended' }
  | { type: 'upsert'; replaceCurrent: boolean; value: Omit<StageContext, 'id'> }

function cleanSummary(value: string | undefined): string | undefined {
  const summary = value?.replace(/\s+/g, ' ').trim()
  return summary ? summary.slice(0, 120) : undefined
}

export function normalizeStageContextProposal(
  proposal: StageContextProposal,
  allowedConversationIds: readonly number[] = proposal.evidenceConversationIds,
): StageContextProposal {
  const allowed = new Set(allowedConversationIds.filter(Number.isInteger))
  return {
    ...proposal,
    confidence: Math.max(0, Math.min(1, Number.isFinite(proposal.confidence) ? proposal.confidence : 0)),
    summary: cleanSummary(proposal.summary),
    evidenceConversationIds: [...new Set(proposal.evidenceConversationIds)]
      .filter((id) => Number.isInteger(id) && id > 0 && allowed.has(id))
      .slice(0, 8),
  }
}

export function decideStageContextChange(
  current: StageContext | null,
  rawProposal: StageContextProposal,
  now = new Date(),
): StageContextDecision {
  const proposal = normalizeStageContextProposal(rawProposal)
  const nowIso = now.toISOString()
  if (proposal.operation === 'none') return { type: 'none' }
  if (proposal.operation === 'end') {
    if (!current || proposal.confidence < 0.55) return { type: 'none' }
    return { type: 'end', current, endedAt: nowIso, reason: 'user_ended' }
  }
  if (proposal.confidence < 0.6) return { type: 'none' }

  const kind = proposal.kind ?? (proposal.operation === 'update' ? current?.kind : undefined)
  if (!kind) return { type: 'none' }
  const sameContext = Boolean(current && current.kind === kind)
  const ttlClass = proposal.ttlClass ?? KIND_TTL_CLASS[kind]
  const state = { ...DEFAULT_STATE, ...(sameContext ? current?.state : {}), ...proposal.statePatch }
  return {
    type: 'upsert',
    replaceCurrent: Boolean(current && !sameContext),
    value: {
      kind,
      status: 'active',
      summary: cleanSummary(proposal.summary) ?? (sameContext ? current?.summary : undefined) ?? DEFAULT_SUMMARY[kind],
      state,
      goal: proposal.goal ?? (sameContext ? current?.goal : undefined) ?? 'none',
      confidence: proposal.confidence,
      revision: sameContext ? (current?.revision ?? 0) + 1 : 1,
      startedAt: sameContext ? current!.startedAt : nowIso,
      lastActiveAt: nowIso,
      expiresAt: new Date(now.getTime() + TTL_MS[ttlClass]).toISOString(),
      endedAt: undefined,
      endReason: undefined,
    },
  }
}

export const stageContextPolicyTestHelpers = { DEFAULT_STATE, TTL_MS }
