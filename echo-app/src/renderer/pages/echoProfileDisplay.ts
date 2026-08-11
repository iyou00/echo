import type { TasteProfile } from '../../types/ipc'

function asPercent(value: number) {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(100, Math.round(value <= 1 ? value * 100 : value)))
}

export function percentDisplay(value: number, minBar = 3) {
  if (!Number.isFinite(value) || value <= 0) return { value: 0, label: '0%', bar: 0 }
  const clamped = Math.max(0, Math.min(100, value))
  const rounded = Math.round(clamped)
  return {
    value: rounded,
    label: rounded === 0 ? '<1%' : `${rounded}%`,
    bar: Math.max(minBar, rounded),
  }
}

export function profileWeightDisplay(value: number, minBar = 3) {
  if (!Number.isFinite(value)) return percentDisplay(0, minBar)
  return percentDisplay(value <= 1 ? value * 100 : value, minBar)
}

export function profileAsPercent(value: number) {
  return asPercent(value)
}

export type TempoPreferenceValue = 'slow' | 'medium' | 'fast'

export const ERA_SCALE = ['70s', '80s', '90s', '00s', '10s', '20s'] as const

export type EraScaleValue = typeof ERA_SCALE[number]

export function eraNeedleLeft(era: string): string {
  const index = ERA_SCALE.indexOf(era as EraScaleValue)
  if (index < 0) return '50%'
  if (ERA_SCALE.length <= 1) return '50%'
  return `${Math.round((index / (ERA_SCALE.length - 1)) * 100)}%`
}

export interface TempoDisplayEntry {
  tempo: TempoPreferenceValue
  rawValue: number
  percent: number
  label: string
  bar: number
}

export function tempoPreferenceDisplay(
  preference?: Partial<Record<TempoPreferenceValue, number>>,
  minBar = 3,
): TempoDisplayEntry[] {
  if (!preference) return []
  const entries = (['slow', 'medium', 'fast'] as const)
    .map((tempo) => ({
      tempo,
      rawValue: Number.isFinite(preference[tempo]) ? Math.max(0, preference[tempo] ?? 0) : 0,
    }))
    .filter((entry) => entry.rawValue > 0)
  const total = entries.reduce((sum, entry) => sum + entry.rawValue, 0)
  if (total <= 0) return []
  return entries
    .map((entry) => {
      const display = percentDisplay((entry.rawValue / total) * 100, minBar)
      return {
        ...entry,
        percent: display.value,
        label: display.label,
        bar: display.bar,
      }
    })
    .sort((a, b) => b.rawValue - a.rawValue)
}

export type ProfileStatsEvidence = NonNullable<NonNullable<TasteProfile['profile_meta']>['statsEvidence']>

export type ProfileTrendGenre = Pick<NonNullable<TasteProfile['display']>['genreItems'][number], 'name' | 'trend' | 'source' | 'evidenceLevel'>
export type ProfileMoodTrend = Pick<NonNullable<TasteProfile['display']>['moodItems'][number], 'tag' | 'frequency' | 'source' | 'evidenceLevel'>
export type ProfileEvidenceMarker = Pick<NonNullable<TasteProfile['display']>['genreItems'][number], 'source' | 'evidenceLevel'>
export type ProfileSignatureDisplayItem = NonNullable<TasteProfile['display']>['signatureItems'][number]
export type PortraitClueKind = 'artist' | 'genre'
const STABLE_PROFILE_BEHAVIOR_EVIDENCE_MIN = 3

export interface PortraitClueMatch {
  kind: PortraitClueKind
  name: string
}

function normalizePortraitClue(value: string): string {
  return value.replace(/["'「」“”《》]/g, '').trim().toLowerCase()
}

function isUsablePortraitClue(name: string, kind: PortraitClueKind): boolean {
  const normalized = normalizePortraitClue(name)
  if (normalized.length < 2) return false
  if (kind === 'artist') return true
  return normalized.length >= 3 || /[a-z0-9&/.-]/i.test(normalized)
}

export function findPortraitClueMatch(
  segment: string,
  artists: string[],
  genres: string[],
): PortraitClueMatch | null {
  const normalizedSegment = normalizePortraitClue(segment)
  if (normalizedSegment.length < 2) return null
  const artist = artists.find((name) => {
    const normalized = normalizePortraitClue(name)
    return isUsablePortraitClue(name, 'artist') && normalizedSegment.includes(normalized)
  })
  if (artist) return { kind: 'artist', name: artist }
  const genre = genres.find((name) => {
    const normalized = normalizePortraitClue(name)
    return isUsablePortraitClue(name, 'genre') && normalizedSegment.includes(normalized)
  })
  return genre ? { kind: 'genre', name: genre } : null
}

export function hasProfileBehaviorEvidence(evidence?: ProfileStatsEvidence): boolean {
  return profileBehaviorEvidenceCount(evidence) >= STABLE_PROFILE_BEHAVIOR_EVIDENCE_MIN
}

export function profileBehaviorEvidenceCount(evidence?: ProfileStatsEvidence): number {
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

export function profileItemHasBehaviorEvidence(item: ProfileEvidenceMarker): boolean {
  return item.source === 'played'
    || item.source === 'favorite'
    || item.source === 'loop'
    || item.source === 'explicit_like'
    || item.source === 'scene'
}

export function profileItemHasUserActionEvidence(item: ProfileEvidenceMarker): boolean {
  return profileItemHasBehaviorEvidence(item) || item.source === 'explicit_miss'
}

export function profileItemIsPositiveDisplaySignal(item: ProfileEvidenceMarker): boolean {
  return item.source !== 'explicit_miss'
}

export function profileSignatureItemVisible(item: ProfileSignatureDisplayItem, activeMoodFilter = 'all'): boolean {
  if (!profileItemIsPositiveDisplaySignal(item)) return false
  if (activeMoodFilter === 'all') return true
  return Boolean(
    item.track.profileEvidence?.moods?.includes(activeMoodFilter) ||
    item.track.semantic?.moods?.includes(activeMoodFilter) ||
    item.note?.includes(activeMoodFilter) ||
    item.track.reason?.includes(activeMoodFilter),
  )
}

export function profileEvidenceSourceLabel(item: ProfileEvidenceMarker, fallback = '还在观察'): string {
  if (item.source === 'favorite') return '来自收藏'
  if (item.source === 'loop') return '来自循环'
  if (item.source === 'played') return '来自播放'
  if (item.source === 'explicit_like') return '明确喜欢'
  if (item.source === 'explicit_miss') return '不合适线索'
  if (item.source === 'scene') return '场景行为'
  if (item.source === 'imported') return '来自导入歌单'
  if (item.source === 'semantic') return '语义线索'
  return fallback
}

export function profileSummaryCardMeta(item: ProfileEvidenceMarker | undefined, valueLabel: string, fallback = '还在观察'): string {
  if (!item) return fallback
  const source = profileEvidenceSourceLabel(item, fallback)
  if (!valueLabel) return source
  return `${valueLabel} · ${source}`
}

function hasMoodBehaviorEvidence(mood: ProfileMoodTrend, evidence?: ProfileStatsEvidence): boolean {
  void evidence
  return profileItemHasBehaviorEvidence(mood)
}

function hasTrendBehaviorEvidence(item: Pick<ProfileTrendGenre, 'source' | 'evidenceLevel'>, evidence?: ProfileStatsEvidence): boolean {
  void evidence
  if (item.source === 'played' || item.source === 'favorite' || item.source === 'loop' || item.source === 'explicit_like' || item.source === 'explicit_miss' || item.source === 'scene') return true
  return false
}

export function profileMoodLine(moods: ProfileMoodTrend[], evidence?: ProfileStatsEvidence): string {
  const top = moods[0]
  if (!top) return ''
  const percent = asPercent(top.frequency)
  if (hasMoodBehaviorEvidence(top, evidence) && percent >= 45) return `最近氛围：${top.tag}`
  return `氛围线索：${top.tag}`
}

export function profileEnergyLine(
  energyLabel: string,
  evidence?: ProfileStatsEvidence,
): string {
  const imported = evidence?.energyImportedCount ?? 0
  const behavior = evidence?.energyBehaviorCount ?? 0
  if (behavior >= 3) return `最近能量：${energyLabel}`
  if (behavior > 0) return `行为能量：${energyLabel}`
  if (imported > 0) return `歌单能量：${energyLabel}`
  return `能量线索：${energyLabel}`
}

export function profileChangeSectionCopy(hasBehaviorEvidence: boolean): { label: string; emptyText: string } {
  return hasBehaviorEvidence
    ? {
        label: '最近变化',
        emptyText: '最近还没有明显变化，画像会继续根据播放、收藏和切歌更新。',
      }
    : {
        label: '初始线索',
        emptyText: '导入和语义线索还不够多，画像会继续根据播放、收藏和切歌更新。',
      }
}

export function profileTrendLines(
  genres: ProfileTrendGenre[],
  options: {
    evidence?: ProfileStatsEvidence
    moodLine?: string
    energyLine?: string
  } = {},
): string[] {
  const risingGenres = genres.filter((genre) => genre.trend === 'up').slice(0, 3)
  const recentRisingGenres = risingGenres.filter((genre) => hasTrendBehaviorEvidence(genre, options.evidence))
  const importedRisingGenres = risingGenres.filter((genre) => !hasTrendBehaviorEvidence(genre, options.evidence))
  const fallingGenres = genres.filter((genre) => genre.trend === 'down' && hasTrendBehaviorEvidence(genre, options.evidence)).slice(0, 2)
  const lines = [
    recentRisingGenres.length
      ? `最近更明显：${recentRisingGenres.map((genre) => genre.name).join('、')}`
      : '',
    importedRisingGenres.length
      ? `歌单线索：${importedRisingGenres.map((genre) => genre.name).join('、')}`
      : '',
    fallingGenres.length ? `最近变少：${fallingGenres.map((genre) => genre.name).join('、')}` : '',
    options.moodLine ?? '',
    options.energyLine ?? '',
  ]
  return lines.filter(Boolean)
}
