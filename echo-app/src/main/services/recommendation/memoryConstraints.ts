import type { TasteProfile, Track } from '../../../types/ipc'
import { getTasteProfile } from '../../db/taste'
import { loadTrustedCorrections } from '../memoryCorrections'
import { normalizeText } from './text'
import type { RecommendationIntent } from './intent'

export interface RecommendationMemoryConstraints {
  softenedArtists: string[]
  blockedTerms: string[]
  notes: string[]
}

const CORRECTION_SOFTEN_TERMS = /那几天|刚好|阶段|暂时|最近|只想|只是|不要总|别总|老是|一直|少推|少来|听腻|腻了|不喜欢|不爱听/
const EXPLICIT_BLOCK_PATTERNS = [
  /(?:不喜欢|不爱听|不要|别推|少推|少来点|少来|听腻了|腻了)\s*([^,，。.!！?？]{1,24})/,
  /([^,，。.!！?？]{1,24})(?:听腻了|腻了|少推|少来点)/,
]

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

function cleanTerm(value: string): string {
  return value
    .replace(/^(我|你|给我|再|总是|老是|一直|有点|很|太)\s*/, '')
    .replace(/(?:的)?(?:歌|歌曲|音乐|作品|这种|这类|那种|那类).*$/i, '')
    .replace(/[“”"'‘’《》]/g, '')
    .trim()
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
    if (term && normalizeText(term).length >= 2) terms.push(term)
  }
  return unique(terms)
}

function profileAntiPatternTerms(profile: TasteProfile | null): string[] {
  return unique((profile?.anti_patterns ?? [])
    .map((pattern) => cleanTerm(pattern.replace(/^(跳过|不喜欢|不爱听|少推|别推)[:：]/, '')))
    .filter((term) => normalizeText(term).length >= 2))
}

export function buildRecommendationMemoryConstraints(profile = getTasteProfile()): RecommendationMemoryConstraints {
  const corrections = loadTrustedCorrections(12)
  const artists = profileArtistNames(profile)
  const softenedArtists: string[] = []
  const blockedTerms: string[] = [...profileAntiPatternTerms(profile)]
  const notes: string[] = []

  for (const event of corrections) {
    const content = event.content.trim()
    if (!content) continue
    const normalizedContent = normalizeText(content)
    notes.push(content)
    blockedTerms.push(...extractBlockedTerms(content))
    if (!CORRECTION_SOFTEN_TERMS.test(content)) continue
    for (const artist of artists) {
      if (normalizedContent.includes(normalizeText(artist))) softenedArtists.push(artist)
    }
  }

  return {
    softenedArtists: unique(softenedArtists).slice(0, 8),
    blockedTerms: unique(blockedTerms).slice(0, 8),
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

export function recommendationMemoryConstraintScore(
  track: Track,
  intent: RecommendationIntent,
  constraints: RecommendationMemoryConstraints,
): number {
  if (intentExplicitlyRequests(track, intent)) return 0
  let score = 0
  for (const artist of constraints.softenedArtists) {
    if (artistMatches(track, artist)) score -= 4.5
  }
  const haystack = normalizeText(`${track.artist} ${track.title} ${track.album ?? ''}`)
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
  return !constraints.softenedArtists.some((item) => {
    const key = normalizeText(item)
    return key && (artistKey.includes(key) || key.includes(artistKey))
  })
}
