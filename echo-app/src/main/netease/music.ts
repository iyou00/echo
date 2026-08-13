import { createRequire } from 'node:module'
import type { ImportPlaylistResult, NeteasePlaylistSummary, Track } from '../../types/ipc'
import { getAllImportedTracks, importPlaylist as savePlaylist } from '../db/playlists'
import { buildInitialProfile } from '../services/taste'
import { buildSemanticsForTracks } from '../services/semantics'
import { runImportTask } from '../services/importTasks'
import { getNeteaseLoginState, readNeteaseCookie } from './auth'
import { type MusicEntityConstraint, trackMatchesMusicEntity } from '../skills/music/verifier'
import { recordHealth } from '../services/health'
import { broadcast } from '../ipc/shared'

const require = createRequire(import.meta.url)
const netease = require('@neteasecloudmusicapienhanced/api') as typeof import('@neteasecloudmusicapienhanced/api')
const PLAYABLE_LOOKUP_NOTICE_COOLDOWN_MS = 60_000
let lastPlayableLookupNoticeAt = 0

type ApiResponse = {
  body?: Record<string, unknown>
}

class NeteasePlayableLookupError extends Error {
  constructor(readonly kind: 'auth', message: string) {
    super(message)
    this.name = 'NeteasePlayableLookupError'
  }
}

function isNeteaseAuthCode(code: number): boolean {
  return code === 301 || code === 302 || code === 401
}

function assertNeteaseApiReady(body: Record<string, unknown> | undefined): void {
  const data = asObject(body)
  const code = Number(data.code ?? 0)
  const message = String(data.message ?? data.msg ?? '')
  if (isNeteaseAuthCode(code) || /登录|cookie|凭证/.test(message)) {
    throw new NeteasePlayableLookupError('auth', message || '网易云登录已过期')
  }
}

function isPlayableLookupAuthError(error: unknown): boolean {
  return error instanceof NeteasePlayableLookupError && error.kind === 'auth'
}

function requireLogin(): { cookie: string; userId: number } {
  const cookie = readNeteaseCookie()
  if (!cookie) throw new Error('请先登录网易云')
  return { cookie, userId: 0 }
}

export function asObject(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' ? value as Record<string, unknown> : {}
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : []
}

export async function listNeteasePlaylists(): Promise<NeteasePlaylistSummary[]> {
  const { cookie } = requireLogin()
  const state = await getNeteaseLoginState()
  if (!state.loggedIn || !state.userId) throw new Error(state.message || '请先登录网易云')

  const result = await netease.user_playlist({ uid: state.userId, limit: 100, offset: 0, cookie }) as ApiResponse
  const playlists = asArray(result.body?.playlist)
  return playlists.map((item) => {
    const playlist = asObject(item)
    const creator = asObject(playlist.creator)
    return {
      id: String(playlist.id ?? ''),
      name: String(playlist.name ?? '未命名歌单'),
      trackCount: Number(playlist.trackCount ?? 0),
      creator: typeof creator.nickname === 'string' ? creator.nickname : undefined,
      coverImgUrl: typeof playlist.coverImgUrl === 'string' ? playlist.coverImgUrl : undefined,
      subscribed: Boolean(playlist.subscribed),
    }
  }).filter((playlist) => playlist.id)
}

export function normalizeNeteaseTrack(item: unknown): Track | null {
  const root = asObject(item)
  const raw = root.name || root.id ? root : asObject(root.song)
  const artists = asArray(raw.ar ?? raw.artists)
    .map((artist) => String(asObject(artist).name ?? ''))
    .filter(Boolean)
  const album = asObject(raw.al ?? raw.album)
  const publishTime = Number(raw.publishTime ?? 0)
  const publishDate = Number.isFinite(publishTime) && publishTime > 0 ? new Date(publishTime) : undefined
  const validPublishDate = publishDate && Number.isFinite(publishDate.getTime()) ? publishDate : undefined
  const year = validPublishDate?.getFullYear()
  const publishedAt = validPublishDate?.toISOString()
  const title = String(raw.name ?? '')
  if (!title || artists.length === 0) return null
  return {
    id: raw.id ? String(raw.id) : undefined,
    title,
    artist: artists.join(' / '),
    album: typeof album.name === 'string' ? album.name : undefined,
    year,
    publishedAt,
    source: 'netease',
  }
}

export async function importNeteasePlaylist(id: string): Promise<ImportPlaylistResult> {
  const { cookie } = requireLogin()
  if (!id) return { imported: false, count: 0, message: '歌单 ID 为空' }

  const result = await netease.playlist_detail({ id, cookie }) as ApiResponse
  const playlist = asObject(result.body?.playlist)
  const tracks = asArray(playlist.tracks).map(normalizeNeteaseTrack).filter((track): track is Track => Boolean(track))
  const name = String(playlist.name ?? `网易云歌单 ${id}`)

  if (tracks.length === 0) {
    return { imported: false, count: 0, name, message: '这个歌单没有识别到可导入歌曲' }
  }

  return runImportTask('netease-playlist', name, async (report, signal) => {
    savePlaylist({ name, tracks, source: `netease:${id}` })
    await buildSemanticsForTracks(tracks, report, { signal })
    report({ phase: 'profile', current: 0, total: 1 })
    const profile = await buildInitialProfile(getAllImportedTracks())
    report({ phase: 'done', current: 1, total: 1 })
    return { imported: true, count: tracks.length, name, profile, message: `已从网易云导入 ${tracks.length} 首` }
  })
}

function firstSearchSong(body: Record<string, unknown> | undefined): Record<string, unknown> {
  const result = asObject(body?.result)
  return asObject(asArray(result.songs)[0])
}

function compactText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, '').replace(/[《》"'“”·.,，。!！?？()（）-]/g, '')
}

export interface ResolvePlayableTrackOptions {
  constraint?: MusicEntityConstraint
  strictArtist?: boolean
  strictTitle?: boolean
  signal?: AbortSignal
}

function searchSongMatches(track: Track, song: Record<string, unknown>, options: ResolvePlayableTrackOptions = {}): boolean {
  const songTitle = compactText(String(song.name ?? ''))
  const targetTitle = compactText(track.title)
  if (!songTitle || !targetTitle) return false

  // 双向 substring：候选叫 "Electric Feel" 时，LLM 简化成《Electric》也能命中。
  const titleHit = songTitle === targetTitle || songTitle.includes(targetTitle) || targetTitle.includes(songTitle)
  if (!titleHit) return false

  const artists = asArray(song.ar ?? song.artists)
    .map((artist) => String(asObject(artist).name ?? ''))
    .filter(Boolean)
  if (options.constraint) {
    return trackMatchesMusicEntity(
      {
        title: String(song.name ?? track.title),
        artist: artists.join(' / ') || track.artist,
      },
      options.constraint,
      { strictArtist: options.strictArtist, strictTitle: options.strictTitle },
    )
  }

  const targetArtists = compactText(track.artist ?? '')
  if (!targetArtists) return true
  const artistHit = artists
    .map(compactText)
    .some((artist) => targetArtists.includes(artist) || artist.includes(targetArtists))
  return artistHit
}

async function findNeteaseSong(track: Track, cookie: string, options: ResolvePlayableTrackOptions = {}): Promise<Track | null> {
  assertPlayableFilterActive(options.signal)
  if (track.id) {
    if (options.constraint && !trackMatchesMusicEntity(track, options.constraint, { strictArtist: options.strictArtist, strictTitle: options.strictTitle })) return null
    return track
  }
  const keywords = `${track.title} ${track.artist ?? ''}`.trim()
  if (!keywords) return null

  const result = await netease.cloudsearch({ keywords, type: 1, limit: 5, offset: 0, cookie, signal: options.signal } as never) as ApiResponse
  assertPlayableFilterActive(options.signal)
  assertNeteaseApiReady(result.body)
  const resultBody = asObject(result.body?.result)
  const songs = asArray(resultBody.songs).map(asObject)
  const matchedSong = songs.find((item) => searchSongMatches(track, item, options))
  const song = matchedSong ?? (options.constraint ? {} : firstSearchSong(result.body))
  if (!searchSongMatches(track, song, options)) return null
  const id = song.id ? String(song.id) : ''
  if (!id) return null

  const artists = asArray(song.ar ?? song.artists)
    .map((artist) => String(asObject(artist).name ?? ''))
    .filter(Boolean)
  const album = asObject(song.al ?? song.album)
  return {
    ...track,
    id,
    title: String(song.name ?? track.title),
    artist: artists.length > 0 ? artists.join(' / ') : (track.artist || '未知艺人'),
    album: typeof album.name === 'string' ? album.name : track.album,
    durationMs: Number(song.dt ?? song.duration ?? track.durationMs ?? 0) || track.durationMs,
    source: 'netease',
  }
}

export async function resolvePlayableTrack(track: Track, options: ResolvePlayableTrackOptions = {}): Promise<Track | null> {
  assertPlayableFilterActive(options.signal)
  const cookie = readNeteaseCookie()
  if (!cookie) return null

  const song = await findNeteaseSong(track, cookie, options)
  if (!song?.id) return null

  // 修订自 v0.1-fixes 第 1 条:
  // 不要把临时 ref 或展示文案当作播放源。播放 URL 只绑定到完整 Track 的网易云 id。
  assertPlayableFilterActive(options.signal)
  let result = await netease.song_url_v1({ id: song.id, level: 'exhigh', cookie, signal: options.signal } as never) as ApiResponse
  assertPlayableFilterActive(options.signal)
  assertNeteaseApiReady(result.body)
  let data = asObject(asArray(result.body?.data)[0])
  let url = typeof data.url === 'string' ? data.url : ''
  if (!url) {
    assertPlayableFilterActive(options.signal)
    result = await netease.song_url_v1({ id: song.id, level: 'standard', cookie, signal: options.signal } as never) as ApiResponse
    assertPlayableFilterActive(options.signal)
    assertNeteaseApiReady(result.body)
    data = asObject(asArray(result.body?.data)[0])
    url = typeof data.url === 'string' ? data.url : ''
  }
  if (!url) return null

  return {
    ...song,
    neteaseId: song.id,
    playUrl: url,
    urlExpiresAt: new Date(Date.now() + 25 * 60 * 1000).toISOString(),
    durationMs: Number(data.time ?? song.durationMs ?? 0) || song.durationMs,
    source: 'netease',
  }
}

export async function refreshPlayableUrl(track: Track): Promise<Track | null> {
  if (!track.id && track.neteaseId) {
    return resolvePlayableTrack({ ...track, id: track.neteaseId, playUrl: undefined, urlExpiresAt: undefined })
  }
  return resolvePlayableTrack({ ...track, playUrl: undefined, urlExpiresAt: undefined })
}

function assertPlayableFilterActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('任务已取消', 'AbortError')
}

function notifyPlayableLookupDegraded(): void {
  const now = Date.now()
  recordHealth('netease', 'degraded', '推荐路径未获得有效播放链接，网易云登录可能已过期。')
  if (now - lastPlayableLookupNoticeAt < PLAYABLE_LOOKUP_NOTICE_COOLDOWN_MS) return
  lastPlayableLookupNoticeAt = now
  broadcast('netease:cookie-expired', '网易云播放链接获取失败，请到设置页重新登录后再试。')
}

type PlayableResolver = (track: Track) => Promise<Track | null>

async function collectPlayableTracksInOrder(
  candidates: Track[],
  limit: number,
  signal: AbortSignal | undefined,
  resolveCandidate: PlayableResolver,
  onError?: (error: unknown) => void,
): Promise<{ tracks: Track[]; attemptedCount: number; failCount: number }> {
  const playable: Track[] = []
  const concurrency = 5
  let failCount = 0
  let attemptedCount = 0

  for (let start = 0; start < candidates.length && playable.length < limit; start += concurrency) {
    const batch = candidates.slice(start, start + concurrency)
    const resolved = await Promise.all(batch.map(async (candidate) => {
      assertPlayableFilterActive(signal)
      attemptedCount++
      const track = await resolveCandidate(candidate).catch((error) => {
        assertPlayableFilterActive(signal)
        onError?.(error)
        return null
      })
      assertPlayableFilterActive(signal)
      if (!track) failCount++
      return track
    }))
    for (const track of resolved) {
      if (track && playable.length < limit) playable.push(track)
    }
  }

  return { tracks: playable.slice(0, limit), attemptedCount, failCount }
}

export const neteaseMusicTestHelpers = {
  collectPlayableTracksInOrder,
}

export async function filterPlayableTracks(candidates: Track[], limit = 3, signal?: AbortSignal): Promise<Track[]> {
  const result = await collectPlayableTracksInOrder(
    candidates,
    limit,
    signal,
    (candidate) => resolvePlayableTrack(candidate, { signal }),
    (error) => {
      if (isPlayableLookupAuthError(error)) notifyPlayableLookupDegraded()
    },
  )

  if (result.tracks.length === 0 && result.attemptedCount > 0 && result.failCount === result.attemptedCount && readNeteaseCookie()) {
    notifyPlayableLookupDegraded()
  }

  return result.tracks
}
