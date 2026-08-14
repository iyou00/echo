import { BrowserWindow } from 'electron'
import { randomUUID } from 'node:crypto'
import type { PlaybackHeartbeat, PlaybackPlayOptions, PlaybackState, Track } from '../../types/ipc'
import { trackIdentity as trackKey } from '../../shared/trackIdentity'
import { getQueue, markQueueStatus } from './queue'
import { refreshPlayableUrl } from '../netease/music'
import { recordHealth } from './health'
import { recordTrackFeedback } from '../db/feedback'
import { applyMemorySignal } from './memoryPolicy'
import { sceneQueueAfterAdjustment } from './sceneJourney'
import { loadActiveStageContext } from '../domain/stageContext/repository'
import {
  createAgentAction,
  loadAgentActionItemStatus,
  loadAgentActionStatus,
  recordAgentActionOutcome,
  transitionAgentAction,
  transitionAgentActionItem,
} from '../domain/agentAction/repository'
import { classifyPlaybackOutcome } from '../domain/agentAction/outcomePolicy'
import { getDb } from '../db'

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
const stateListeners = new Set<(state: PlaybackState) => void>()
const urlRefreshInFlight = new Set<string>()
const LOOP_COUNT_TTL_MS = 24 * 60 * 60 * 1000
const LOOP_COUNT_MAX_ENTRIES = 500

type InternalPlaybackPlayOptions = PlaybackPlayOptions & {
  pushHistory?: boolean
  preserveQueue?: boolean
  recordPreviousFeedback?: boolean
}

interface PlaybackNextOptions {
  recordCurrentFeedback?: boolean
  skippedReason?: Track['queueStatusReason']
  playbackInstanceId?: string
}

function playbackOrigin(track: Track) {
  if (track.sourceContext === 'voice') return 'listening' as const
  if (track.sourceContext === 'scene') return 'scene' as const
  if (track.sourceContext === 'care') return 'care' as const
  if (track.sourceContext === 'chat') return 'chat' as const
  return 'playback' as const
}

function playbackUserAgency(track: Track) {
  if (track.sourceContext === 'favorite' || track.sourceContext === 'history') return 'active' as const
  if (track.sourceContext === 'queue') return 'passive' as const
  return 'reactive' as const
}

function createAttributedPlayback(track: Track): Track {
  const context = loadActiveStageContext()
  const playbackInstanceId = randomUUID()
  const existingActionStatus = track.agentActionId ? loadAgentActionStatus(track.agentActionId) : null
  const existingItemStatus = track.agentActionItemId ? loadAgentActionItemStatus(track.agentActionItemId) : null
  const reusableStatuses = new Set(['planned', 'started', 'succeeded'])
  if (
    track.sourceContext !== 'favorite'
    && track.sourceContext !== 'history'
    && track.agentActionId
    && track.agentActionItemId
    && existingActionStatus
    && existingItemStatus
    && reusableStatuses.has(existingActionStatus)
    && reusableStatuses.has(existingItemStatus)
  ) {
    return { ...track, playbackInstanceId }
  }
  const action = createAgentAction({
    origin: playbackOrigin(track),
    actionType: track.sourceContext === 'voice' ? 'silent_play' : 'play',
    reasonCode: context?.goal === 'focus' ? 'context_focus'
      : context?.goal === 'recover' ? 'context_recover'
        : context?.goal === 'settle' ? 'context_settle'
          : context?.goal === 'energize' ? 'context_energize'
            : context?.goal === 'companionship' ? 'context_companionship'
              : 'user_request',
    goalCode: context?.goal ?? 'none',
    stageContextId: context?.id,
    stageContextRevision: context?.revision,
    items: [{
      itemType: 'track',
      ordinal: 0,
      entityKey: trackKey(track),
      payload: { id: track.id ?? track.neteaseId, title: track.title, artist: track.artist, sourceContext: track.sourceContext, sceneKey: track.sceneKey },
    }],
    decision: { policyVersion: 1, playbackInstanceId },
  })
  return {
    ...track,
    agentActionId: action.id,
    agentActionItemId: action.items[0].id,
    stageContextId: context?.id,
    playbackInstanceId,
  }
}

function markAttributedPlaybackStarted(track: Track): void {
  if (!track.agentActionId || !track.agentActionItemId) return
  if (loadAgentActionStatus(track.agentActionId) === 'planned') transitionAgentAction(track.agentActionId, 'started')
  if (loadAgentActionItemStatus(track.agentActionItemId) === 'planned') transitionAgentActionItem(track.agentActionItemId, 'started')
}

function markAttributedPlaybackSucceeded(track: Track): void {
  if (!track.agentActionId || !track.agentActionItemId) return
  if (track.playbackInstanceId) {
    recordAgentActionOutcome({
      actionId: track.agentActionId,
      actionItemId: track.agentActionItemId,
      sourceEventKey: `playback_started:${track.playbackInstanceId}`,
      outcomeType: 'playback_started',
      polarity: 'system',
      strength: 'weak',
      metadata: { userAgency: playbackUserAgency(track) },
    })
  }
  if (loadAgentActionItemStatus(track.agentActionItemId) === 'started') transitionAgentActionItem(track.agentActionItemId, 'succeeded')
  if (loadAgentActionStatus(track.agentActionId) === 'started') transitionAgentAction(track.agentActionId, 'succeeded')
}

function markAttributedPlaybackFailed(track: Track, failureKind: string): void {
  if (!track.agentActionId || !track.agentActionItemId) return
  const itemStatus = loadAgentActionItemStatus(track.agentActionItemId)
  const actionStatus = loadAgentActionStatus(track.agentActionId)
  if (itemStatus === 'planned' || itemStatus === 'started') transitionAgentActionItem(track.agentActionItemId, 'failed')
  if (actionStatus === 'planned' || actionStatus === 'started') transitionAgentAction(track.agentActionId, 'failed', { failureKind })
  if (track.playbackInstanceId) {
    recordAgentActionOutcome({
      actionId: track.agentActionId,
      actionItemId: track.agentActionItemId,
      sourceEventKey: `playback_final:${track.playbackInstanceId}`,
      outcomeType: 'system_failure',
      polarity: 'system',
      strength: 'weak',
      metadata: { failureKind, userAgency: 'reactive' },
    })
  }
}

function attributedPlaybackOutcome(track: Track, reason: 'ended' | 'next' | 'stop' | 'app_closed' | 'system_failure') {
  if (!track.agentActionId || !track.playbackInstanceId) return null
  return classifyPlaybackOutcome({
    playbackInstanceId: track.playbackInstanceId,
    actionId: track.agentActionId,
    actionItemId: track.agentActionItemId,
    positionMs: state.position,
    durationMs: state.duration,
    reason,
    userAgency: playbackUserAgency(track),
  })
}

function cloneState(): PlaybackState {
  return structuredClone(state)
}

function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send(channel, payload)
  }
}

function emitState(): PlaybackState {
  const next = cloneState()
  broadcast('playback:state-changed', next)
  for (const listener of Array.from(stateListeners)) listener(next)
  return next
}

export function onPlaybackStateChanged(listener: (state: PlaybackState) => void): () => void {
  stateListeners.add(listener)
  return () => stateListeners.delete(listener)
}

function isUrlStale(track: Track): boolean {
  if (!track.playUrl) return true
  if (!track.urlExpiresAt) return false
  return new Date(track.urlExpiresAt).getTime() <= Date.now() + 60_000
}

function playableQueue(exclude?: Track | null, options: { includeCompleted?: boolean } = {}): Track[] {
  const excluded = trackKey(exclude)
  const seen = new Set<string>()
  return getQueue()
    .filter((track) => track.queueStatus !== 'skipped')
    .filter((track) => options.includeCompleted || track.queueStatus !== 'completed')
    .filter((track) => {
      const key = trackKey(track)
      if (!key || key === excluded || seen.has(key)) return false
      seen.add(key)
      return true
    })
}

function nextCandidates(exclude?: Track | null): Track[] {
  const excluded = trackKey(exclude)
  const seen = new Set<string>()
  const candidates = [...state.queue, ...playableQueue(exclude)]
  const next: Track[] = []
  for (const track of candidates) {
    const key = trackKey(track)
    if (!key || key === excluded || seen.has(key)) continue
    seen.add(key)
    next.push(track)
  }
  return next
}

function mergeQueue(primary: Track[], secondary: Track[], exclude?: Track | null): Track[] {
  const excluded = trackKey(exclude)
  const seen = new Set<string>()
  const next: Track[] = []
  for (const track of [...primary, ...secondary]) {
    const key = trackKey(track)
    if (!key || key === excluded || seen.has(key)) continue
    seen.add(key)
    next.push(track)
  }
  return next
}

function replaceTrackInState(track: Track): void {
  const key = trackKey(track)
  if (trackKey(state.current) === key) state.current = track
  state.queue = state.queue.map((item) => (trackKey(item) === key ? track : item))
  state.history = state.history.map((item) => (trackKey(item) === key ? track : item))
}

function pruneLoopCounts(now = Date.now()): void {
  for (const [key, value] of loopCounts.entries()) {
    if (now - value.firstAt >= LOOP_COUNT_TTL_MS) loopCounts.delete(key)
  }
  if (loopCounts.size <= LOOP_COUNT_MAX_ENTRIES) return
  const overflow = loopCounts.size - LOOP_COUNT_MAX_ENTRIES
  const oldest = Array.from(loopCounts.entries())
    .sort((a, b) => a[1].firstAt - b[1].firstAt)
    .slice(0, overflow)
  for (const [key] of oldest) loopCounts.delete(key)
}

async function applyPlaybackFeedback(track: Track, completionRate: number, reason: 'ended' | 'next'): Promise<void> {
  const rate = Math.max(0, Math.min(1, completionRate))
  const outcome = attributedPlaybackOutcome(track, reason)
  let shouldApplyLegacy = true
  getDb().transaction(() => {
    if (outcome) shouldApplyLegacy = recordAgentActionOutcome(outcome).inserted
    if (!shouldApplyLegacy) return
    if (outcome?.outcomeType === 'completed' || (!outcome && rate >= 0.8)) recordTrackFeedback('played', track, rate)
    else if (outcome?.outcomeType === 'quick_skip' || (!outcome && rate < 0.3)) recordTrackFeedback('skipped', track, rate)
  })()
  if (!shouldApplyLegacy) return
  if (outcome?.outcomeType === 'completed' || (!outcome && rate >= 0.8)) {
    await applyMemorySignal('played', { artist: track.artist, trackId: track.id ?? track.neteaseId, title: track.title, completionRate: rate }, { source: 'playback', track })
    const key = trackKey(track)
    const now = Date.now()
    pruneLoopCounts(now)
    const existing = loopCounts.get(key)
    const next = existing && now - existing.firstAt < LOOP_COUNT_TTL_MS
      ? { count: existing.count + 1, firstAt: existing.firstAt }
      : { count: 1, firstAt: now }
    loopCounts.set(key, next)
    if (next.count === 3) {
      recordTrackFeedback('looped', track, rate)
      await applyMemorySignal('looped', { artist: track.artist, trackId: track.id ?? track.neteaseId, title: track.title }, { source: 'playback', track })
    }
    return
  }
  if (outcome?.outcomeType === 'quick_skip' || (!outcome && rate < 0.3)) {
    await applyMemorySignal('skipped', { artist: track.artist, trackId: track.id ?? track.neteaseId, title: track.title, completionRate: rate }, { source: 'playback', track })
  }
}

function currentCompletionRate(defaultRate: number): number {
  if (state.duration > 0) return Math.max(0, Math.min(1, state.position / state.duration))
  return Math.max(0, Math.min(1, defaultRate))
}

function statusForCompletionRate(rate: number): NonNullable<Track['queueStatus']> {
  return rate < 0.3 ? 'skipped' : 'completed'
}

async function ensurePlayable(track: Track): Promise<Track> {
  if (!isUrlStale(track)) return track
  const refreshed = await refreshPlayableUrl(track)
  if (!refreshed?.playUrl) {
    recordHealth('netease', 'degraded', '网易云登录可能过期了。重新登录后我再拿播放链接。')
    broadcast('netease:cookie-expired', '网易云播放链接获取失败，请重新登录后再试。')
    throw new Error('网易云播放链接获取失败')
  }
  return refreshed
}

export async function play(track: Track, options: InternalPlaybackPlayOptions = {}): Promise<PlaybackState> {
  const pushHistory = options.pushHistory ?? true
  const attributed = createAttributedPlayback(track)
  let playable: Track
  try {
    const resolved = await ensurePlayable(attributed)
    playable = { ...resolved, agentActionId: attributed.agentActionId, agentActionItemId: attributed.agentActionItemId, stageContextId: attributed.stageContextId, playbackInstanceId: attributed.playbackInstanceId }
    markAttributedPlaybackStarted(playable)
  } catch (error) {
    markAttributedPlaybackFailed(attributed, 'unplayable')
    throw error
  }
  const adjustedQueue = sceneQueueAfterAdjustment(state.queue, track)
  for (const replaced of adjustedQueue.replaced) markQueueStatus(replaced, 'skipped', 'scene_replaced')
  const previousQueue = adjustedQueue.kept
  const previousCurrent = state.current
  const previousCompletionRate = currentCompletionRate(0)
  const currentKey = trackKey(previousCurrent)
  const nextKey = trackKey(playable)

  if (pushHistory && previousCurrent && currentKey && currentKey !== nextKey) {
    if (options.recordPreviousFeedback !== false) {
      await applyPlaybackFeedback(previousCurrent, previousCompletionRate, 'next')
      markQueueStatus(previousCurrent, statusForCompletionRate(previousCompletionRate), statusForCompletionRate(previousCompletionRate) === 'skipped' ? 'playback_skipped' : 'playback_completed')
    }
    state.history = [previousCurrent, ...state.history].slice(0, 20)
  }

  state.current = playable
  state.position = 0
  state.duration = playable.durationMs ?? 0
  state.status = 'loading'
  if (typeof options.initialVolume === 'number') {
    state.volume = Math.max(0, Math.min(100, Math.floor(options.initialVolume)))
  }
  state.error = undefined
  markQueueStatus(playable, 'playing', 'playback_started')
  state.queue = options.preserveQueue
    ? mergeQueue(previousQueue.filter((item) => trackKey(item) !== nextKey), playableQueue(playable), playable)
    : playableQueue(playable, { includeCompleted: true })
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

export async function next(options: PlaybackNextOptions = {}): Promise<PlaybackState> {
  if (options.playbackInstanceId && state.current?.playbackInstanceId !== options.playbackInstanceId) return cloneState()
  const finished = state.current
  if (finished) {
    const completionRate = currentCompletionRate(0)
    if (options.recordCurrentFeedback !== false) {
      await applyPlaybackFeedback(finished, completionRate, 'next')
    }
    const status = options.recordCurrentFeedback === false ? 'skipped' : statusForCompletionRate(completionRate)
    markQueueStatus(finished, status, status === 'skipped' ? options.skippedReason ?? 'playback_skipped' : 'playback_completed')
  }
  let lastError: unknown
  for (const target of nextCandidates(finished)) {
    try {
      return await play(target, { pushHistory: Boolean(finished), preserveQueue: true, recordPreviousFeedback: false })
    } catch (error) {
      lastError = error
      markQueueStatus(target, 'skipped', 'playback_failed')
      const failedKey = trackKey(target)
      state.queue = state.queue.filter((track) => trackKey(track) !== failedKey)
    }
  }
  state.current = null
  state.position = 0
  state.duration = 0
  state.status = 'idle'
  state.queue = []
  state.error = lastError ? '下一首暂时播不出来' : undefined
  return emitState()
}

export async function finishCurrent(playbackInstanceId?: string): Promise<PlaybackState> {
  if (playbackInstanceId && state.current?.playbackInstanceId !== playbackInstanceId) return cloneState()
  const finished = state.current
  if (finished) {
    const completionRate = currentCompletionRate(1)
    await applyPlaybackFeedback(finished, completionRate, 'ended')
    const status = statusForCompletionRate(completionRate)
    markQueueStatus(finished, status, status === 'skipped' ? 'playback_skipped' : 'playback_completed')
    state.history = [finished, ...state.history].slice(0, 20)
  }
  state.current = null
  state.position = 0
  state.duration = 0
  state.status = 'idle'
  state.error = undefined
  state.queue = playableQueue()
  return emitState()
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
  if (target) markQueueStatus(target, 'skipped', 'queue_removed')
  state.queue = state.queue.filter((_, itemIndex) => itemIndex !== index)
  return emitState()
}

export function removeTrackFromQueue(track: Track): PlaybackState {
  const key = trackKey(track)
  if (!key) return cloneState()
  if (trackKey(state.current) === key) return cloneState()
  markQueueStatus(track, 'skipped', 'queue_removed')
  state.queue = state.queue.filter((item) => trackKey(item) !== key)
  return emitState()
}

export function clearQueue(): PlaybackState {
  const pending = state.queue.length > 0 ? state.queue : playableQueue(state.current)
  for (const track of pending) {
    markQueueStatus(track, 'skipped', 'queue_removed')
  }
  state.queue = []
  return emitState()
}

export function reorderQueue(fromIndex: number, toIndex: number): PlaybackState {
  if (fromIndex < 0 || fromIndex >= state.queue.length) return cloneState()
  if (state.queue.length < 2) return cloneState()
  const boundedTo = Math.max(0, Math.min(state.queue.length - 1, toIndex))
  const next = [...state.queue]
  const [moved] = next.splice(fromIndex, 1)
  next.splice(boundedTo, 0, moved)
  state.queue = next
  return emitState()
}

export function heartbeat(payload: PlaybackHeartbeat): PlaybackState {
  if (payload.playbackInstanceId && state.current?.playbackInstanceId !== payload.playbackInstanceId) return cloneState()
  state.position = Math.max(0, Math.floor(payload.position))
  if (payload.duration && payload.duration > 0) state.duration = Math.floor(payload.duration)
  if (state.current && payload.status) {
    state.status = payload.status
    if (payload.status === 'playing') markAttributedPlaybackSucceeded(state.current)
  }
  if (state.current && isUrlStale(state.current)) {
    const refreshId = state.current.id ?? state.current.neteaseId
    if (refreshId && !urlRefreshInFlight.has(refreshId)) {
      urlRefreshInFlight.add(refreshId)
      void refreshUrl(refreshId).catch(() => undefined).finally(() => { urlRefreshInFlight.delete(refreshId) })
    }
  }
  return cloneState()
}

export function reportPlaybackError(playbackInstanceId: string, failureKind = 'renderer_error'): PlaybackState {
  if (!state.current || state.current.playbackInstanceId !== playbackInstanceId) return cloneState()
  markAttributedPlaybackFailed(state.current, failureKind)
  state.status = 'error'
  state.error = '播放失败，请重试。'
  return emitState()
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
    recordHealth('netease', 'degraded', '网易云登录可能过期了。重新登录后我再拿播放链接。')
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

export function recordAppClosedPlayback(): void {
  if (!state.current) return
  const outcome = attributedPlaybackOutcome(state.current, 'app_closed')
  if (outcome) recordAgentActionOutcome(outcome)
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
  urlRefreshInFlight.clear()
  return emitState()
}
