import type { Track } from '../types/ipc'

export function trackIdentity(track?: Track | null): string {
  if (!track) return ''
  const neteaseId = String(track.neteaseId ?? '').trim()
  if (neteaseId) return `netease:${neteaseId}`
  const id = String(track.id ?? '').trim()
  if (id) return `id:${id}`
  return `name:${track.title.trim().toLowerCase()}::${track.artist.trim().toLowerCase()}`
}

export function sameTrack(a?: Track | null, b?: Track | null): boolean {
  const left = trackIdentity(a)
  return Boolean(left && left === trackIdentity(b))
}
