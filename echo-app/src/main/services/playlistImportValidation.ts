import type { Track, UiBoundarySnapshot } from '../../types/ipc'
import type { PlaylistPayload } from '../db/playlists'
import { createUiBoundary } from '../../shared/uiBoundary'

export class PlaylistValidationError extends Error {
  constructor(
    message: string,
    readonly invalidFields: string[],
    readonly invalidItems = 0,
    readonly totalItems = 0,
  ) {
    super(message)
    this.name = 'PlaylistValidationError'
  }
}

export interface NormalizedPlaylist {
  payload: PlaylistPayload
  boundary?: UiBoundarySnapshot
}

function normalizeArtists(value: unknown): string {
  if (Array.isArray(value)) return value.map(String).filter(Boolean).join(' / ')
  return String(value ?? '')
}

export function normalizePlaylist(payload: unknown): NormalizedPlaylist {
  const parsed = payload as { name?: string; source?: string; tracks?: unknown[] }
  if (!parsed || typeof parsed !== 'object') {
    throw new PlaylistValidationError('JSON 顶层需要是一个对象', ['root'])
  }
  if (!Array.isArray(parsed.tracks)) {
    throw new PlaylistValidationError('JSON 里需要有 tracks 数组', ['tracks'])
  }
  if (parsed.tracks.length === 0) {
    throw new PlaylistValidationError('tracks 数组是空的，请至少加入一首歌。', ['tracks'])
  }

  const invalidFields = new Set<string>()
  let invalidItems = 0
  const tracks: Track[] = parsed.tracks.flatMap((item): Track[] => {
    const track = item as Record<string, unknown>
    if (!track || typeof track !== 'object') {
      invalidItems += 1
      invalidFields.add('track')
      return []
    }
    const platform = String(track.platform ?? '').toLowerCase()
    const platformId = track.platformId ? String(track.platformId) : undefined
    const neteaseId = track.neteaseId ? String(track.neteaseId) : platform === 'netease' ? platformId : undefined
    const title = String(track.title ?? track.name ?? '').trim()
    const artist = normalizeArtists(track.artist ?? track.artists).trim()
    if (!title || !artist) {
      invalidItems += 1
      if (!title) invalidFields.add('title')
      if (!artist) invalidFields.add('artist')
      return []
    }
    return [{
      id: track.id ? String(track.id) : undefined,
      neteaseId,
      title,
      artist,
      album: track.album ? String(track.album) : undefined,
      year: track.year ? Number(track.year) : undefined,
      durationMs: track.durationMs ? Number(track.durationMs) : undefined,
      source: parsed.source ? String(parsed.source) : 'imported',
    }]
  })

  if (tracks.length === 0) {
    throw new PlaylistValidationError(
      '没有识别到有效歌曲。每首歌至少需要 title 和 artist。',
      Array.from(invalidFields),
      invalidItems,
      parsed.tracks.length,
    )
  }
  return {
    payload: { name: parsed.name ?? '导入歌单', tracks },
    boundary: invalidItems > 0
      ? createUiBoundary('import_invalid', {
          details: { invalidFields: Array.from(invalidFields), invalidItems, totalItems: parsed.tracks.length },
        })
      : undefined,
  }
}
