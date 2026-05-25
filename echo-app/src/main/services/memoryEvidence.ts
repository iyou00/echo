import type { TasteProfile } from '../../types/ipc'
import { loadRecentEvents } from '../db/events'
import { getFeedbackSignalCount, getLatestFeedbackUpdatedAt } from '../db/feedback'

function compactLine(text: string, limit = 140): string {
  const clean = text.replace(/\s+/g, ' ').trim()
  return clean.length > limit ? `${clean.slice(0, limit)}...` : clean
}

function formatDate(value?: string): string {
  if (!value) return '-'
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return value
  return `${date.getFullYear()}-${String(date.getMonth() + 1).padStart(2, '0')}-${String(date.getDate()).padStart(2, '0')}`
}

export function buildCorrectionEvidenceBlock(limit = 6): string {
  const corrections = loadRecentEvents('correction', limit)
  if (!corrections.length) return '(暂无明确纠正)'
  return corrections
    .map((event, index) => {
      const weight = typeof event.weight === 'number' ? event.weight.toFixed(2) : '-'
      return `${index + 1}. ${compactLine(event.content)} (weight:${weight}, date:${formatDate(event.createdAt ?? event.startedAt)})`
    })
    .join('\n')
}

export function buildMemoryEvidenceContract(): string {
  return [
    '用户明确纠正是最高优先级证据,用于限制画像、风信和聊天中的长期判断。',
    '单次播放和短期集中播放只能写成最近状态; 收藏、循环、多日重复和明确反馈可以写成稳定偏好。',
    '跳过、取消收藏和“这首不对”用于降低相似推荐权重,避免扩展成宽泛审美判断。',
    '证据不足时使用猜测语气,优先追问和观察。',
  ].join('\n')
}

export function buildProfileSignalAudit(profile: TasteProfile | null): string {
  if (!profile) return '(暂无画像)'
  const signalCount = getFeedbackSignalCount()
  const latestFeedbackAt = getLatestFeedbackUpdatedAt()
  const profileSignalCount = profile.profile_meta?.signalCount ?? 0
  const portraitSignalCount = profile.profile_meta?.portraitSignalCount ?? 0
  return [
    `feedback_signals_total: ${signalCount}`,
    `profile_structured_signal_count: ${profileSignalCount}`,
    `portrait_signal_count: ${portraitSignalCount}`,
    `latest_feedback_at: ${latestFeedbackAt ?? '-'}`,
    `structured_updated_at: ${profile.profile_meta?.structuredUpdatedAt ?? '-'}`,
    `portrait_updated_at: ${profile.profile_meta?.updatedAt ?? '-'}`,
  ].join('\n')
}

export function buildMemoryEvidencePrompt(profile: TasteProfile | null, options: { includeAudit?: boolean } = {}): string {
  const audit = options.includeAudit
    ? `

<signal_audit>
${buildProfileSignalAudit(profile)}
</signal_audit>`
    : ''

  return `<memory_evidence_contract>
${buildMemoryEvidenceContract()}
</memory_evidence_contract>

<user_corrections>
${buildCorrectionEvidenceBlock()}
</user_corrections>${audit}`
}
