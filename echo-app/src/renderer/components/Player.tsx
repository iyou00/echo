import { KeyboardEvent, MouseEvent, PointerEvent, useCallback, useEffect, useMemo, useRef, useState } from 'react'
import { Heart, ListMusic, Pause, Play, RefreshCw, SkipBack, SkipForward, ThumbsDown, ThumbsUp, Volume2 } from 'lucide-react'
import type { ActiveScene, EchoApi, PlaybackState, PlaybackStatus, Track, UiBoundarySnapshot } from '../../types/ipc'
import { WaveBars } from '../components'
import { pageLabels } from '../labels'
import { decidePlaybackCompletionAction } from './playerCompletion'
import { boundaryPresentation } from '../boundaryPresentation'
import { installMediaSessionActions } from './mediaSession'
import { trackIdentity as trackKey } from '../../shared/trackIdentity'
import { AUDIO_ENERGY_EVENT, energyFromLevels, levelsFromFrequencyData, type AudioEnergyDetail } from '../audioAnalysis'

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
  onOpenQueue?: () => void
  onLocalPlayingChange?: (playing: boolean) => void
  stageDismissed?: boolean
  onExpandStage?: () => void
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

export function Player({ echo, state, setState, refreshQueue, autoPlayNext, currentScene = null, voiceContinuous = false, onSceneTrackEnded, onVoiceTrackEnded, onOpenQueue, onLocalPlayingChange, stageDismissed = false, onExpandStage }: PlayerProps) {
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
  const analysisFrameRef = useRef(0)
  const analysisContextRef = useRef<AudioContext | null>(null)
  const analysisSourceRef = useRef<AudioNode | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const analysisMirrorRef = useRef<HTMLAudioElement | null>(null)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [localPlaying, setLocalPlaying] = useState(false)
  const [playbackError, setPlaybackError] = useState<string | null>(null)
  const [playbackBoundary, setPlaybackBoundary] = useState<UiBoundarySnapshot | null>(null)
  const [favorited, setFavorited] = useState(false)
  const [feedbackState, setFeedbackState] = useState<'more_like_this' | 'not_right' | null>(null)
  const [audioLevels, setAudioLevels] = useState<number[]>([])
  const current = state.current
  const currentId = trackId(current)
  const currentKey = trackKey(current)
  const currentTrackRef = useRef(current)
  currentTrackRef.current = current
  const displayDuration = duration || (current?.durationMs ? current.durationMs / 1000 : 0)
  const progressRatio = displayDuration > 0 ? Math.min(1, currentTime / displayDuration) : 0
  const activeSegments = Math.round(progressRatio * 30)
  const canPlayPrevious = state.history.length > 0
  const canPlayNext = state.queue.length > 0
  const playbackBoundaryCopy = playbackBoundary ? boundaryPresentation(playbackBoundary) : null
  const mediaActionsRef = useRef<{
    play: () => void
    pause: () => void
    previous: () => void
    next: () => void
    seek: (details: MediaSessionActionDetails) => void
  } | null>(null)

  const publishAudioEnergy = useCallback((detail: AudioEnergyDetail) => {
    window.dispatchEvent(new CustomEvent<AudioEnergyDetail>(AUDIO_ENERGY_EVENT, { detail }))
  }, [])

  const stopAudioAnalysis = useCallback(() => {
    window.cancelAnimationFrame(analysisFrameRef.current)
    analysisFrameRef.current = 0
    analysisMirrorRef.current?.pause()
    setAudioLevels([])
    publishAudioEnergy({ energy: 0, levels: [] })
  }, [publishAudioEnergy])

  const startAudioAnalysis = useCallback(async () => {
    const audio = audioRef.current as (HTMLAudioElement & { captureStream?: () => MediaStream }) | null
    if (!audio) return
    let context = analysisContextRef.current
    let analyser = analyserRef.current
    if (!context || !analyser) {
      context = new AudioContext()
      analyser = context.createAnalyser()
      analyser.fftSize = 128
      analyser.smoothingTimeConstant = 0.72
      let source: AudioNode | null = null
      if (audio.captureStream) {
        try {
          const stream = audio.captureStream()
          if (stream.getAudioTracks().length > 0) source = context.createMediaStreamSource(stream)
        } catch {
          source = null
        }
      }
      if (!source) {
        const mirror = new Audio()
        mirror.preload = 'auto'
        const sourceUrl = audio.currentSrc || audio.src
        const resolvedSource = new URL(sourceUrl, window.location.href)
        if (resolvedSource.protocol.startsWith('http') && resolvedSource.origin !== window.location.origin) mirror.crossOrigin = 'anonymous'
        mirror.src = sourceUrl
        mirror.currentTime = audio.currentTime
        analysisMirrorRef.current = mirror
        source = context.createMediaElementSource(mirror)
      }
      const silentOutput = context.createGain()
      silentOutput.gain.value = 0
      source.connect(analyser)
      analyser.connect(silentOutput)
      silentOutput.connect(context.destination)
      analysisContextRef.current = context
      analysisSourceRef.current = source
      analyserRef.current = analyser
    }
    await context.resume()
    const mirror = analysisMirrorRef.current
    if (mirror) {
      const sourceUrl = audio.currentSrc || audio.src
      if (mirror.src !== sourceUrl && mirror.currentSrc !== sourceUrl) {
        mirror.src = sourceUrl
        mirror.load()
      }
      if (Math.abs(mirror.currentTime - audio.currentTime) > 0.35) mirror.currentTime = audio.currentTime
      await mirror.play()
    }
    window.cancelAnimationFrame(analysisFrameRef.current)
    const bins = new Uint8Array(analyser.frequencyBinCount)
    let lastPublishedAt = 0
    const sample = (now: number) => {
      analyser.getByteFrequencyData(bins)
      if (now - lastPublishedAt >= 70) {
        const levels = levelsFromFrequencyData(bins)
        setAudioLevels(levels)
        publishAudioEnergy({ energy: energyFromLevels(levels), levels })
        lastPublishedAt = now
      }
      analysisFrameRef.current = window.requestAnimationFrame(sample)
    }
    analysisFrameRef.current = window.requestAnimationFrame(sample)
  }, [publishAudioEnergy])

  useEffect(() => {
    onLocalPlayingChange?.(localPlaying)
  }, [localPlaying, onLocalPlayingChange])

  useEffect(() => () => onLocalPlayingChange?.(false), [onLocalPlayingChange])

  useEffect(() => () => {
    window.cancelAnimationFrame(analysisFrameRef.current)
    publishAudioEnergy({ energy: 0, levels: [] })
    analysisMirrorRef.current?.pause()
    analysisMirrorRef.current?.removeAttribute('src')
    analysisMirrorRef.current?.load()
    analysisSourceRef.current?.disconnect()
    analysisContextRef.current?.close().catch(() => undefined)
  }, [publishAudioEnergy])

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
    setFeedbackState(null)
    const track = currentTrackRef.current
    if (!track) {
      setFavorited(false)
      return
    }
    let cancelled = false
    echo.favorites.isFavorite(track)
      .then((value) => { if (!cancelled) setFavorited(value) })
      .catch(() => { if (!cancelled) setFavorited(Boolean(track.favorited)) })
    return () => { cancelled = true }
  }, [currentKey, echo])

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
      if (!result.ok) {
        setState(result.state)
        setLocalPlaying(false)
        setPlaybackError(null)
        setPlaybackBoundary(result.boundary)
        return
      }
      setState(result.state)
      setPlaybackBoundary(null)
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

  mediaActionsRef.current = {
    play: () => {
      if (!current?.playUrl) return
      echo.playback.resume().then(setState).catch(() => undefined)
      audioRef.current?.play().catch(() => {
        void handleAudioPlayFailure('播放没有启动，请点一下播放重试。')
      })
    },
    pause: () => {
      audioRef.current?.pause()
      echo.playback.pause().then(setState).catch(() => undefined)
    },
    previous: () => {
      if (canPlayPrevious) void playPrevious()
    },
    next: () => {
      if (canPlayNext) void playNext()
    },
    seek: (details) => {
      if (typeof details.seekTime === 'number') {
        void seekToSeconds(details.seekTime, true)
        return
      }
      const offset = details.seekOffset ?? 10
      const direction = details.action === 'seekbackward' ? -1 : 1
      void seekToSeconds(currentTime + direction * offset, true)
    },
  }

  useEffect(() => {
    const mediaSession = navigator.mediaSession
    if (!mediaSession) return undefined
    mediaSession.metadata = current
      ? new MediaMetadata({ title: current.title, artist: current.artist, album: current.album ?? 'Echo' })
      : null
    mediaSession.playbackState = current
      ? localPlaying || state.status === 'playing' ? 'playing' : 'paused'
      : 'none'
    return installMediaSessionActions(mediaSession, {
      play: () => mediaActionsRef.current?.play(),
      pause: () => mediaActionsRef.current?.pause(),
      previous: () => mediaActionsRef.current?.previous(),
      next: () => mediaActionsRef.current?.next(),
      seek: (details) => mediaActionsRef.current?.seek(details),
    })
  }, [current, localPlaying, state.status])

  useEffect(() => {
    const mediaSession = navigator.mediaSession
    if (!mediaSession || !current || displayDuration <= 0) return
    try {
      mediaSession.setPositionState({
        duration: displayDuration,
        playbackRate: audioRef.current?.playbackRate ?? 1,
        position: Math.min(displayDuration, Math.max(0, currentTime)),
      })
    } catch {
      // Metadata is still useful when position state is temporarily invalid.
    }
  }, [current, currentTime, displayDuration])

  async function toggleCurrentFavorite() {
    if (!current) return
    const result = await echo.favorites.toggle(current)
    setFavorited(result.favorited)
  }

  async function recordCurrentFeedback(action: 'more_like_this' | 'not_right') {
    if (!current) return
    await echo.feedback.record(current, action, 'sound_object')
    setFeedbackState(action)
  }
  const companionArtwork = './visuals/context-companion.png'
  const artwork = current?.artworkUrl || companionArtwork

  return (
    <footer className={`mini-player global-player ${current ? 'has-track' : 'empty-track'}`}>
      <audio
        ref={audioRef}
        onPlay={() => {
          setLocalPlaying(true)
          void startAudioAnalysis().catch(() => stopAudioAnalysis())
          setPlaybackError(null)
          setPlaybackBoundary(null)
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
          stopAudioAnalysis()
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
      <figure
        className="d2-sound-object"
        role="button"
        tabIndex={current?.playUrl ? 0 : -1}
        aria-label={stageDismissed && current ? `回到一起听 ${current.title}` : current ? `${localPlaying ? '暂停' : '播放'} ${current.title}` : '还没有可播放歌曲'}
        onClick={(event) => {
          if ((event.target as HTMLElement).closest('button, input, label')) return
          if (stageDismissed && current && onExpandStage) {
            onExpandStage()
            return
          }
          void togglePlayback().catch(() => undefined)
        }}
        onKeyDown={(event) => {
          if (event.key !== 'Enter' && event.key !== ' ') return
          event.preventDefault()
          if (stageDismissed && current && onExpandStage) {
            onExpandStage()
            return
          }
          void togglePlayback().catch(() => undefined)
        }}
      >
        <div className="d2-sound-art">
          <img
            src={artwork}
            alt={current?.artworkUrl ? `${current.title} 的专辑封面` : 'Echo 情境视觉，两段声音在同一路径相遇'}
            onError={(event) => {
              if (!event.currentTarget.src.includes('/visuals/context-companion.png')) event.currentTarget.src = companionArtwork
            }}
          />
          <div className="d2-sound-tools">
            <button type="button" onClick={() => playPrevious().catch(() => undefined)} disabled={!canPlayPrevious} title="上一曲" aria-label="上一曲"><SkipBack size={14} /></button>
            <button type="button" onClick={() => togglePlayback().catch(() => undefined)} disabled={!current?.playUrl} title={localPlaying ? '暂停' : '播放'} aria-label={localPlaying ? '暂停' : '播放'}>
              {localPlaying ? <Pause size={14} fill="currentColor" /> : <Play size={14} fill="currentColor" />}
            </button>
            <button type="button" onClick={() => playNext().catch(() => undefined)} disabled={!canPlayNext} title="下一曲" aria-label="下一曲"><SkipForward size={14} /></button>
            {onOpenQueue && <button type="button" onClick={onOpenQueue} title="打开队列" aria-label="打开队列"><ListMusic size={14} /></button>}
            <label className="d2-volume-control" title={`音量 ${state.volume}%`}>
              <Volume2 size={14} aria-hidden="true" />
              <input
                type="range"
                min={0}
                max={100}
                value={state.volume}
                aria-label="播放音量"
                onChange={(event) => {
                  void echo.playback.setVolume(Number(event.target.value)).then(setState).catch(() => undefined)
                }}
              />
            </label>
          </div>
        </div>
        <figcaption>
          <div className="player-copy">
            <div className="player-title">{current?.title ?? `还没有${pageLabels.queue}`}</div>
            <div className="player-artist">
              {playbackBoundaryCopy ? (
                <span className="player-recovery">
                  <span>{playbackBoundaryCopy.title}</span>
                  <button type="button" title="重试播放链接" aria-label="重试播放链接" onClick={() => {
                    retryCountRef.current = 0
                    void recoverUrl()
                  }}>
                    <RefreshCw size={11} />
                  </button>
                </span>
              ) : playbackError ? (
                <span className="error-text">{playbackError}</span>
              ) : (
                current ? `${current.artist}${current.album ? ` · ${current.album}` : ''}` : '你开口以后，声音会在这里出现'
              )}
            </div>
            {current && (
              <div className="d2-object-feedback" aria-label="歌曲反馈">
                <button className={feedbackState === 'more_like_this' ? 'active' : ''} type="button" onClick={() => { void recordCurrentFeedback('more_like_this').catch(() => setPlaybackError('反馈没记下，可以稍后再试。')) }} title="多来这种" aria-label="多来这种"><ThumbsUp size={12} /></button>
                <button className={feedbackState === 'not_right' ? 'active' : ''} type="button" onClick={() => { void recordCurrentFeedback('not_right').catch(() => setPlaybackError('反馈没记下，可以稍后再试。')) }} title="这首不对" aria-label="这首不对"><ThumbsDown size={12} /></button>
                <button className={favorited ? 'active' : ''} type="button" onClick={() => { void toggleCurrentFavorite().catch(() => setPlaybackError('收藏没保存，可以稍后再试。')) }} title={favorited ? '取消收藏' : '收藏'} aria-label={favorited ? '取消收藏' : '收藏'}><Heart size={12} fill={favorited ? 'currentColor' : 'none'} /></button>
              </div>
            )}
          </div>
          <button className="d2-object-play" type="button" onClick={() => togglePlayback().catch(() => undefined)} disabled={!current?.playUrl} title={localPlaying ? '暂停' : '播放'}>
            {localPlaying ? <Pause size={15} fill="currentColor" /> : <Play size={15} fill="currentColor" />}
          </button>
        </figcaption>
      </figure>

      <section className="d2-listening-panel" aria-live="polite">
        <span className="d2-listening-kicker">ECHO · 一起听</span>
        <h2>{current?.reason ?? current?.echoNote ?? '这首不用听懂，先让它把眼前撑开一点。'}</h2>
        <p>{current ? '音乐继续走，你不用一直回应。' : '你想听点什么时，叫我一声。'}</p>
        <div className="player-controls d2-listen-controls">
          <button type="button" onClick={() => playPrevious().catch(() => undefined)} disabled={!canPlayPrevious} title="上一曲"><SkipBack size={15} /></button>
          <button className="main" type="button" onClick={() => togglePlayback().catch(() => undefined)} disabled={!current?.playUrl}>
            {localPlaying ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}
          </button>
          <button type="button" onClick={() => playNext().catch(() => undefined)} disabled={!canPlayNext} title="下一曲"><SkipForward size={15} /></button>
          <div className="seg-progress">
            <div
              className="seg-track"
              onClick={(event) => seekFromEvent(event).catch(() => undefined)}
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
              {Array.from({ length: 30 }).map((_, index) => <i key={index} className={index < activeSegments ? 'on' : ''} />)}
            </div>
            <div className="d2-progress-time"><span>{formatClock(currentTime)}</span><span>{formatClock(displayDuration)}</span></div>
          </div>
        </div>
        <div className="d2-listening-status"><span>{voiceContinuous ? '连续回声 · 正在继续' : '安静陪伴'}</span><strong>{canPlayNext ? '下一首已经接好' : '听完这一首再决定'}</strong></div>
        <WaveBars active={localPlaying} levels={audioLevels} />
      </section>
    </footer>
  )
}
