import type { Track } from '../types/ipc'

export type TrackIdentityInput = Pick<Track, 'title' | 'artist'> & Partial<Pick<Track, 'id' | 'neteaseId'>>

export function normalizeTrackText(text: string): string {
  return text.trim().toLowerCase()
}

export function trackIdentity(track?: TrackIdentityInput | null): string {
  if (!track) return ''
  const neteaseId = String(track.neteaseId ?? '').trim()
  const id = String(track.id ?? '').trim()
  const unifiedId = neteaseId || id
  if (unifiedId) return `id:${unifiedId}`
  return `name:${normalizeTrackText(track.title)}::${normalizeTrackText(track.artist)}`
}

export function sameTrack(a?: TrackIdentityInput | null, b?: TrackIdentityInput | null): boolean {
  const left = trackIdentity(a)
  return Boolean(left && left === trackIdentity(b))
}
