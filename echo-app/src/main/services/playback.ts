import { BrowserWindow } from 'electron'
import type { PlaybackHeartbeat, PlaybackPlayOptions, PlaybackState, Track } from '../../types/ipc'
import { getQueue, markQueueStatus } from './queue'
import { refreshPlayableUrl } from '../netease/music'
import { applySignal, maybeRefreshStructuredProfile } from './taste'
import { recordHealth } from './health'
import { recordTrackFeedback } from '../db/feedback'

const state: PlaybackState = {
  current: null,
  position: 0,
  duration: 0,
  status: 'idle',
  volume: 100,
  queue: [],
  history: [],
}
const loopCounts = new Map<string, { count: number; firstAt: number }>()

function trackKey(track?: Track | null): string {
  if (!track) return ''
  return `${track.id ?? track.neteaseId ?? ''}:${track.title.trim().toLowerCase()}:${track.artist.trim().toLowerCase()}`
}

function cloneState(): PlaybackState {
  return structuredClone(state)
}

function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(channel, payload)
  }
}

function emitState(): PlaybackState {
  const next = cloneState()
  broadcast('playback:state-changed', next)
  return next
}

function isUrlStale(track: Track): boolean {
  if (!track.playUrl) return true
  if (!track.urlExpiresAt) return false
  return new Date(track.urlExpiresAt).getTime() <= Date.now() + 60_000
}

function playableQueue(exclude?: Track | null): Track[] {
  const excluded = trackKey(exclude)
  const seen = new Set<string>()
  return getQueue()
    .filter((track) => track.playUrl && track.queueStatus !== 'completed' && track.queueStatus !== 'skipped')
    .filter((track) => {
      const key = trackKey(track)
      if (!key || key === excluded || seen.has(key)) return false
      seen.add(key)
      return true
    })
}

function replaceTrackInState(track: Track): void {
  const key = trackKey(track)
  if (trackKey(state.current) === key) state.current = track
  state.queue = state.queue.map((item) => (trackKey(item) === key ? track : item))
  state.history = state.history.map((item) => (trackKey(item) === key ? track : item))
}

async function applyPlaybackFeedback(track: Track, completionRate: number): Promise<void> {
  const rate = Math.max(0, Math.min(1, completionRate))
  if (rate >= 0.8) {
    recordTrackFeedback('played', track, rate)
    await applySignal('played', { artist: track.artist, trackId: track.id ?? track.neteaseId, title: track.title, completionRate: rate })
    maybeRefreshStructuredProfile('played')
    const key = trackKey(track)
    const now = Date.now()
    const existing = loopCounts.get(key)
    const next = existing && now - existing.firstAt < 24 * 60 * 60 * 1000
      ? { count: existing.count + 1, firstAt: existing.firstAt }
      : { count: 1, firstAt: now }
    loopCounts.set(key, next)
    if (next.count === 3) {
      recordTrackFeedback('looped', track, rate)
      await applySignal('looped', { artist: track.artist, trackId: track.id ?? track.neteaseId, title: track.title })
      maybeRefreshStructuredProfile('looped')
    }
    return
  }
  if (rate < 0.3) {
    recordTrackFeedback('skipped', track, rate)
    await applySignal('skipped', { artist: track.artist, trackId: track.id ?? track.neteaseId, title: track.title, completionRate: rate })
    maybeRefreshStructuredProfile('skipped')
  }
}

async function ensurePlayable(track: Track): Promise<Track> {
  if (!isUrlStale(track)) return track
  const refreshed = await refreshPlayableUrl(track)
  if (!refreshed?.playUrl) {
    recordHealth('netease', 'degraded', '网易云登录可能过期了。重新扫码后我再拿播放链接。')
    broadcast('netease:cookie-expired', '网易云播放链接获取失败，请重新登录后再试。')
    throw new Error('网易云播放链接获取失败')
  }
  return refreshed
}

export async function play(track: Track, options: PlaybackPlayOptions & { pushHistory?: boolean } = {}): Promise<PlaybackState> {
  const pushHistory = options.pushHistory ?? true
  const playable = await ensurePlayable(track)
  const currentKey = trackKey(state.current)
  const nextKey = trackKey(playable)

  if (pushHistory && state.current && currentKey && currentKey !== nextKey) {
    state.history = [state.current, ...state.history].slice(0, 20)
  }

  state.current = playable
  state.position = 0
  state.duration = playable.durationMs ?? 0
  state.status = 'loading'
  if (typeof options.initialVolume === 'number') {
    state.volume = Math.max(0, Math.min(100, Math.floor(options.initialVolume)))
  }
  state.error = undefined
  markQueueStatus(playable, 'playing')
  state.queue = playableQueue(playable)
  return emitState()
}

export async function enqueue(track: Track): Promise<PlaybackState> {
  const playable = await ensurePlayable(track)
  if (!state.current) return play(playable, { pushHistory: false })
  const key = trackKey(playable)
  if (!state.queue.some((item) => trackKey(item) === key)) {
    state.queue = [...state.queue, playable]
  }
  return emitState()
}

export async function next(): Promise<PlaybackState> {
  const finished = state.current
  if (finished) {
    const completionRate = state.position > 0 && state.duration > 0 ? state.position / state.duration : 1
    await applyPlaybackFeedback(finished, completionRate)
    markQueueStatus(finished, completionRate < 0.3 ? 'skipped' : 'completed')
  }
  const queue = playableQueue(finished)
  const target = state.queue[0] ?? queue[0]
  if (!target) {
    state.current = null
    state.position = 0
    state.duration = 0
    state.status = 'idle'
    state.queue = []
    return emitState()
  }
  return play(target, { pushHistory: Boolean(finished) })
}

export async function prev(): Promise<PlaybackState> {
  const target = state.history[0]
  if (!target) return cloneState()
  state.history = state.history.slice(1)
  return play(target, { pushHistory: false })
}

export function pause(): PlaybackState {
  if (state.current) state.status = 'paused'
  return emitState()
}

export function resume(): PlaybackState {
  if (state.current) state.status = 'playing'
  return emitState()
}

export function setVolume(percent: number): PlaybackState {
  state.volume = Math.max(0, Math.min(100, Math.floor(percent)))
  return emitState()
}

export function getVolume(): number {
  return state.volume
}

export function seek(positionMs: number): PlaybackState {
  state.position = Math.max(0, Math.floor(positionMs))
  return emitState()
}

export function removeFromQueue(index: number): PlaybackState {
  const fallbackQueue = playableQueue(state.current)
  const target = state.queue[index] ?? fallbackQueue[index]
  if (target) markQueueStatus(target, 'skipped')
  state.queue = state.queue.filter((_, itemIndex) => itemIndex !== index)
  return emitState()
}

export function clearQueue(): PlaybackState {
  const pending = state.queue.length > 0 ? state.queue : playableQueue(state.current)
  for (const track of pending) {
    markQueueStatus(track, 'skipped')
  }
  state.queue = []
  return emitState()
}

export function reorderQueue(fromIndex: number, toIndex: number): PlaybackState {
  if (fromIndex < 0 || fromIndex >= state.queue.length) return cloneState()
  const boundedTo = Math.max(0, Math.min(state.queue.length - 1, toIndex))
  const next = [...state.queue]
  const [moved] = next.splice(fromIndex, 1)
  next.splice(boundedTo, 0, moved)
  state.queue = next
  return emitState()
}

export function heartbeat(payload: PlaybackHeartbeat): PlaybackState {
  state.position = Math.max(0, Math.floor(payload.position))
  if (payload.duration && payload.duration > 0) state.duration = Math.floor(payload.duration)
  if (state.current && payload.status) state.status = payload.status
  return cloneState()
}

export async function refreshUrl(trackId: string): Promise<{ track: Track; state: PlaybackState }> {
  const target = [state.current, ...state.queue, ...state.history].find((track) => {
    if (!track) return false
    return track.id === trackId || track.neteaseId === trackId
  })
  if (!target) throw new Error('没有找到当前播放歌曲')
  const refreshed = await refreshPlayableUrl(target)
  if (!refreshed?.playUrl) {
    state.status = 'error'
    state.error = '网易云播放链接续期失败'
    recordHealth('netease', 'degraded', '网易云登录可能过期了。重新扫码后我再拿播放链接。')
    broadcast('netease:cookie-expired', '网易云播放链接续期失败，请重新登录后再试。')
    emitState()
    throw new Error(state.error)
  }
  replaceTrackInState(refreshed)
  const nextState = emitState()
  broadcast('playback:url-refreshed', {
    trackId,
    url: refreshed.playUrl,
    expiresAt: refreshed.urlExpiresAt ?? new Date(Date.now() + 25 * 60 * 1000).toISOString(),
  })
  return { track: refreshed, state: nextState }
}

export function getState(): PlaybackState {
  if (!state.current) state.queue = playableQueue()
  return cloneState()
}

export function resetPlaybackState(): PlaybackState {
  state.current = null
  state.position = 0
  state.duration = 0
  state.status = 'idle'
  state.volume = 100
  state.queue = []
  state.history = []
  state.error = undefined
  loopCounts.clear()
  return emitState()
}
