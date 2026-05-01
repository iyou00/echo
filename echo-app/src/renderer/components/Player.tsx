import { MouseEvent, PointerEvent, useEffect, useMemo, useRef, useState } from 'react'
import { Pause, Play } from 'lucide-react'
import type { EchoApi, PlaybackState, PlaybackStatus, Track } from '../../types/ipc'
import { WaveBars } from '../components'
import { pageLabels } from '../labels'

interface PlayerProps {
  echo: EchoApi
  state: PlaybackState
  setState: (state: PlaybackState) => void
  refreshQueue: () => Promise<Track[]>
  autoPlayNext: boolean
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

export function Player({ echo, state, setState, refreshQueue, autoPlayNext }: PlayerProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const loadedTrackRef = useRef('')
  const applyingSeekRef = useRef(false)
  const endingRef = useRef(false)
  const completingRef = useRef(false)
  const lastHeartbeatRef = useRef(0)
  const draggingSeekRef = useRef(false)
  const lastUserSeekAtRef = useRef(0)
  const [currentTime, setCurrentTime] = useState(0)
  const [duration, setDuration] = useState(0)
  const [localPlaying, setLocalPlaying] = useState(false)
  const current = state.current
  const currentId = trackId(current)
  const displayDuration = duration || (current?.durationMs ? current.durationMs / 1000 : 0)
  const progressRatio = displayDuration > 0 ? Math.min(1, currentTime / displayDuration) : 0
  const activeSegments = Math.round(progressRatio * 30)
  const canPlayPrevious = state.history.length > 0
  const canPlayNext = state.queue.length > 0

  function isNearEnd(audio: HTMLAudioElement | null) {
    if (!audio || !current) return false
    const mediaDuration = Number.isFinite(audio.duration) && audio.duration > 0 ? audio.duration : displayDuration
    if (!mediaDuration || mediaDuration <= 0) return false
    return audio.ended || audio.currentTime >= mediaDuration - 0.2
  }

  async function completePlayback() {
    if (completingRef.current) return
    completingRef.current = true
    endingRef.current = true
    setLocalPlaying(false)
    try {
      await sendHeartbeat(true, 'playing')
      const next = autoPlayNext ? await echo.playback.next() : await echo.playback.finishCurrent()
      setState(next)
      await refreshQueue()
    } finally {
      window.setTimeout(() => {
        endingRef.current = false
        completingRef.current = false
      }, 300)
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
      audio.play().catch(() => undefined)
    })
  }, [currentId, echo])

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
      audio.play().catch(() => undefined)
    }
    if (state.status === 'paused') audio.pause()
  }, [current, currentId, state.status])

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
      position: Math.floor(audio.currentTime * 1000),
      duration: Math.floor((audio.duration || displayDuration) * 1000),
      status,
    })
    setState(next)
  }

  async function togglePlayback() {
    if (!current?.playUrl) return
    const next = state.status === 'playing' || localPlaying ? await echo.playback.pause() : await echo.playback.resume()
    setState(next)
  }

  async function playPrevious() {
    const next = await echo.playback.prev()
    setState(next)
    await refreshQueue()
  }

  async function playNext() {
    const next = await echo.playback.next()
    setState(next)
    await refreshQueue()
  }

  async function seekFromClientX(clientX: number, target: HTMLDivElement, persist: boolean) {
    if (!current || displayDuration <= 0) return
    const rect = target.getBoundingClientRect()
    const ratio = Math.min(1, Math.max(0, (clientX - rect.left) / rect.width))
    const nextPosition = Math.floor(ratio * displayDuration * 1000)
    const audio = audioRef.current
    if (audio) audio.currentTime = nextPosition / 1000
    setCurrentTime(nextPosition / 1000)
    lastUserSeekAtRef.current = Date.now()
    if (persist) {
      const next = await echo.playback.seek(nextPosition)
      setState(next)
      // seek 落定后立刻发一次 force 心跳，让主进程的 position 与本地 audio 对齐，避免被节流跳过。
      await sendHeartbeat(true)
    }
  }

  async function seekFromEvent(event: MouseEvent<HTMLDivElement>) {
    await seekFromClientX(event.clientX, event.currentTarget, true)
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
    seekFromClientX(event.clientX, event.currentTarget, true)
  }

  async function recoverUrl() {
    if (!currentId) return
    const audio = audioRef.current
    const oldPos = audio?.currentTime ?? 0
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
    }
  }

  return (
    <footer className="mini-player global-player">
      <audio
        ref={audioRef}
        onPlay={async () => {
          setLocalPlaying(true)
          const next = await echo.playback.heartbeat({
            position: Math.floor((audioRef.current?.currentTime ?? 0) * 1000),
            duration: Math.floor((audioRef.current?.duration || displayDuration) * 1000),
            status: 'playing',
          })
          setState(next)
        }}
        onPause={() => {
          setLocalPlaying(false)
          if (isNearEnd(audioRef.current)) {
            completePlayback().catch(() => undefined)
            return
          }
          if (endingRef.current || audioRef.current?.ended) return
          sendHeartbeat(true, 'paused')
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
          sendHeartbeat()
        }}
      />
      <WaveBars active={localPlaying} />
      <div className="player-row">
        <div className="player-copy">
          <div className="player-title">{current?.title ?? `还没有${pageLabels.queue}`}</div>
          <div className="player-artist">{current?.artist ?? '让 Echo 推荐后，这里开始播放'}</div>
        </div>
        <div className="player-controls">
          <button type="button" onClick={playPrevious} disabled={!canPlayPrevious} title="上一曲">‹</button>
          <button className="main" type="button" onClick={togglePlayback} disabled={!current?.playUrl}>
            {localPlaying ? <Pause size={14} fill="currentColor" /> : <Play size={14} fill="currentColor" />}
          </button>
          <button type="button" onClick={playNext} disabled={!canPlayNext} title="下一曲">›</button>
        </div>
      </div>
      <div className="seg-progress">
        <span>{formatClock(currentTime)}</span>
        <div
          className="seg-track"
          onClick={seekFromEvent}
          onPointerDown={startSeekDrag}
          onPointerMove={moveSeekDrag}
          onPointerUp={stopSeekDrag}
          onPointerCancel={stopSeekDrag}
          role="presentation"
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
