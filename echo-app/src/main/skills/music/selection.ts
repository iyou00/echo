import type { Track } from '../../../types/ipc'
import {
  hasTrackIdentity,
  primaryArtist,
  trackIdentityKeys,
  trackIdentitySet,
} from './identity'

export interface DiverseTrackSelectionOptions {
  targetCount: number
  maxPerArtist?: number
  avoidArtists?: Iterable<string>
  excludeTracks?: Track[]
  allowAvoidedArtistFallback?: boolean
}

export function excludeTrackIdentities(tracks: Track[], blockedKeys: Set<string>): Track[] {
  if (blockedKeys.size === 0) return tracks
  return tracks.filter((track) => !hasTrackIdentity(blockedKeys, track))
}

export function excludeTracks(tracks: Track[], blockedTracks: Track[]): Track[] {
  return excludeTrackIdentities(tracks, trackIdentitySet(blockedTracks))
}

export function selectDiverseTracks(tracks: Track[], options: DiverseTrackSelectionOptions): Track[] {
  const target = Math.max(1, options.targetCount)
  const maxPerArtist = Math.max(1, options.maxPerArtist ?? 1)
  const avoidArtists = new Set(Array.from(options.avoidArtists ?? []).map(primaryArtist).filter(Boolean))
  const blockedKeys = trackIdentitySet(options.excludeTracks ?? [])
  const picked: Track[] = []
  const artistCounts = new Map<string, number>()

  function take(track: Track, allowAvoidedArtist: boolean): boolean {
    const artist = primaryArtist(track.artist)
    if (!allowAvoidedArtist && avoidArtists.has(artist)) return false
    if (hasTrackIdentity(blockedKeys, track)) return false
    const artistCount = artistCounts.get(artist) ?? 0
    if (artistCount >= maxPerArtist) return false
    picked.push(track)
    for (const key of trackIdentityKeys(track)) blockedKeys.add(key)
    artistCounts.set(artist, artistCount + 1)
    return picked.length >= target
  }

  for (const track of tracks) {
    if (take(track, false)) return picked
  }

  if (options.allowAvoidedArtistFallback) {
    for (const track of tracks) {
      if (take(track, true)) return picked
    }
  }

  return picked
}
