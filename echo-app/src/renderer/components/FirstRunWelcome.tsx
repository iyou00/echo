import { useCallback, useEffect, useRef, useState } from 'react'
import { Volume2, VolumeX } from 'lucide-react'

interface FirstRunWelcomeProps {
  onContinue: () => Promise<void> | void
}

const TARGET_VOLUME = 0.22
const FADE_IN_MS = 3600
const FADE_OUT_MS = 1000
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
  const playAttemptRef = useRef(0)
  const userMutedRef = useRef(false)
  const leavingRef = useRef(false)
  const mountedRef = useRef(true)
  const [muted, setMuted] = useState(false)
  const [leaving, setLeaving] = useState(false)

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
    void startWelcomeAudio()

    const mediaDevices = navigator.mediaDevices
    const handleOutputMayHaveChanged = () => {
      scheduleOutputRetry()
    }
    const handleVisibilityChange = () => {
      if (document.visibilityState === 'visible') scheduleOutputRetry()
    }
    mediaDevices?.addEventListener?.('devicechange', handleOutputMayHaveChanged)
    window.addEventListener('focus', handleOutputMayHaveChanged)
    document.addEventListener('visibilitychange', handleVisibilityChange)

    return () => {
      mountedRef.current = false
      mediaDevices?.removeEventListener?.('devicechange', handleOutputMayHaveChanged)
      window.removeEventListener('focus', handleOutputMayHaveChanged)
      document.removeEventListener('visibilitychange', handleVisibilityChange)
      stopWelcomeAudio({ releaseSource: true })
    }
  }, [scheduleOutputRetry, startWelcomeAudio, stopWelcomeAudio])

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
    if (leaving) return
    leavingRef.current = true
    setLeaving(true)
    stopWelcomeAudio({ releaseSource: true })
    window.setTimeout(() => { void onContinue() }, FADE_OUT_MS)
  }

  return (
    <div
      className={leaving ? 'first-run-welcome-layer first-run-leaving' : 'first-run-welcome-layer'}
      onPointerDownCapture={() => {
        const audio = audioRef.current
        if (!userMutedRef.current && audio?.paused && !leaving) {
          void startWelcomeAudio({ restart: audio.ended })
        }
      }}
    >
      <audio ref={audioRef} src={WELCOME_AUDIO_SRC} preload="auto" />
      <button className="first-run-mute" type="button" onClick={toggleMute} aria-label={muted ? '打开声音' : '静音'}>
        {muted ? <VolumeX size={15} /> : <Volume2 size={15} />}
        <span>{muted ? '打开声音' : '静音'}</span>
      </button>

      <section className="first-run-welcome-stage" aria-label="Echo 首次欢迎">
        <div className="first-run-orb" aria-hidden="true" />
        <div className="first-run-lines">
          <div className="first-run-line first-run-line-1">你 好。</div>
          <div className="first-run-line first-run-line-2">我 是 Echo。</div>
          <div className="first-run-line first-run-line-3">
            我 还 不 认 识 你 ——<br />你 给 我 看 看 你 听 什 么？
          </div>
        </div>
        <button className="first-run-cta" type="button" onClick={continueToOnboarding} disabled={leaving}>
          没&nbsp;&nbsp;问&nbsp;&nbsp;题
        </button>
      </section>
    </div>
  )
}
