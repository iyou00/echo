import type { Track } from '../../../types/ipc'
import { trackIdentity } from '../../../shared/trackIdentity'
import { type MusicEntityConstraint, filterTracksByMusicEntity } from '../../skills/music/verifier'

export interface TrackSelectionOptions {
  content: string
  candidates: Track[]
  targetCount: number
  explicit: boolean
  authRequired: boolean
  entityConstraint?: MusicEntityConstraint
  signal?: AbortSignal
}

function compactText(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[《》"'“”·.,，。!！?？()（）:：\-_]/g, '')
}

function artistParts(artist: string): string[] {
  return artist
    .split(/[/、,，&＋+]| feat\.?| ft\.?| and /i)
    .map(compactText)
    .filter((item) => item.length >= 2)
}

function textMentionsTrack(text: string, track: Track): boolean {
  const compactBody = compactText(text)
  const compactTitle = compactText(track.title)
  if (!compactTitle || !compactBody.includes(compactTitle)) return false
  const artists = artistParts(track.artist)
  return artists.length === 0 || artists.some((artist) => compactBody.includes(artist))
}

function pickCandidatesFromText(text: string, candidates: Track[], limit: number): Track[] {
  if (candidates.length === 0) return []
  const compactBody = compactText(text)
  const quoted = Array.from(text.matchAll(/《([^》]+)》/g))
    .map((match) => ({ compact: compactText(match[1] ?? ''), index: match.index ?? 0 }))
    .filter((item) => item.compact.length > 0)

  const seen = new Set<string>()
  const picked: Array<{ track: Track; order: number }> = []

  function pushIfNew(track: Track, order: number) {
    const key = trackIdentity(track)
    if (seen.has(key)) return
    seen.add(key)
    picked.push({ track, order })
  }

  for (const q of quoted) {
    const titleMatches = candidates.filter((candidate) => compactText(candidate.title) === q.compact)
    if (titleMatches.length === 0) continue
    const artistMatch = titleMatches.find((candidate) => textMentionsTrack(text, candidate))
    pushIfNew(artistMatch ?? titleMatches[0], q.index)
  }

  for (const candidate of candidates) {
    const compactTitle = compactText(candidate.title)
    if (!compactTitle || compactTitle.length < 3) continue
    const offset = compactBody.indexOf(compactTitle)
    if (offset >= 0) pushIfNew(candidate, offset + 100000)
  }

  for (const q of quoted) {
    if (q.compact.length < 3) continue
    for (const candidate of candidates) {
      const compactTitle = compactText(candidate.title)
      if (!compactTitle || compactTitle.length < 3) continue
      if (compactTitle.includes(q.compact)) {
        pushIfNew(candidate, q.index + 200000)
        break
      }
    }
  }

  return picked.sort((a, b) => a.order - b.order).map((item) => item.track).slice(0, limit)
}

export async function selectTracksForChatResponse(options: TrackSelectionOptions): Promise<Track[]> {
  const tracks: Track[] = []
  const constrainedCandidates = filterTracksByMusicEntity(options.candidates, options.entityConstraint, {
    strictArtist: Boolean(options.entityConstraint?.artistQuery || options.entityConstraint?.verifiedArtistName),
  })

  if (constrainedCandidates.length > 0) {
    const picked = pickCandidatesFromText(options.content, constrainedCandidates, options.targetCount)
    if (picked.length > 0) tracks.push(...picked)
    else if (constrainedCandidates.length === 1) tracks.push(constrainedCandidates[0])

    if (options.explicit && tracks.length < options.targetCount) {
      const existing = new Set(tracks.map(trackIdentity))
      tracks.push(...constrainedCandidates.filter((track) => !existing.has(trackIdentity(track))).slice(0, options.targetCount - tracks.length))
    }
  }

  return tracks
}
