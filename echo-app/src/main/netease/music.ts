import { createRequire } from 'node:module'
import type { ImportPlaylistResult, NeteasePlaylistSummary, Track } from '../../types/ipc'
import { importPlaylist as savePlaylist } from '../db/playlists'
import { buildInitialProfile } from '../services/taste'
import { broadcastImportProgress, buildSemanticsForTracks } from '../services/semantics'
import { getNeteaseLoginState, readNeteaseCookie } from './auth'

const require = createRequire(import.meta.url)
const netease = require('@neteasecloudmusicapienhanced/api') as typeof import('@neteasecloudmusicapienhanced/api')

type ApiResponse = {
  body?: Record<string, unknown>
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
  const year = publishTime > 0 ? new Date(publishTime).getFullYear() : undefined
  const title = String(raw.name ?? '')
  if (!title || artists.length === 0) return null
  return {
    id: raw.id ? String(raw.id) : undefined,
    title,
    artist: artists.join(' / '),
    album: typeof album.name === 'string' ? album.name : undefined,
    year,
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

  savePlaylist({ name, tracks, source: 'netease' })
  const startedAt = new Date().toISOString()
  const semantics = await buildSemanticsForTracks(tracks)
  broadcastImportProgress({ phase: 'profile', current: 0, total: 1, startedAt })
  const profile = await buildInitialProfile(tracks)
  broadcastImportProgress({ phase: 'done', current: 1, total: 1, startedAt })
  return { imported: true, count: tracks.length, name, profile, message: `已从网易云导入 ${tracks.length} 首，新增语义标签 ${semantics.tagged} 首` }
}

function firstSearchSong(body: Record<string, unknown> | undefined): Record<string, unknown> {
  const result = asObject(body?.result)
  return asObject(asArray(result.songs)[0])
}

function compactText(value: string): string {
  return value.toLowerCase().replace(/\s+/g, '').replace(/[《》"'“”·.,，。!！?？()（）-]/g, '')
}

function searchSongMatches(track: Track, song: Record<string, unknown>): boolean {
  const songTitle = compactText(String(song.name ?? ''))
  const targetTitle = compactText(track.title)
  if (!songTitle || !targetTitle) return false

  // 双向 substring：候选叫 "Electric Feel" 时，LLM 简化成《Electric》也能命中。
  const titleHit = songTitle === targetTitle || songTitle.includes(targetTitle) || targetTitle.includes(songTitle)
  if (!titleHit) return false

  // artist 缺省（来自 Echo 文本里只写了《歌名》而没有艺人名）→ 不强制匹配，由调用方接受网易云搜出的第一条相关结果。
  const targetArtists = compactText(track.artist ?? '')
  if (!targetArtists) return true

  const artists = asArray(song.ar ?? song.artists)
    .map((artist) => compactText(String(asObject(artist).name ?? '')))
    .filter(Boolean)
  return artists.some((artist) => targetArtists.includes(artist) || artist.includes(targetArtists))
}

async function findNeteaseSong(track: Track, cookie: string): Promise<Track | null> {
  if (track.id) return track
  const keywords = `${track.title} ${track.artist ?? ''}`.trim()
  if (!keywords) return null

  const result = await netease.cloudsearch({ keywords, type: 1, limit: 5, offset: 0, cookie }) as ApiResponse
  const resultBody = asObject(result.body?.result)
  const songs = asArray(resultBody.songs).map(asObject)
  const song = songs.find((item) => searchSongMatches(track, item)) ?? firstSearchSong(result.body)
  if (!searchSongMatches(track, song)) return null
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

export async function resolvePlayableTrack(track: Track): Promise<Track | null> {
  const cookie = readNeteaseCookie()
  if (!cookie) return null

  const song = await findNeteaseSong(track, cookie)
  if (!song?.id) return null

  // 修订自 v0.1-fixes 第 1 条:
  // 不要把临时 ref 或展示文案当作播放源。播放 URL 只绑定到完整 Track 的网易云 id。
  const result = await netease.song_url_v1({ id: song.id, level: 'exhigh' as never, cookie }) as ApiResponse
  const data = asObject(asArray(result.body?.data)[0])
  const url = typeof data.url === 'string' ? data.url : ''
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

export async function filterPlayableTracks(candidates: Track[], limit = 3): Promise<Track[]> {
  const playable: Track[] = []
  for (const candidate of candidates) {
    if (playable.length >= limit) break
    const track = await resolvePlayableTrack(candidate).catch(() => null)
    if (track) playable.push(track)
  }
  return playable
}
