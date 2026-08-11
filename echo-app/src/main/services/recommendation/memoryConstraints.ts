import type { TasteProfile, Track } from '../../../types/ipc'
import { getTasteProfile } from '../../db/taste'
import { loadTrustedCorrections } from '../memoryCorrections'
import { normalizeText } from './text'
import type { RecommendationIntent } from './intent'

export interface RecommendationMemoryConstraints {
  softenedArtists: string[]
  blockedArtists: string[]
  softenedTerms: string[]
  preferredTerms: string[]
  blockedTerms: string[]
  notes: string[]
}

type PositiveOverrideScope = 'artist' | 'track' | 'term'

interface PositiveOverrideTerm {
  scope: PositiveOverrideScope
  value: string
  updatedAt?: number
}

interface AntiPatternTerm {
  scope: 'artist' | 'track' | 'term'
  value: string
  updatedAt?: number
}

const CORRECTION_SOFTEN_TERMS = /那几天|刚好|阶段|暂时|最近|只想|只是|不要总|别总|老是|一直|少推|少来|听腻|腻了|不喜欢|不爱听/
const BLOCKED_TERM_LIMIT = 14
const CHAT_POSITIVE_OVERRIDE_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
const EXPLICIT_BLOCK_PATTERNS = [
  /(?:不喜欢|不爱听|不要|别推|少推|少来点|少来|听腻了|腻了)\s*([^,，。.!！?？]{1,24})/,
  /([^,，。.!！?？]{1,24})(?:听腻了|腻了|少推|少来点)/,
  /(?:不是|并不是|别说|不要说|别老说|不要总说|别总说|别总觉得|不要总觉得|别觉得|别把我写成|别把我当成)\s*([^,，。.!！?？]{1,28})/,
]
const EXPLICIT_PREFER_PATTERNS = [
  /(?:更想听|想听|更喜欢|喜欢|多来|多推|换成|偏|更偏)\s*([^,，。.!！?？]{1,24})/,
  /([^,，。.!！?？]{1,24})(?:多一点|多些|多来点)/,
]
const NEGATED_PREFERRED_CLAUSE_PATTERN = /不喜欢|不爱听|不想听|不要|别|少推|别推|不合适|不好听|不对|没感觉|不是|并不是|刚好|只是|那几天/
const PROFILE_PERSON_DESCRIPTOR_PATTERN = /^(悲伤|伤感|低落|压抑|孤独|安静|舒缓|激烈|激情|高昂|轻快|开心|明亮|阴郁)(?=(?:的人|的人设|的用户|的人格|人|$))/
const GENERIC_CORRECTION_TERMS = new Set([
  '我',
  '你',
  '人',
  '一点',
  '一些',
  '方向',
  '感觉',
  '歌曲',
  '音乐',
  '最近',
  '现在',
  '这个',
  '那个',
  '这种',
  '那种',
])

function unique(items: string[]): string[] {
  const seen = new Set<string>()
  const result: string[] = []
  for (const item of items) {
    const normalized = normalizeText(item)
    if (!normalized || seen.has(normalized)) continue
    seen.add(normalized)
    result.push(item.trim())
  }
  return result
}

function constraintKey(value: string): string {
  return normalizeText(value).replace(/[/:：、|]/g, '')
}

function cleanTerm(value: string): string {
  let clean = value
    .replace(/^(我|你|给我|再|总是|老是|一直|有点|很|太)\s*/, '')
    .replace(/(?:的)?(?:歌曲|音乐|作品|歌)$/i, '')
    .replace(/[“”"'‘’《》]/g, '')
    .trim()
  const leadingNoise = /^(?:我|你|给我|说我|觉得我|把我写成|把我当成|一直|总是|老是|其实|只是|都是|是|很|特别|爱听|喜欢|偏爱|常听|总听|听|一点|一些|点|这种|这类|那种|那类|这个|那个|歌手|艺人|乐队|比较|太)\s*/
  for (let i = 0; i < 4; i += 1) {
    const next = clean.replace(leadingNoise, '').trim()
    if (next === clean) break
    clean = next
  }
  const profileDescriptor = clean.match(PROFILE_PERSON_DESCRIPTOR_PATTERN)?.[1]
  const stripped = clean
    .replace(/^(?:很|太|比较)?(?:吵|闷|炸|慢|快|悲伤|安静|舒缓|激烈|激情|高昂|刺耳|压迫|厚重|过亮|过暗)(?:的)?(?=.{2,}$)/, '')
    .replace(/(?:一点|一些|点|这种|这类|那种|那类|方向|感觉|味道)$/i, '')
    .trim()
  if (profileDescriptor && /^(?:的)?(?:人|用户|人格|人设)$/.test(stripped)) return profileDescriptor
  return stripped
}

function timestamp(value: string | undefined): number | undefined {
  if (!value) return undefined
  const time = new Date(value).getTime()
  return Number.isFinite(time) ? time : undefined
}

function isConcreteConstraintTerm(value: string): boolean {
  const key = normalizeText(value)
  if (key.length < 2 || GENERIC_CORRECTION_TERMS.has(key)) return false
  if (/^(?:的|地|得|很|太|比较|一直|总是|老是|刚好|只是|阶段性)$/.test(key)) return false
  return true
}

function positiveOverrideTerms(profile: TasteProfile | null): PositiveOverrideTerm[] {
  const terms: PositiveOverrideTerm[] = []
  const now = Date.now()
  for (const signal of profile?.profile_meta?.incrementalSignals ?? []) {
    const recordedAt = new Date(signal.updatedAt).getTime()
    if (!Number.isFinite(recordedAt) || recordedAt > now + 5 * 60 * 1000 || now - recordedAt > CHAT_POSITIVE_OVERRIDE_MAX_AGE_MS) continue
    if (signal.kind === 'like_artist') terms.push({ scope: 'artist', value: signal.target, updatedAt: recordedAt })
    if (signal.kind === 'like_genre' || signal.kind === 'reinforce_vibe') terms.push({ scope: 'term', value: signal.target, updatedAt: recordedAt })
    if (signal.kind === 'like_track') {
      terms.push({ scope: 'track', value: signal.target, updatedAt: recordedAt })
      if (signal.artist && signal.title) terms.push({ scope: 'track', value: `${signal.artist} ${signal.title}`, updatedAt: recordedAt })
      if (signal.title) terms.push({ scope: 'track', value: signal.title, updatedAt: recordedAt })
    }
  }
  for (const track of profile?.signature_tracks ?? []) {
    if (track.source !== 'favorite' && track.source !== 'chat') continue
    const recordedAt = timestamp(track.recommendedAt)
    if (track.source === 'chat') {
      if (!recordedAt || recordedAt > now + 5 * 60 * 1000 || now - recordedAt > CHAT_POSITIVE_OVERRIDE_MAX_AGE_MS) continue
    }
    const effectiveRecordedAt = track.source === 'favorite' && recordedAt == null ? now : recordedAt
    terms.push({ scope: 'track', value: [track.artist, track.title].filter(Boolean).join(' '), updatedAt: effectiveRecordedAt })
    terms.push({ scope: 'track', value: track.title, updatedAt: effectiveRecordedAt })
  }
  const seen = new Set<string>()
  return terms.filter((item) => {
    const key = `${item.scope}:${constraintKey(item.value)}`
    if (!constraintKey(item.value) || seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function isOverriddenByPositiveMemory(term: AntiPatternTerm, overrides: PositiveOverrideTerm[]): boolean {
  const termKey = constraintKey(term.value)
  if (!termKey) return false
  const isFreshOverride = (override: PositiveOverrideTerm): boolean => {
    if (term.updatedAt == null) return true
    if (override.updatedAt == null) return false
    return override.updatedAt > term.updatedAt
  }
  if (term.scope === 'track') {
    return overrides.some((override) => {
      if (override.scope !== 'track') return false
      if (!isFreshOverride(override)) return false
      const overrideKey = constraintKey(override.value)
      return Boolean(overrideKey && (overrideKey === termKey || overrideKey.includes(termKey) || termKey.includes(overrideKey)))
    })
  }

  return overrides.some((override) => {
    if (override.scope === 'track') return false
    if (!isFreshOverride(override)) return false
    const overrideKey = constraintKey(override.value)
    return Boolean(overrideKey && (overrideKey === termKey || overrideKey.includes(termKey) || termKey.includes(overrideKey)))
  })
}

function profileArtistNames(profile: TasteProfile | null): string[] {
  return unique([
    ...(profile?.artists ?? []).map((artist) => artist.name),
    ...(profile?.signature_tracks ?? []).map((track) => track.artist),
  ]).sort((a, b) => b.length - a.length)
}

function extractBlockedTerms(content: string): string[] {
  const terms: string[] = []
  for (const pattern of EXPLICIT_BLOCK_PATTERNS) {
    const match = content.match(pattern)
    const term = cleanTerm(match?.[1] ?? '')
    if (term && isConcreteConstraintTerm(term)) terms.push(term)
  }
  return unique(terms)
}

function extractPreferredTerms(content: string): string[] {
  const terms: string[] = []
  const clauses = content.split(/[，。.!！?？；;]/).map((item) => item.trim()).filter(Boolean)
  for (const clause of clauses) {
    if (NEGATED_PREFERRED_CLAUSE_PATTERN.test(clause)) continue
    for (const pattern of EXPLICIT_PREFER_PATTERNS) {
      const match = clause.match(pattern)
      const term = cleanTerm(match?.[1] ?? '')
      if (term && isConcreteConstraintTerm(term)) terms.push(term)
    }
  }
  return unique(terms)
}

function profileAntiPatternTerms(profile: TasteProfile | null): AntiPatternTerm[] {
  const knownArtists = new Set(profileArtistNames(profile).map(constraintKey).filter(Boolean))
  const terms = (profile?.anti_patterns ?? [])
    .filter((pattern) => !/^少推[:：]/.test(pattern.trim()))
    .map((pattern) => {
      const trimmed = pattern.trim()
      const value = cleanTerm(trimmed.replace(/^(跳过|不喜欢歌手|不喜欢|不爱听|少推|别推)[:：]/, ''))
      const valueKey = constraintKey(value)
      const trackLikeDislike = /^(跳过|不喜欢)[:：]/.test(trimmed)
        && (/\s/.test(value) || knownArtists.has(valueKey) || Array.from(knownArtists).some((artist) => valueKey.startsWith(artist) && valueKey.length > artist.length))
      const scope: AntiPatternTerm['scope'] = trackLikeDislike
        ? 'track'
        : /^不喜欢歌手[:：]/.test(trimmed) || knownArtists.has(constraintKey(value))
          ? 'artist'
          : 'term'
      return {
        scope,
        value,
        updatedAt: timestamp(profile?.anti_pattern_meta?.[trimmed]),
      }
    })
    .filter((term) => normalizeText(term.value).length >= 2)
  const seen = new Set<string>()
  return terms.filter((term) => {
    const key = `${term.scope}:${constraintKey(term.value)}`
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

function profileSoftPatternTerms(profile: TasteProfile | null): AntiPatternTerm[] {
  return unique((profile?.anti_patterns ?? [])
    .filter((pattern) => /^少推[:：]/.test(pattern.trim()))
    .map((pattern) => cleanTerm(pattern.replace(/^少推[:：]/, '')))
    .filter((term) => normalizeText(term).length >= 2))
    .map((value) => {
      const sourcePattern = (profile?.anti_patterns ?? []).find((pattern) => cleanTerm(pattern.replace(/^少推[:：]/, '')) === value)
      return { scope: 'term' as const, value, updatedAt: timestamp(sourcePattern ? profile?.anti_pattern_meta?.[sourcePattern] : undefined) }
    })
}

export function buildRecommendationMemoryConstraints(profile = getTasteProfile(), corrections = loadTrustedCorrections(12)): RecommendationMemoryConstraints {
  const artists = profileArtistNames(profile)
  const softenedArtists: string[] = []
  const profileSoftTerms = profileSoftPatternTerms(profile)
  const correctionPositiveOverrides: PositiveOverrideTerm[] = []
  const correctionBlockedTerms: string[] = []
  const correctionPreferredTerms: string[] = []
  const notes: string[] = []

  for (const event of corrections) {
    const content = event.content.trim()
    if (!content) continue
    const correctionUpdatedAt = timestamp(event.createdAt ?? event.startedAt)
    for (const term of extractPreferredTerms(content)) {
      correctionPositiveOverrides.push({ scope: 'term', value: term, updatedAt: correctionUpdatedAt })
    }
  }

  const overrideTerms = [...positiveOverrideTerms(profile), ...correctionPositiveOverrides]
  const profileBlockedTerms = profileAntiPatternTerms(profile)
    .filter((term) => !isOverriddenByPositiveMemory(term, overrideTerms))
  const profileBlockedArtists = profileBlockedTerms.filter((term) => term.scope === 'artist')
  const profileBlockedTrackAndTerms = profileBlockedTerms.filter((term) => term.scope !== 'artist')
  const effectiveProfileSoftTerms = profileSoftTerms
    .filter((term) => !isOverriddenByPositiveMemory(term, overrideTerms))

  for (const event of corrections) {
    const content = event.content.trim()
    if (!content) continue
    const normalizedContent = normalizeText(content)
    const correctionUpdatedAt = timestamp(event.createdAt ?? event.startedAt)
    notes.push(content)
    const correctionScope: AntiPatternTerm['scope'] = /《[^》]+》/.test(content) ? 'track' : 'term'
    correctionBlockedTerms.push(...extractBlockedTerms(content).filter((term) => !isOverriddenByPositiveMemory({ scope: correctionScope, value: term, updatedAt: correctionUpdatedAt }, overrideTerms)))
    correctionPreferredTerms.push(...extractPreferredTerms(content).filter((term) => !profileBlockedTerms.some((blocked) => constraintKey(blocked.value) === constraintKey(term))))
    if (!CORRECTION_SOFTEN_TERMS.test(content)) continue
    for (const artist of artists) {
      if (isOverriddenByPositiveMemory({ scope: 'term', value: artist }, overrideTerms)) continue
      if (normalizedContent.includes(normalizeText(artist))) softenedArtists.push(artist)
    }
  }

  return {
    softenedArtists: unique(softenedArtists).slice(0, 8),
    blockedArtists: unique(profileBlockedArtists.map((term) => term.value)).slice(0, 8),
    softenedTerms: effectiveProfileSoftTerms.map((term) => term.value).slice(0, 12),
    preferredTerms: unique(correctionPreferredTerms).slice(0, 8),
    blockedTerms: unique([...correctionBlockedTerms, ...profileBlockedTrackAndTerms.map((term) => term.value)]).slice(0, BLOCKED_TERM_LIMIT),
    notes: notes.slice(0, 6),
  }
}

function artistMatches(track: Track, artist: string): boolean {
  const artistKey = normalizeText(artist)
  const trackArtist = normalizeText(track.artist)
  if (!artistKey || !trackArtist) return false
  return trackArtist.includes(artistKey) || artistKey.includes(trackArtist)
}

function intentExplicitlyRequests(track: Track, intent: RecommendationIntent): boolean {
  const artistQuery = normalizeText(intent.artistQuery ?? '')
  const seedTitle = normalizeText(intent.seedTitle ?? '')
  if (artistQuery && normalizeText(track.artist).includes(artistQuery)) return true
  if (seedTitle && normalizeText(track.title).includes(seedTitle)) return true
  return false
}

function trackMemoryConstraintHaystack(track: Track): string {
  const semanticText = track.semantic
    ? [
        track.semantic.language,
        ...track.semantic.genres,
        ...track.semantic.moods,
        ...track.semantic.scenes,
        track.semantic.tempo,
      ].join(' ')
    : ''
  return normalizeText(`${track.artist} ${track.title} ${track.album ?? ''} ${semanticText}`)
}

function matchesBlockedTerm(track: Track, constraints: RecommendationMemoryConstraints): boolean {
  const haystack = trackMemoryConstraintHaystack(track)
  return constraints.blockedTerms.some((term) => {
    const key = normalizeText(term)
    return Boolean(key && haystack.includes(key))
  })
}

function matchesBlockedArtist(track: Track, constraints: RecommendationMemoryConstraints): boolean {
  return constraints.blockedArtists.some((artist) => artistMatches(track, artist))
}

function artistMatchesBlockedTerm(artist: string, term: string): boolean {
  const artistKey = normalizeText(artist)
  const key = normalizeText(term)
  return Boolean(artistKey && key && (artistKey === key || artistKey.includes(key)))
}

export function allowsTrackFromMemoryConstraints(
  track: Track,
  intent: RecommendationIntent,
  constraints: RecommendationMemoryConstraints,
): boolean {
  if (intentExplicitlyRequests(track, intent)) return true
  return !matchesBlockedArtist(track, constraints) && !matchesBlockedTerm(track, constraints)
}

export function recommendationMemoryConstraintScore(
  track: Track,
  intent: RecommendationIntent,
  constraints: RecommendationMemoryConstraints,
): number {
  if (intentExplicitlyRequests(track, intent)) return 0
  let score = 0
  for (const artist of constraints.blockedArtists) {
    if (artistMatches(track, artist)) score -= 7
  }
  for (const artist of constraints.softenedArtists) {
    if (artistMatches(track, artist)) score -= 4.5
  }
  const haystack = trackMemoryConstraintHaystack(track)
  for (const term of constraints.softenedTerms) {
    const key = normalizeText(term)
    if (key && haystack.includes(key)) score -= 2.2
  }
  for (const term of constraints.preferredTerms) {
    const key = normalizeText(term)
    if (key && haystack.includes(key)) score += 2.4
  }
  for (const term of constraints.blockedTerms) {
    const key = normalizeText(term)
    if (key && haystack.includes(key)) score -= 6
  }
  return score
}

export function allowsArtistFromCorrection(artist: string, intent: RecommendationIntent, constraints: RecommendationMemoryConstraints): boolean {
  const query = normalizeText(intent.artistQuery ?? '')
  const artistKey = normalizeText(artist)
  if (query && artistKey.includes(query)) return true
  if (constraints.blockedArtists.some((item) => artistMatchesBlockedTerm(artist, item))) return false
  if (constraints.blockedTerms.some((term) => artistMatchesBlockedTerm(artist, term))) return false
  return !constraints.softenedArtists.some((item) => {
    const key = normalizeText(item)
    return key && (artistKey.includes(key) || key.includes(artistKey))
  })
}
