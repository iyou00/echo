import { useCallback, useEffect, useRef, useState } from 'react'
import { Volume2, VolumeX } from 'lucide-react'
import { WindowField } from '../shell/WindowField'
import { welcomeExitDelay } from './firstRunWelcomePolicy'

interface FirstRunWelcomeProps {
  onContinue: () => Promise<void> | void
}

const TARGET_VOLUME = 0.22
const FADE_IN_MS = 3600
const DEVICE_CHANGE_RETRY_MS = 600
const WELCOME_AUDIO_SRC = './welcome/first-run-welcome.mp3'

function fadeAudio(audio: HTMLAudioElement, from: number, to: number, duration: number, after?: () => void) {
  const startedAt = performance.now()
  let frame = 0

  function step(now: number) {
    const progress = Math.min(1, (now - startedAt) / duration)
    audio.volume = from + (to - from) * progress
    if (progress < 1) {
      frame = requestAnimationFrame(step)
      return
    }
    after?.()
  }

  frame = requestAnimationFrame(step)
  return () => cancelAnimationFrame(frame)
}

export function FirstRunWelcome({ onContinue }: FirstRunWelcomeProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const cancelFadeRef = useRef<(() => void) | null>(null)
  const deviceRetryTimerRef = useRef<number | null>(null)
  const continueTimerRef = useRef<number | null>(null)
  const playAttemptRef = useRef(0)
  const userMutedRef = useRef(false)
  const leavingRef = useRef(false)
  const startedRef = useRef(false)
  const mountedRef = useRef(true)
  const [muted, setMuted] = useState(false)
  const [leaving, setLeaving] = useState(false)
  const [started, setStarted] = useState(false)
  const [audioUnavailable, setAudioUnavailable] = useState(false)
  const [continueError, setContinueError] = useState(false)
  const [reducedMotion] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches)

  const stopFade = useCallback(() => {
    cancelFadeRef.current?.()
    cancelFadeRef.current = null
  }, [])

  const stopWelcomeAudio = useCallback((options: { releaseSource?: boolean } = {}) => {
    const audio = audioRef.current
    playAttemptRef.current += 1
    stopFade()
    if (deviceRetryTimerRef.current !== null) {
      window.clearTimeout(deviceRetryTimerRef.current)
      deviceRetryTimerRef.current = null
    }
    if (!audio) return
    audio.pause()
    audio.currentTime = 0
    audio.volume = 0
    if (options.releaseSource) {
      audio.removeAttribute('src')
      audio.load()
    }
  }, [stopFade])

  const startWelcomeAudio = useCallback(async (options: { restart?: boolean; reloadSource?: boolean } = {}) => {
    const audio = audioRef.current
    if (!audio || userMutedRef.current || !mountedRef.current) return false

    const attempt = ++playAttemptRef.current
    stopFade()

    if (options.restart) audio.pause()
    if (options.reloadSource) {
      audio.load()
    } else if (options.restart || audio.ended) {
      audio.currentTime = 0
    }

    audio.muted = false
    audio.volume = 0
    try {
      await audio.play()
      if (!mountedRef.current || userMutedRef.current || attempt !== playAttemptRef.current) return false
      cancelFadeRef.current = fadeAudio(audio, 0, TARGET_VOLUME, FADE_IN_MS)
      return true
    } catch (error) {
      if (attempt === playAttemptRef.current) {
        console.warn('[welcome] audio playback could not start', error)
      }
      return false
    }
  }, [stopFade])

  const scheduleOutputRetry = useCallback((delayMs = DEVICE_CHANGE_RETRY_MS) => {
    if (userMutedRef.current || leavingRef.current || !mountedRef.current) return
    if (deviceRetryTimerRef.current !== null) {
      window.clearTimeout(deviceRetryTimerRef.current)
    }
    deviceRetryTimerRef.current = window.setTimeout(() => {
      deviceRetryTimerRef.current = null
      void startWelcomeAudio({ restart: true, reloadSource: true })
    }, delayMs)
  }, [startWelcomeAudio])

  useEffect(() => {
    mountedRef.current = true

    const mediaDevices = navigator.mediaDevices
    const handleOutputMayHaveChanged = () => {
      if (startedRef.current) scheduleOutputRetry()
    }
    const handleVisibilityChange = () => {
      if (startedRef.current && document.visibilityState === 'visible') scheduleOutputRetry()
    }
    mediaDevices?.addEventListener?.('devicechange', handleOutputMayHaveChanged)
    window.addEventListener('focus', handleOutputMayHaveChanged)
    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      mountedRef.current = false
      mediaDevices?.removeEventListener?.('devicechange', handleOutputMayHaveChanged)
      window.removeEventListener('focus', handleOutputMayHaveChanged)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      if (continueTimerRef.current !== null) window.clearTimeout(continueTimerRef.current)
      stopWelcomeAudio({ releaseSource: true })
    }
  }, [scheduleOutputRetry, stopWelcomeAudio])

  async function startExperience(withSound: boolean) {
    userMutedRef.current = !withSound
    startedRef.current = true
    setMuted(!withSound)
    setStarted(true)
    setAudioUnavailable(false)
    if (!withSound) return
    const played = await startWelcomeAudio({ restart: true, reloadSource: true })
    if (!played && mountedRef.current) setAudioUnavailable(true)
  }

  function toggleMute() {
    const audio = audioRef.current
    const nextMuted = !userMutedRef.current
    userMutedRef.current = nextMuted
    setMuted(nextMuted)
    stopFade()
    if (!audio) return

    if (nextMuted) {
      stopWelcomeAudio()
      audio.muted = true
      return
    }

    audio.muted = false
    void startWelcomeAudio({ restart: audio.ended })
  }

  function continueToOnboarding() {
    if (leavingRef.current) return
    leavingRef.current = true
    setLeaving(true)
    setContinueError(false)
    const exitDelay = welcomeExitDelay(reducedMotion)
    const audio = audioRef.current
    if (audio && !audio.paused && audio.volume > 0) {
      stopFade()
      cancelFadeRef.current = fadeAudio(audio, audio.volume, 0, exitDelay, () => {
        stopWelcomeAudio({ releaseSource: true })
      })
    } else {
      stopWelcomeAudio({ releaseSource: true })
    }
    continueTimerRef.current = window.setTimeout(() => {
      continueTimerRef.current = null
      Promise.resolve(onContinue()).catch(() => {
        if (!mountedRef.current) return
        leavingRef.current = false
        setLeaving(false)
        setContinueError(true)
        if (startedRef.current && !userMutedRef.current) {
          void startWelcomeAudio({ restart: true, reloadSource: true })
        }
      })
    }, exitDelay)
  }

  return (
    <div
      className={leaving ? 'first-run-welcome-layer first-run-leaving' : 'first-run-welcome-layer'}
      onPointerDownCapture={() => {
        const audio = audioRef.current
        if (started && !userMutedRef.current && audio?.paused && !leaving) {
          void startWelcomeAudio({ restart: audio.ended })
        }
      }}
    >
      <audio ref={audioRef} src={WELCOME_AUDIO_SRC} preload="auto" />
      <WindowField mode="welcome" />
      <button data-testid="first-run-skip" className="first-run-skip" type="button" onClick={continueToOnboarding} disabled={leaving}>跳过前奏</button>
      {started && (
        <button className="first-run-mute" type="button" onClick={toggleMute} aria-label={muted ? '打开声音' : '静音'}>
          {muted ? <VolumeX size={15} /> : <Volume2 size={15} />}
          <span>{muted ? '打开声音' : '静音'}</span>
        </button>
      )}

      <section className="first-run-welcome-stage" aria-label="Echo 首次欢迎">
        {!started ? (
          <div className="first-run-gate">
            <div className="first-run-kicker">E C H O · F I R S T L I G H T</div>
            <h1>让我们从一段声音开始。</h1>
            <p>这段前奏只在第一次见面时播放。</p>
            <div className="first-run-gate-actions">
              <button data-testid="first-run-sound" className="first-run-sound" type="button" onClick={() => { void startExperience(true) }}>
                <Volume2 size={15} />开启声音
              </button>
              <button data-testid="first-run-silent" className="first-run-silent" type="button" onClick={() => { void startExperience(false) }}>
                <VolumeX size={15} />静音进入
              </button>
            </div>
          </div>
        ) : (
          <div className="first-run-sequence">
            <div className="first-run-legend" aria-hidden="true"><span>你</span><span>Echo</span></div>
            <div className="first-run-lines">
              <div className="first-run-line first-run-line-1">你好。</div>
              <div className="first-run-line first-run-line-2">我是 Echo。</div>
              <div className="first-run-line first-run-line-3">以后，你把此刻放在这里。</div>
              <div className="first-run-line first-run-line-4">我用音乐，陪你把它听完。</div>
            </div>
            {audioUnavailable && <p className="first-run-audio-note">声音设备没有接上，先静静进入也没关系。</p>}
            {continueError && <p className="first-run-audio-note" role="alert">刚才没能保存这次开始。再点一次，我重新接上。</p>}
            <button data-testid="first-run-continue" className="first-run-cta" type="button" onClick={continueToOnboarding} disabled={leaving}>
              开始认识彼此
            </button>
          </div>
        )}
      </section>
    </div>
  )
}
