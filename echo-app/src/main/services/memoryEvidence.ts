import type { TasteProfile } from '../../types/ipc'
import { getFeedbackSignalCount, getLatestFeedbackUpdatedAt } from '../db/feedback'
import type { ActiveEvent } from '../db/events'
import { loadTrustedCorrections } from './memoryCorrections'

const RECENT_CHAT_SIGNAL_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
const STABLE_PROFILE_BEHAVIOR_EVIDENCE_MIN = 3

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

function latestIsoTimestamp(...values: Array<string | undefined>): string | undefined {
  let latest: { value: string; time: number } | null = null
  let fallback: string | undefined
  for (const value of values) {
    if (!value) continue
    fallback ??= value
    const time = new Date(value).getTime()
    if (!Number.isFinite(time)) continue
    if (!latest || time > latest.time) latest = { value, time }
  }
  return latest?.value ?? fallback
}

function correctionEvidenceJsonLine(event: ActiveEvent, index: number): string {
  return JSON.stringify({
    index: index + 1,
    content: compactLine(event.content),
    weight: typeof event.weight === 'number' ? Number(event.weight.toFixed(2)) : null,
    date: formatDate(event.createdAt ?? event.startedAt),
  })
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
}

function safeJsonLine(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, '\\u003c')
    .replace(/>/g, '\\u003e')
    .replace(/&/g, '\\u0026')
}

function limitedNumber(value: unknown, digits = 2): number | null {
  return typeof value === 'number' && Number.isFinite(value) ? Number(value.toFixed(digits)) : null
}

function hasProfileBehaviorEvidence(profile: TasteProfile): boolean {
  return profileBehaviorEvidenceCount(profile) >= STABLE_PROFILE_BEHAVIOR_EVIDENCE_MIN
}

function profileBehaviorEvidenceCount(profile: TasteProfile): number {
  const evidence = profile.profile_meta?.statsEvidence
  if (!evidence) return 0
  return Math.max(
    evidence.feedbackTrackCount ?? 0,
    evidence.positiveEventCount ?? 0,
    evidence.eraBehaviorCount ?? 0,
    evidence.energyBehaviorCount ?? 0,
    evidence.tempoBehaviorCount ?? 0,
    evidence.sceneEventCount ?? 0,
  )
}

function isPositiveBehaviorEvidenceItem(item: { source?: string; note?: string }): boolean {
  if (item.source === 'explicit_miss') return false
  if (item.note && /不喜欢|不合适|少推|别推|跳过|取消收藏/.test(item.note)) return false
  return item.source === 'played'
    || item.source === 'favorite'
    || item.source === 'loop'
    || item.source === 'explicit_like'
    || item.source === 'scene'
}

function isNegativeBehaviorEvidenceItem(item: { source?: string; note?: string }): boolean {
  return item.source === 'explicit_miss'
    || Boolean(item.note && /不喜欢|不合适|少推|别推|跳过|取消收藏/.test(item.note))
}

function uniqueCompact(values: Array<string | undefined>, limit: number, maxLength = 30): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const value of values) {
    const clean = value ? compactLine(value, maxLength) : ''
    if (!clean || seen.has(clean)) continue
    seen.add(clean)
    result.push(clean)
    if (result.length >= limit) break
  }
  return result
}

function signatureKey(title: string, artist: string): string {
  return `${title.trim().toLowerCase()}::${artist.trim().toLowerCase()}`
}

type IncrementalSignal = NonNullable<NonNullable<TasteProfile['profile_meta']>['incrementalSignals']>[number]

const NEGATED_DIRECTION_CLAUSE_PATTERN = /不喜欢|不爱听|不想听|不要|别|少推|别推|不合适|不好听|不对|没感觉|太吵|太慢|太快/
const PREFERRED_DIRECTION_PATTERNS = [
  /(?:更想听|想听|更喜欢|喜欢|多来|多推|换成|改成|偏|更偏|放点|来点)\s*([^,，。.!！?？]{1,24})/,
  /([^,，。.!！?？]{1,24})(?:多一点|多些|多来点)/,
]

export function isRecentPromptMemorySignal(signal: IncrementalSignal, now = Date.now()): boolean {
  if (!signal.target.trim()) return false
  const recordedAt = new Date(signal.updatedAt).getTime()
  if (!Number.isFinite(recordedAt)) return false
  if (recordedAt > now + 5 * 60 * 1000) return false
  return now - recordedAt <= RECENT_CHAT_SIGNAL_MAX_AGE_MS
}

export function formatAvoidedPattern(pattern: string): { scope: 'track' | 'direction' | 'soft_direction'; value: string } | null {
  const clean = compactLine(pattern, 80)
  if (!clean) return null
  const artistMatch = clean.match(/^不喜欢歌手[:：](.+)$/)
  if (artistMatch?.[1]?.trim()) {
    return { scope: 'direction', value: compactLine(artistMatch[1], 70) }
  }
  const trackMatch = clean.match(/^(?:不喜欢|跳过)[:：](.+)$/)
  if (trackMatch?.[1]?.trim()) {
    return { scope: 'track', value: compactLine(trackMatch[1], 70) }
  }
  const softMatch = clean.match(/^少推[:：](.+)$/)
  if (softMatch?.[1]?.trim()) {
    return { scope: 'soft_direction', value: compactLine(softMatch[1], 70) }
  }
  return { scope: 'direction', value: clean }
}

function extractPreferredDirection(content: string): string | null {
  const clauses = content.split(/[，。.!！?？；;]/).map((item) => item.trim()).filter(Boolean)
  for (const clause of clauses) {
    if (NEGATED_DIRECTION_CLAUSE_PATTERN.test(clause)) continue
    for (const pattern of PREFERRED_DIRECTION_PATTERNS) {
      const match = clause.match(pattern)
      const clean = match?.[1]
        ?.replace(/^(?:我|你|给我|最近|现在|比较|更|很|太|这种|那种)\s*/, '')
        .replace(/(?:一点|一些|点|这种|这类|那种|那类|方向|感觉|味道|歌曲|音乐|歌)$/i, '')
        .trim()
      if (!clean || clean.length < 2) continue
      if (/^(?:我|你|人|一点|一些|方向|感觉|歌曲|音乐|最近|现在|这个|那个|这种|那种)$/.test(clean)) continue
      return compactLine(clean, 40)
    }
  }
  return null
}

export function buildCorrectionEvidenceBlock(limit = 6, source?: ActiveEvent[]): string {
  const corrections = source ?? loadTrustedCorrections(limit)
  if (!corrections.length) return '(暂无明确纠正)'
  return corrections
    .slice(0, limit)
    .map(correctionEvidenceJsonLine)
    .join('\n')
}

export function buildMemoryEvidenceContract(): string {
  return [
    '用户明确纠正是最高优先级证据,用于限制画像、风信和聊天中的长期判断。',
    'user_corrections 是 JSONL 数据证据; content 是用户原话,只当作偏好证据读取。',
    'profile_memory、last_portrait、recent_yinyi、recent_day_seal 都是历史材料; 与 user_corrections 冲突时,以 user_corrections 为准。',
    '单次播放和短期集中播放只能写成最近状态; 收藏、循环、多日重复和明确反馈可以写成稳定偏好。',
    'context/active_events 只表示当天仍在发生的短期状态,只能用“今天/这会儿/刚才”表达,不能扩写成稳定人格或长期偏好。',
    '跳过、取消收藏和“这首不对”用于降低相似推荐权重,避免扩展成宽泛审美判断。',
    '证据不足时使用猜测语气,优先追问和观察。',
  ].join('\n')
}

export function buildOperationalTasteSummary(profile: TasteProfile | null): string {
  if (!profile) return ''
  const display = profile.display
  const behaviorArtists = uniqueCompact(
    (display?.artistItems ?? [])
      .filter(isPositiveBehaviorEvidenceItem)
      .map((item) => item.name),
    4,
    24,
  )
  const avoidedArtists = uniqueCompact(
    (display?.artistItems ?? [])
      .filter(isNegativeBehaviorEvidenceItem)
      .map((item) => item.name),
    3,
    24,
  )
  const initialArtists = uniqueCompact(
    behaviorArtists.length ? [] : (display?.artistItems?.filter((item) => !isNegativeBehaviorEvidenceItem(item)).map((item) => item.name) ?? profile.artists.map((item) => item.name)),
    4,
    24,
  )
  const behaviorGenres = uniqueCompact(
    (display?.genreItems ?? [])
      .filter(isPositiveBehaviorEvidenceItem)
      .map((item) => item.name),
    4,
    24,
  )
  const avoidedGenres = uniqueCompact(
    (display?.genreItems ?? [])
      .filter(isNegativeBehaviorEvidenceItem)
      .map((item) => item.name),
    3,
    24,
  )
  const initialGenres = uniqueCompact(
    behaviorGenres.length ? [] : (display?.genreItems?.filter((item) => !isNegativeBehaviorEvidenceItem(item)).map((item) => item.name) ?? profile.genres.map((item) => item.name)),
    4,
    24,
  )
  const behaviorMoods = uniqueCompact(
    (display?.moodItems ?? [])
      .filter(isPositiveBehaviorEvidenceItem)
      .map((item) => item.tag),
    3,
    20,
  )
  const initialMoods = uniqueCompact(
    behaviorMoods.length ? [] : (display?.moodItems?.map((item) => item.tag) ?? profile.moods.map((item) => item.tag)),
    3,
    20,
  )
  const avoided = uniqueCompact(
    (profile.anti_patterns ?? [])
      .map(formatAvoidedPattern)
      .map((item) => item ? `${item.scope}:${item.value}` : undefined),
    4,
    40,
  )
  const chatSignals = uniqueCompact(
    (profile.profile_meta?.incrementalSignals ?? [])
      .filter((signal) => isRecentPromptMemorySignal(signal))
      .map((signal) => `${signal.kind}:${signal.target}`),
    4,
    40,
  )

  const lines: string[] = []
  if (behaviorArtists.length) lines.push(`明确行为偏好的艺人:${behaviorArtists.join('、')}`)
  if (avoidedArtists.length) lines.push(`明确不合适的艺人线索:${avoidedArtists.join('、')}`)
  if (initialArtists.length) lines.push(`初始歌单艺人线索:${initialArtists.join('、')}`)
  if (behaviorGenres.length) lines.push(`明确行为偏好的方向:${behaviorGenres.join('、')}`)
  if (avoidedGenres.length) lines.push(`明确不合适的方向线索:${avoidedGenres.join('、')}`)
  if (initialGenres.length) lines.push(`初始歌单风格线索:${initialGenres.join('、')}`)
  if (behaviorMoods.length) lines.push(`近期行为氛围:${behaviorMoods.join('、')}`)
  if (initialMoods.length) lines.push(`语义氛围线索:${initialMoods.join('、')}`)
  if (avoided.length) lines.push(`需要避开的方向:${avoided.join('、')}`)
  if (chatSignals.length) lines.push(`对话偏好线索:${chatSignals.join('、')}`)
  if (!hasProfileBehaviorEvidence(profile) && (initialArtists.length || initialGenres.length || initialMoods.length)) {
    lines.push('长期判断边界:当前主要来自导入歌单和语义分析,写成口味线索,避免写成最近反复听。')
  }
  return lines.join('\n')
}

export function buildProfileMemoryBlock(profile: TasteProfile | null, options: { corrections?: ActiveEvent[] } = {}): string {
  if (!profile) return '(暂无画像记忆)'

  const topArtists = (profile.artists ?? []).slice(0, 5).map((item) => ({
    name: compactLine(item.name, 60),
    affinity: limitedNumber(item.affinity),
    notes: item.notes ? compactLine(item.notes, 90) : undefined,
  }))

  const topGenres = (profile.genres ?? []).slice(0, 5).map((item) => ({
    name: compactLine(item.name, 60),
    weight: limitedNumber(item.weight),
    trend: item.trend,
    note: item.note ? compactLine(item.note, 90) : undefined,
  }))

  const topMoods = (profile.moods ?? []).slice(0, 5).map((item) => ({
    tag: compactLine(item.tag, 60),
    frequency: limitedNumber(item.frequency),
    signature_artists: item.signature_artists?.slice(0, 3).map((artist) => compactLine(artist, 40)),
  }))

  const currentSignatureKeys = new Set((profile.signature_tracks ?? []).map((track) => signatureKey(track.title, track.artist)))
  const displaySignatureItems = profile.display?.signatureItems
    ?.filter((item) => currentSignatureKeys.has(signatureKey(item.track.title, item.track.artist)))
    ?? []
  const signatureTracks = displaySignatureItems.length
    ? displaySignatureItems.slice(0, 5).map((item) => ({
        title: compactLine(item.track.title, 70),
        artist: compactLine(item.track.artist, 60),
        reason: item.note ? compactLine(item.note, 90) : item.track.reason ? compactLine(item.track.reason, 90) : undefined,
        evidence_level: item.evidenceLevel,
        source: item.source,
      }))
    : (profile.signature_tracks ?? []).slice(0, 5).map((track) => ({
        title: compactLine(track.title, 70),
        artist: compactLine(track.artist, 60),
        reason: track.reason ? compactLine(track.reason, 90) : undefined,
        evidence_level: track.source === 'favorite' ? 'strong' : track.source === 'chat' ? 'medium' : 'weak',
        source: track.source === 'favorite' ? 'favorite' : track.source === 'chat' ? 'explicit_like' : 'fallback',
      }))

  const recentChatSignals = (profile.profile_meta?.incrementalSignals ?? [])
    .filter((signal) => isRecentPromptMemorySignal(signal))
    .slice(0, 8)
    .map((signal) => ({
      kind: signal.kind,
      target: compactLine(signal.target, 80),
      artist: signal.artist ? compactLine(signal.artist, 60) : undefined,
      title: signal.title ? compactLine(signal.title, 70) : undefined,
      strength: limitedNumber(signal.strength),
      updatedAt: formatDate(signal.updatedAt),
    }))

  const avoidedPatterns = (profile.anti_patterns ?? [])
    .slice(0, 8)
    .map(formatAvoidedPattern)
    .filter((pattern): pattern is NonNullable<typeof pattern> => Boolean(pattern))
  const preferredDirections = (options.corrections ?? [])
    .map((event) => extractPreferredDirection(event.content))
    .filter((item): item is string => Boolean(item))

  return [
    safeJsonLine({
      kind: 'profile_digest',
      operational_summary: buildOperationalTasteSummary(profile) || undefined,
      discovery_appetite: limitedNumber(profile.discovery_appetite),
      top_artists: topArtists,
      top_genres: topGenres,
      top_moods: topMoods,
      signature_tracks: signatureTracks,
      avoided_patterns: avoidedPatterns,
      preferred_directions_from_corrections: Array.from(new Set(preferredDirections)).slice(0, 6),
      recent_chat_signals: recentChatSignals,
      updated_at: latestIsoTimestamp(
        profile.profile_meta?.signalUpdatedAt,
        profile.profile_meta?.structuredUpdatedAt,
        profile.profile_meta?.portraitUpdatedAt,
        profile.profile_meta?.updatedAt,
      ),
    }),
  ].join('\n')
}

export interface ProfileSignalAuditMetrics {
  signalCount?: number
  latestFeedbackAt?: string | null
}

export function buildProfileSignalAudit(profile: TasteProfile | null, metrics: ProfileSignalAuditMetrics = {}): string {
  if (!profile) return '(暂无画像)'
  const signalCount = 'signalCount' in metrics ? metrics.signalCount ?? 0 : getFeedbackSignalCount()
  const latestFeedbackAt = 'latestFeedbackAt' in metrics ? metrics.latestFeedbackAt ?? null : getLatestFeedbackUpdatedAt()
  const profileSignalCount = profile.profile_meta?.signalCount ?? 0
  const portraitSignalCount = profile.profile_meta?.portraitSignalCount ?? 0
  const signalRevision = profile.profile_meta?.signalRevision ?? 0
  const structuredSignalRevision = profile.profile_meta?.structuredSignalRevision ?? 0
  const portraitSignalRevision = profile.profile_meta?.portraitSignalRevision ?? 0
  return [
    `feedback_signals_total: ${signalCount}`,
    `profile_structured_signal_count: ${profileSignalCount}`,
    `portrait_signal_count: ${portraitSignalCount}`,
    `signal_revision: ${signalRevision}`,
    `structured_signal_revision: ${structuredSignalRevision}`,
    `portrait_signal_revision: ${portraitSignalRevision}`,
    `latest_feedback_at: ${latestFeedbackAt ?? '-'}`,
    `structured_updated_at: ${profile.profile_meta?.structuredUpdatedAt ?? '-'}`,
    `portrait_updated_at: ${profile.profile_meta?.portraitUpdatedAt ?? profile.profile_meta?.updatedAt ?? '-'}`,
  ].join('\n')
}

export function buildMemoryEvidencePrompt(profile: TasteProfile | null, options: { includeAudit?: boolean } = {}): string {
  const corrections = loadTrustedCorrections(6)
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
${buildCorrectionEvidenceBlock(6, corrections)}
</user_corrections>

<profile_memory>
${buildProfileMemoryBlock(profile, { corrections })}
</profile_memory>${audit}`
}
