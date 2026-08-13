import { KeyboardEvent, MouseEvent, PointerEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Pause, Play } from 'lucide-react'
import type { ActiveScene, EchoApi, PlaybackState, PlaybackStatus, Track } from '../../types/ipc'
import { WaveBars } from '../components'
import { pageLabels } from '../labels'
import { decidePlaybackCompletionAction } from './playerCompletion'

interface PlayerProps {
  echo: EchoApi
  state: PlaybackState
  setState: (state: PlaybackState) => void
  refreshQueue: () => Promise<Track[]>
  autoPlayNext: boolean
  currentScene?: ActiveScene | null
  voiceContinuous?: boolean
  onSceneTrackEnded?: (scene: ActiveScene, mode: 'continue' | 'refill') => void | Promise<void>
  onVoiceTrackEnded?: () => void
}

function formatClock(seconds: number) {
  if (!Number.isFinite(seconds) || seconds <= 0) return '00:00'
  const mins = Math.floor(seconds / 60)
  const secs = Math.floor(seconds % 60)
  return `${String(mins).padStart(2, '0')}:${String(secs).padStart(2, '0')}`
}

function trackId(track?: Track | null): string {
  return track?.id ?? track?.neteaseId ?? ''
}

// 用户主动 seek 后的"安静期"：在这窗口里收到主进程广播的 state.position 不再反向修正 audio.currentTime，
// 避免与正在进行的拖拽、或拖拽完瞬间收到的旧心跳互相打架，造成听感上的来回跳。
const USER_SEEK_QUIET_MS = 1000

export function Player({ echo, state, setState, refreshQueue, autoPlayNext, currentScene = null, voiceContinuous = false, onSceneTrackEnded, onVoiceTrackEnded }: PlayerProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const loadedTrackRef = useRef('')
  const applyingSeekRef = useRef(false)
  const endingRef = useRef(false)
  const completingRef = useRef(false)
  const lastHeartbeatRef = useRef(0)
  const draggingSeekRef = useRef(false)
  const lastUserSeekAtRef = useRef(0)
  const retryCountRef = useRef(0)
  const lastRetryTimeRef = useRef(0)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [localPlaying, setLocalPlaying] = useState(false)
  const [playbackError, setPlaybackError] = useState<string | null>(null)
  const current = state.current
  const currentId = trackId(current)
  const displayDuration = duration || (current?.durationMs ? current.durationMs / 1000 : 0)
  const progressRatio = displayDuration > 0 ? Math.min(1, currentTime / displayDuration) : 0
  const activeSegments = Math.round(progressRatio * 30)
  const canPlayPrevious = state.history.length > 0
  const canPlayNext = state.queue.length > 0

  const handleAudioPlayFailure = useCallback(async (message: string) => {
    setLocalPlaying(false)
    setPlaybackError(message)
    try {
      const next = await echo.playback.pause()
      setState(next)
    } catch {
      // Keep the local error visible even if the main process is unavailable.
    }
  }, [echo, setState])

  function isNearEnd(audio: HTMLAudioElement | null) {
    if (!audio || !current) return false
    const mediaDuration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : displayDuration
    if (!mediaDuration || mediaDuration <= 0) return false
    return audio.ended || audio.currentTime >= mediaDuration - 0.2
  }

  async function completePlayback() {
    if (completingRef.current) return
    const completionAction = decidePlaybackCompletionAction({ voiceContinuous, currentScene, current, queue: state.queue, autoPlayNext })
    const shouldContinueVoice = completionAction === 'voice_continue'
    completingRef.current = true
    endingRef.current = true
    setLocalPlaying(false)
    try {
      await sendHeartbeat(true, 'playing')
      const next = completionAction === 'auto_next' || completionAction === 'scene_next'
        ? await echo.playback.next(current?.playbackInstanceId)
        : await echo.playback.finishCurrent(current?.playbackInstanceId)
      setState(next)
      await refreshQueue()
      if (shouldContinueVoice) onVoiceTrackEnded?.()
      if (completionAction === 'scene_continue' && currentScene) await onSceneTrackEnded?.(currentScene, 'continue')
      if (completionAction === 'scene_next' && currentScene && next.queue.length < 2) await onSceneTrackEnded?.(currentScene, 'refill')
      
      // If the track did not change (e.g., end of queue), reset flags manually since the useEffect won't trigger
      if (trackId(next.current) === currentId) {
        completingRef.current = false
        endingRef.current = false
      }
    } catch (err) {
      completingRef.current = false
      endingRef.current = false
    }
  }

  useEffect(() => {
    if (!window.echo) return undefined
    return echo.playback.onUrlRefreshed((payload) => {
      const audio = audioRef.current
      if (!audio || payload.trackId !== currentId) return
      const oldPos = audio.currentTime
      audio.src = payload.url
      audio.currentTime = oldPos
      audio.play().catch(() => {
        void handleAudioPlayFailure('播放恢复失败，请点一下播放重试。')
      })
    })
  }, [currentId, echo, handleAudioPlayFailure])

  useEffect(() => {
    completingRef.current = false
    endingRef.current = false
    retryCountRef.current = 0
    setPlaybackError(null)
  }, [currentId])

  useEffect(() => {
    const audio = audioRef.current
    if (!audio || !current?.playUrl) {
      loadedTrackRef.current = ''
      setLocalPlaying(false)
      return
    }

    const nextLoadedId = `${currentId}:${current.playUrl}`
    if (loadedTrackRef.current !== nextLoadedId) {
      loadedTrackRef.current = nextLoadedId
      setCurrentTime(0)
      setDuration(current.durationMs ? current.durationMs / 1000 : 0)
      audio.pause()
      audio.removeAttribute('src')
      audio.load()
      audio.src = current.playUrl
      audio.load()
      completingRef.current = false
      endingRef.current = false
    }

    if (state.status === 'loading' || state.status === 'playing') {
      audio.play().catch(() => {
        void handleAudioPlayFailure('播放没有启动，请点一下播放重试。')
      })
    }
    if (state.status === 'paused') audio.pause()
  }, [current, currentId, handleAudioPlayFailure, state.status])

  useEffect(() => {
    const audio = audioRef.current
    if (!audio || applyingSeekRef.current) return
    if (draggingSeekRef.current) return
    if (Date.now() - lastUserSeekAtRef.current < USER_SEEK_QUIET_MS) return
    const target = state.position / 1000
    if (target > 0 && Math.abs(audio.currentTime - target) > 1.2) {
      applyingSeekRef.current = true
      audio.currentTime = target
      window.setTimeout(() => {
        applyingSeekRef.current = false
      }, 120)
    }
  }, [state.position])

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return
    audio.volume = Math.max(0, Math.min(1, state.volume / 100))
  }, [state.volume])

  const heartbeatStatus = useMemo<PlaybackStatus>(() => {
    if (!current) return 'idle'
    if (localPlaying) return 'playing'
    return state.status === 'loading' ? 'loading' : 'paused'
  }, [current, localPlaying, state.status])

  async function sendHeartbeat(force = false, status: PlaybackStatus = heartbeatStatus) {
    const audio = audioRef.current
    if (!audio || !current) return
    // 拖拽过程中暂停心跳，避免还没松手就把中间的 currentTime 当成"权威 position"广播出去。
    if (!force && draggingSeekRef.current) return
    const now = Date.now()
    if (!force && now - lastHeartbeatRef.current < 5000) return
    lastHeartbeatRef.current = now
    const next = await echo.playback.heartbeat({
      playbackInstanceId: current.playbackInstanceId,
      position: Math.floor(audio.currentTime * 1000),
      duration: Math.floor((audio.duration || displayDuration) * 1000),
      status,
    })
    setState(next)
  }

  async function togglePlayback() {
    if (!current?.playUrl) return
    const shouldPause = state.status === 'playing' || localPlaying
    const next = shouldPause ? await echo.playback.pause() : await echo.playback.resume()
    setState(next)
    if (!shouldPause) {
      await audioRef.current?.play().catch(() => {
        void handleAudioPlayFailure('播放没有启动，请点一下播放重试。')
      })
    }
  }

  async function playPrevious() {
    const next = await echo.playback.prev()
    setState(next)
    await refreshQueue()
  }

  async function playNext() {
    const next = await echo.playback.next(current?.playbackInstanceId)
    setState(next)
    await refreshQueue()
  }

  async function seekToSeconds(seconds: number, persist: boolean) {
    if (!current || displayDuration <= 0) return
    const boundedSeconds = Math.min(displayDuration, Math.max(0, seconds))
    const nextPosition = Math.floor(boundedSeconds * 1000)
    const audio = audioRef.current
    if (audio) audio.currentTime = boundedSeconds
    setCurrentTime(boundedSeconds)
    lastUserSeekAtRef.current = Date.now()
    if (persist) {
      const next = await echo.playback.seek(nextPosition)
      setState(next)
      // seek 落定后立刻发一次 force 心跳，让主进程的 position 与本地 audio 对齐，避免被节流跳过。
      await sendHeartbeat(true)
    }
  }

  async function seekFromClientX(clientX: number, target: HTMLDivElement, persist: boolean) {
    if (!current || displayDuration <= 0) return
    const rect = target.getBoundingClientRect()
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    await seekToSeconds(ratio * displayDuration, persist)
  }

  async function seekFromEvent(event: MouseEvent<HTMLDivElement>) {
    await seekFromClientX(event.clientX, event.currentTarget, true)
  }

  async function seekFromKeyboard(event: KeyboardEvent<HTMLDivElement>) {
    if (!current || displayDuration <= 0) return
    const step = event.shiftKey ? 30 : 5
    const next = (() => {
      if (event.key === 'ArrowLeft') return currentTime - step
      if (event.key === 'ArrowRight') return currentTime + step
      if (event.key === 'PageDown') return currentTime - 30
      if (event.key === 'PageUp') return currentTime + 30
      if (event.key === 'Home') return 0
      if (event.key === 'End') return displayDuration
      return null
    })()
    if (next === null) return
    event.preventDefault()
    await seekToSeconds(next, true)
  }

  function startSeekDrag(event: PointerEvent<HTMLDivElement>) {
    draggingSeekRef.current = true
    event.currentTarget.setPointerCapture(event.pointerId)
    // 拖拽开始：先在本地预览，不写主进程 state，等松手再持久化。
    seekFromClientX(event.clientX, event.currentTarget, false)
  }

  function moveSeekDrag(event: PointerEvent<HTMLDivElement>) {
    if (!draggingSeekRef.current) return
    seekFromClientX(event.clientX, event.currentTarget, false)
  }

  function stopSeekDrag(event: PointerEvent<HTMLDivElement>) {
    if (!draggingSeekRef.current) return
    draggingSeekRef.current = false
    event.currentTarget.releasePointerCapture(event.pointerId)
    seekFromClientX(event.clientX, event.currentTarget, true).catch(() => undefined)
  }

  async function recoverUrl() {
    if (!currentId) return
    const audio = audioRef.current
    const oldPos = audio?.currentTime ?? 0
    const now = Date.now()
    
    if (now - lastRetryTimeRef.current > 10000) {
      retryCountRef.current = 0
    }
    lastRetryTimeRef.current = now
    retryCountRef.current += 1
    
    if (retryCountRef.current > 3) {
      setLocalPlaying(false)
      setPlaybackError('播放链接失效且重试失败，请检查网络或重新登录。')
      echo.playback.pause().then(setState).catch(() => undefined)
      if (current?.playbackInstanceId) echo.playback.reportError(current.playbackInstanceId, 'url_retry_exhausted').then(setState).catch(() => undefined)
      return
    }

    try {
      const result = await echo.playback.refreshUrl(currentId)
      setState(result.state)
      if (audio && result.track.playUrl) {
        audio.src = result.track.playUrl
        audio.currentTime = oldPos
        await audio.play()
      }
    } catch {
      setLocalPlaying(false)
      setPlaybackError('自动刷新播放链接失败，请重试。')
      echo.playback.pause().then(setState).catch(() => undefined)
      if (current?.playbackInstanceId) echo.playback.reportError(current.playbackInstanceId, 'url_refresh_failed').then(setState).catch(() => undefined)
    }
  }

  return (
    <footer className="mini-player global-player">
      <audio
        ref={audioRef}
        onPlay={() => {
          setLocalPlaying(true)
          setPlaybackError(null)
          retryCountRef.current = 0
          echo.playback.heartbeat({
            playbackInstanceId: current?.playbackInstanceId,
            position: Math.floor((audioRef.current?.currentTime ?? 0) * 1000),
            duration: Math.floor((audioRef.current?.duration || displayDuration) * 1000),
            status: 'playing',
          }).then(setState).catch(() => undefined)
        }}
        onPause={() => {
          setLocalPlaying(false)
          if (isNearEnd(audioRef.current)) {
            completePlayback().catch(() => undefined)
            return
          }
          if (endingRef.current || audioRef.current?.ended) return
          sendHeartbeat(true, 'paused').catch(() => undefined)
        }}
        onEnded={() => completePlayback().catch(() => undefined)}
        onError={recoverUrl}
        onLoadedMetadata={(event) => setDuration(event.currentTarget.duration || (current?.durationMs ? current.durationMs / 1000 : 0))}
        onTimeUpdate={(event) => {
          setCurrentTime(event.currentTarget.currentTime)
          if (isNearEnd(event.currentTarget)) {
            completePlayback().catch(() => undefined)
            return
          }
          sendHeartbeat().catch(() => undefined)
        }}
      />
      <WaveBars active={localPlaying} />
      <div className="player-row">
        <div className="player-copy">
          <div className="player-title">{current?.title ?? `还没有${pageLabels.queue}`}</div>
          <div className="player-artist">
            {playbackError ? (
              <span className="error-text" style={{ color: '#ff6b6b', fontSize: '0.85em' }}>
                {playbackError}
              </span>
            ) : (
              current?.artist ?? '让 Echo 推荐后，这里开始播放'
            )}
          </div>
        </div>
        <div className="player-controls">
          <button type="button" onClick={() => playPrevious().catch(() => undefined)} disabled={!canPlayPrevious} title="上一曲">‹</button>
          <button className="main" type="button" onClick={() => togglePlayback().catch(() => undefined)} disabled={!current?.playUrl}>
            {localPlaying ? <Pause size={14} fill="currentColor" /> : <Play size={14} fill="currentColor" />}
          </button>
          <button type="button" onClick={() => playNext().catch(() => undefined)} disabled={!canPlayNext} title="下一曲">›</button>
        </div>
      </div>
      <div className="seg-progress">
        <span>{formatClock(currentTime)}</span>
        <div
          className="seg-track"
          onClick={(e) => seekFromEvent(e).catch(() => undefined)}
          onPointerDown={startSeekDrag}
          onPointerMove={moveSeekDrag}
          onPointerUp={stopSeekDrag}
          onPointerCancel={stopSeekDrag}
          onKeyDown={(event) => { void seekFromKeyboard(event).catch(() => undefined) }}
          role="slider"
          tabIndex={current ? 0 : -1}
          aria-label="播放进度"
          aria-valuemin={0}
          aria-valuemax={Math.max(0, Math.floor(displayDuration))}
          aria-valuenow={Math.max(0, Math.floor(currentTime))}
          aria-valuetext={`${formatClock(currentTime)} / ${formatClock(displayDuration)}`}
          aria-disabled={!current}
        >
          {Array.from({ length: 30 }).map((_, index) => (
            <i key={index} className={index < activeSegments ? 'on' : ''} />
          ))}
        </div>
        <span>{formatClock(displayDuration)}</span>
      </div>
    </footer>
  )
}
