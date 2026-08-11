import type { Track } from '../../../types/ipc'
import { trackIdentity, type TrackIdentityInput } from '../../../shared/trackIdentity'
import type { MusicEntityResolution } from './entityResolver'
import { normalizeText, uniqueTracks } from './identity'

export interface MusicEntityConstraint {
  artistQuery?: string
  seedTitle?: string
  verifiedArtistName?: string
  verifiedTrackTitle?: string
  excludedArtists?: string[]
  excludedTrackKeys?: string[]
}

export interface TrackEntityMatchOptions {
  strictArtist?: boolean
  strictTitle?: boolean
}

export function constraintFromResolution(resolution?: MusicEntityResolution | null): MusicEntityConstraint | undefined {
  if (!resolution) return undefined
  const artistQuery = resolution.verifiedArtistName ?? resolution.artistQuery
  const seedTitle = resolution.verifiedTrackTitle ?? resolution.seedTitle
  if (!artistQuery && !seedTitle) return undefined
  return {
    artistQuery,
    seedTitle,
    verifiedArtistName: resolution.verifiedArtistName,
    verifiedTrackTitle: resolution.verifiedTrackTitle,
  }
}

export function mergeMusicEntityConstraints(
  base?: MusicEntityConstraint | null,
  override?: MusicEntityConstraint | null,
): MusicEntityConstraint | undefined {
  if (!base && !override) return undefined
  return {
    artistQuery: override?.artistQuery ?? base?.artistQuery,
    seedTitle: override?.seedTitle ?? base?.seedTitle,
    verifiedArtistName: override?.verifiedArtistName ?? base?.verifiedArtistName,
    verifiedTrackTitle: override?.verifiedTrackTitle ?? base?.verifiedTrackTitle,
    excludedArtists: [...(base?.excludedArtists ?? []), ...(override?.excludedArtists ?? [])],
    excludedTrackKeys: [...(base?.excludedTrackKeys ?? []), ...(override?.excludedTrackKeys ?? [])],
  }
}

function editDistance(left: string, right: string): number {
  const a = normalizeText(left)
  const b = normalizeText(right)
  if (!a) return b.length
  if (!b) return a.length
  const previous = Array.from({ length: b.length + 1 }, (_, index) => index)
  const current = Array.from({ length: b.length + 1 }, () => 0)
  for (let i = 1; i <= a.length; i += 1) {
    current[0] = i
    for (let j = 1; j <= b.length; j += 1) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      current[j] = Math.min(current[j - 1] + 1, previous[j] + 1, previous[j - 1] + cost)
    }
    previous.splice(0, previous.length, ...current)
  }
  return previous[b.length]
}

function closeEnough(left: string, right: string): boolean {
  const a = normalizeText(left)
  const b = normalizeText(right)
  if (!a || !b) return false
  if (a === b || a.includes(b) || b.includes(a)) return true
  const maxLength = Math.max(a.length, b.length)
  if (maxLength < 5) return false
  return editDistance(a, b) <= Math.max(1, Math.floor(maxLength * 0.16))
}

function artistParts(artist: string): string[] {
  return artist
    .split(/[/、,，&＋+]| feat\.?| ft\.?| and /i)
    .map((item) => item.trim())
    .filter(Boolean)
}

export function artistMatchesConstraint(artist: string, expected?: string): boolean {
  if (!expected) return true
  return artistParts(artist).some((part) => closeEnough(part, expected)) || closeEnough(artist, expected)
}

type VerifiableTrack = TrackIdentityInput

function violatesExclusions(track: VerifiableTrack, constraint: MusicEntityConstraint): boolean {
  const key = trackIdentity(track)
  if (constraint.excludedTrackKeys?.includes(key)) return true
  return (constraint.excludedArtists ?? []).some((artist) => artistMatchesConstraint(track.artist, artist))
}

function stripParentheses(text: string): string {
  return text.replace(/\([^)]*\)/g, '').replace(/（[^）]*）/g, '').trim()
}

export function titleMatchesConstraint(title: string, expected?: string, strict = false): boolean {
  if (!expected) return true
  const trackTitle = normalizeText(title)
  const targetTitle = normalizeText(expected)
  if (!trackTitle || !targetTitle) return false
  if (trackTitle === targetTitle) return true

  // Strip parenthetical data (e.g. subtitles, remix labels, live tags) and try again
  const cleanTrack = normalizeText(stripParentheses(title))
  const cleanTarget = normalizeText(stripParentheses(expected))
  if (cleanTrack && cleanTarget && cleanTrack === cleanTarget) return true

  return strict ? false : trackTitle.includes(targetTitle) || targetTitle.includes(trackTitle) || (!!cleanTrack && !!cleanTarget && (cleanTrack.includes(cleanTarget) || cleanTarget.includes(cleanTrack)))
}

export function trackMatchesMusicEntity(
  track: VerifiableTrack,
  constraint?: MusicEntityConstraint | null,
  options: TrackEntityMatchOptions = {},
): boolean {
  if (!constraint) return true
  if (violatesExclusions(track, constraint)) return false
  const titleOk = titleMatchesConstraint(track.title, constraint.verifiedTrackTitle ?? constraint.seedTitle, options.strictTitle || Boolean(constraint.verifiedTrackTitle))
  if (!titleOk) return false
  const expectedArtist = constraint.verifiedArtistName ?? constraint.artistQuery
  const artistOk = artistMatchesConstraint(track.artist, expectedArtist)
  return expectedArtist ? artistOk : !options.strictArtist || artistOk
}

export function filterTracksByMusicEntity<T extends Track>(
  tracks: T[],
  constraint?: MusicEntityConstraint | null,
  options: TrackEntityMatchOptions = {},
): T[] {
  if (!constraint) return tracks
  return uniqueTracks(tracks).filter((track) => trackMatchesMusicEntity(track, constraint, options)) as T[]
}
