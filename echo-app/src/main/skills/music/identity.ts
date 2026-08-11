import type { Track } from '../../../types/ipc'
import { semanticTrackKey } from '../../db/semantics'

export function unique<T>(items: T[]): T[] {
  return Array.from(new Set(items))
}

export function normalizeText(text: string): string {
  return text.toLowerCase().replace(/\s+/g, '').replace(/[《》"'“”·.,，。!！?？()（）-]/g, '')
}

export function trackKey(track: Track): string {
  return semanticTrackKey(track)
}

export function trackIdentityKeys(track: Track): string[] {
  const keys = new Set<string>()
  const neteaseId = String(track.neteaseId ?? '').trim()
  const id = String(track.id ?? '').trim()
  const title = normalizeText(track.title)
  const artist = normalizeText(track.artist)
  if (neteaseId) keys.add(`netease:${neteaseId}`)
  if (id) keys.add(`id:${id}`)
  if (title && artist) keys.add(`name:${title}::${artist}`)
  keys.add(trackKey(track))
  return Array.from(keys)
}

export function trackIdentitySet(tracks: Track[]): Set<string> {
  const keys = new Set<string>()
  for (const track of tracks) {
    for (const key of trackIdentityKeys(track)) keys.add(key)
  }
  return keys
}

export function hasTrackIdentity(keys: Set<string>, track: Track): boolean {
  return trackIdentityKeys(track).some((key) => keys.has(key))
}

export function uniqueTracks(tracks: Track[]): Track[] {
  const seen = new Set<string>()
  const result: Track[] = []
  for (const track of tracks) {
    if (hasTrackIdentity(seen, track)) continue
    for (const key of trackIdentityKeys(track)) seen.add(key)
    result.push(track)
  }
  return result
}

export function primaryArtist(artist: string): string {
  return artist.split(/[/、,，&＋+]| feat\.?| ft\.?| and /i)[0]?.trim().toLowerCase() ?? artist.trim().toLowerCase()
}

export function diversifyByArtist(tracks: Track[], maxPerArtist: number): Track[] {
  const artistCounts = new Map<string, number>()
  return tracks.filter((track) => {
    const key = primaryArtist(track.artist)
    const count = artistCounts.get(key) ?? 0
    if (count >= maxPerArtist) return false
    artistCounts.set(key, count + 1)
    return true
  })
}
