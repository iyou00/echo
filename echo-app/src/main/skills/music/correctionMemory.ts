import type { Track } from '../../../types/ipc'
import { trackIdentity } from '../../../shared/trackIdentity'
import type { MusicEntityConstraint } from './verifier'
import { normalizeText } from './identity'

interface MusicCorrectionEntry {
  requiredArtist?: string
  requiredTitle?: string
  excludedArtists: string[]
  excludedTrackKeys: string[]
  sourceText: string
  createdAt: number
}

const SESSION_TTL_MS = 60 * 60 * 1000
let entries: MusicCorrectionEntry[] = []
const CORRECTION_SIGNAL_PATTERN = /不是|不该是|错歌|错了|错误|放错|播错|找错|要的是|我要的是|应该是|原唱|版本|同名/i
const VERSION_SIGNAL_PATTERN = /原唱|版本|同名|那版|这版/i
const INVALID_ARTIST_PATTERN = /^(这首|这个|这歌|版本|歌名|歌曲|原唱|错|错的|错误|不对|不太对|放错|播错|不喜欢|不好听|没感觉|太吵|太慢|太快)$/

function now(): number {
  return Date.now()
}

function prune(): void {
  const cutoff = now() - SESSION_TTL_MS
  entries = entries.filter((entry) => entry.createdAt >= cutoff)
}

function artistParts(artist: string): string[] {
  return artist
    .split(/[/、,，&＋+]| feat\.?| ft\.?| and /i)
    .map((item) => item.trim())
    .filter(Boolean)
}

function isMusicCorrectionSignal(text: string): boolean {
  return CORRECTION_SIGNAL_PATTERN.test(text)
}

function artistLooksLike(value: string | undefined, expected: string | undefined): boolean {
  const artist = normalizeText(value ?? '')
  const query = normalizeText(expected ?? '')
  return Boolean(artist && query && (artist.includes(query) || query.includes(artist)))
}

function extractRequiredArtist(text: string): string | undefined {
  const patterns = [
    /(?:我要的是|要的是|应该是)\s*([A-Za-z0-9 .&'’\-\u4e00-\u9fa5]{1,40})(?:的|唱的|版本|那首|$)/i,
    /不是\s*[A-Za-z0-9 .&'’\-\u4e00-\u9fa5]{1,40}\s*(?:，|,)?\s*(?:是|要)\s*([A-Za-z0-9 .&'’\-\u4e00-\u9fa5]{1,40})/i,
  ]
  for (const pattern of patterns) {
    const match = text.match(pattern)
    const raw = match?.[1]?.trim()
    if (!raw) continue
    const artist = raw
      .replace(/^(歌手|艺人|乐队)/, '')
      .replace(/的$/, '')
      .trim()
    if (artist && !INVALID_ARTIST_PATTERN.test(artist) && !/这首|这个|版本|歌名|歌曲|原唱/.test(artist)) return artist
  }
  return undefined
}

function extractRequiredTitle(text: string): string | undefined {
  const quoted = text.match(/《([^》]{1,60})》/)?.[1]?.trim()
  if (quoted) return quoted
  const pairPatterns = [
    /(?:我要听|想听|想要听|要听|播放|放|放首|放一首|点播)\s*(?:的)?(?:是|就是)?\s*[A-Za-z0-9 .&'’\-\u4e00-\u9fa5]{1,40}的([^《》，。！？?！,.]{1,60})/i,
    /(?:我要的是|要的是|应该是)\s*[A-Za-z0-9 .&'’\-\u4e00-\u9fa5]{1,40}的([^《》，。！？?！,.]{1,60})/i,
  ]
  for (const pattern of pairPatterns) {
    const title = text.match(pattern)?.[1]?.trim()
    if (title) return title
  }
  return undefined
}

function extractExcludedArtists(text: string): string[] {
  const artists: string[] = []
  const negative = Array.from(text.matchAll(/不是\s*([A-Za-z0-9 .&'’\-\u4e00-\u9fa5]{1,40})(?:的|唱的|版本|，|,|。|$)/gi))
  for (const match of negative) {
    const artist = match[1]?.trim().replace(/的$/, '')
    if (artist && !INVALID_ARTIST_PATTERN.test(artist) && !/这个|这首|版本|歌名|歌曲/.test(artist)) artists.push(artist)
  }
  return artists
}

export function rememberMusicCorrection(input: {
  text: string
  currentTrack?: Track | null
  fallbackTitle?: string
  fallbackArtist?: string
}): MusicEntityConstraint | undefined {
  prune()
  const explicitTitle = extractRequiredTitle(input.text)
  const explicitExcludedArtists = extractExcludedArtists(input.text)
  const requiredArtist = extractRequiredArtist(input.text) ?? input.fallbackArtist
  const hasCorrectionSignal = isMusicCorrectionSignal(input.text)
    || Boolean(explicitTitle || explicitExcludedArtists.length > 0 || requiredArtist)
  if (!hasCorrectionSignal) return undefined
  const shouldReuseCurrentTitle = Boolean(
    !explicitTitle
    && (requiredArtist || explicitExcludedArtists.length > 0 || VERSION_SIGNAL_PATTERN.test(input.text)),
  )
  const requiredTitle = explicitTitle ?? (shouldReuseCurrentTitle ? input.fallbackTitle ?? input.currentTrack?.title : undefined)
  const currentArtistShouldBeExcluded = Boolean(
    input.currentTrack
    && requiredArtist
    && !artistParts(input.currentTrack.artist).some((artist) => artistLooksLike(artist, requiredArtist)),
  )
  const excludedArtists = [
    ...explicitExcludedArtists,
    ...(currentArtistShouldBeExcluded && input.currentTrack ? artistParts(input.currentTrack.artist) : []),
  ]
    .map((artist) => artist.trim())
    .filter(Boolean)
  const excludedTrackKeys = input.currentTrack ? [trackIdentity(input.currentTrack)] : []

  if (!requiredArtist && !requiredTitle && excludedArtists.length === 0 && excludedTrackKeys.length === 0) return undefined
  entries.unshift({
    requiredArtist,
    requiredTitle,
    excludedArtists,
    excludedTrackKeys,
    sourceText: input.text.slice(0, 240),
    createdAt: now(),
  })
  entries = entries.slice(0, 12)
  return currentMusicCorrectionConstraint()
}

export function currentMusicCorrectionConstraint(): MusicEntityConstraint | undefined {
  prune()
  const latest = entries[0]
  if (!latest) return undefined
  if (!latest.requiredArtist && !latest.requiredTitle && latest.excludedArtists.length === 0 && latest.excludedTrackKeys.length === 0) return undefined
  return {
    artistQuery: latest.requiredArtist,
    seedTitle: latest.requiredTitle,
    excludedArtists: latest.excludedArtists,
    excludedTrackKeys: latest.excludedTrackKeys,
  }
}

export function currentMusicCorrectionConstraintForQuery(query: string): MusicEntityConstraint | undefined {
  prune()
  const latest = entries[0]
  if (!latest) return undefined
  const compactQuery = normalizeText(query)
  const hasRequiredArtist = latest.requiredArtist ? compactQuery.includes(normalizeText(latest.requiredArtist)) : false
  const hasRequiredTitle = latest.requiredTitle ? compactQuery.includes(normalizeText(latest.requiredTitle)) : false
  const isContinuation = /这首|这歌|这个版本|这版|刚才|刚刚|原唱|版本|同名|重新|再找|继续|其他歌|这个歌手|这歌手|那首|那版/.test(query)
  if (!hasRequiredArtist && !hasRequiredTitle && !isContinuation) return undefined
  return currentMusicCorrectionConstraint()
}

export function clearMusicCorrectionMemory(): void {
  entries = []
}
