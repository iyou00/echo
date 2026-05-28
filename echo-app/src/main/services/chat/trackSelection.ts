import type { Track } from '../../../types/ipc'
import { trackIdentity } from '../../../shared/trackIdentity'
import { resolvePlayableTrack } from '../../netease/music'
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

  for (const candidate of candidates) {
    const compactTitle = compactText(candidate.title)
    if (!compactTitle) continue
    for (const q of quoted) {
      if (q.compact === compactTitle) {
        pushIfNew(candidate, q.index)
        break
      }
    }
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

const ARTIST_LIKE_BLACKLIST = /^(换|放|先|接|来|播|挑|推|选|给|让|帮|叫|让我|那)/

function cleanMentionedArtist(value: string): string {
  return value
    .trim()
    .replace(/^(?:我给你接上|给你接上|先听|听|播放|放|来一首|来首|接上)/, '')
    .replace(/的$/, '')
    .trim()
}

function extractMentionedTracks(content: string): Track[] {
  const tracks: Track[] = []
  const seen = new Set<string>()

  const pairPattern = /(?:^|[，。；、\s])([A-Za-z0-9 .&'’\-\u4e00-\u9fa5]{1,32})的?《([^》]{1,40})》/g
  let match: RegExpExecArray | null
  while ((match = pairPattern.exec(content))) {
    const artistRaw = cleanMentionedArtist(match[1] ?? '')
    const title = match[2]?.trim()
    if (!artistRaw || !title) continue
    if (ARTIST_LIKE_BLACKLIST.test(artistRaw)) continue
    const key = `${artistRaw}::${title}`
    if (seen.has(key)) continue
    seen.add(key)
    tracks.push({
      title,
      artist: artistRaw,
      source: 'netease',
    })
  }

  const titlePattern = /《([^》]{1,40})》/g
  while ((match = titlePattern.exec(content))) {
    const title = match[1]?.trim()
    if (!title) continue
    if (tracks.some((existing) => existing.title === title)) continue
    const key = `::${title}`
    if (seen.has(key)) continue
    seen.add(key)
    tracks.push({
      title,
      artist: '',
      source: 'netease',
    })
  }

  return tracks
}

function assertTrackSelectionActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('任务已取消', 'AbortError')
}

async function resolveMentionedTracks(content: string, limit: number, constraint?: MusicEntityConstraint, signal?: AbortSignal): Promise<Track[]> {
  const mentioned = extractMentionedTracks(content)
  const resolved: Track[] = []
  for (const item of mentioned) {
    assertTrackSelectionActive(signal)
    if (resolved.length >= limit) break
    const track = await resolvePlayableTrack(item, {
      constraint,
      strictArtist: Boolean(constraint?.artistQuery || constraint?.verifiedArtistName),
      strictTitle: Boolean(constraint?.verifiedTrackTitle),
      signal,
    }).catch(() => null)
    assertTrackSelectionActive(signal)
    if (track) resolved.push(track)
  }
  return resolved
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

  if (tracks.length === 0 && !options.authRequired) {
    tracks.push(...await resolveMentionedTracks(options.content, options.targetCount, options.entityConstraint, options.signal))
  }

  return tracks
}
