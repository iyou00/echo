import { useCallback, useEffect, useRef, useState } from 'react'
import { Volume2, VolumeX } from 'lucide-react'
import { welcomeExitDelay } from './firstRunWelcomePolicy'
import { MeetingCanvas } from './MeetingCanvas'

interface FirstRunWelcomeProps {
  onContinue: () => Promise<void> | void
}

const TARGET_VOLUME = 0.22
const FADE_IN_MS = 3600
const DEVICE_CHANGE_RETRY_MS = 600
const WELCOME_AUDIO_SRC = './welcome/first-run-welcome.mp3'

const MEET_DURATION_MS = 5900
const SIGNATURE_AT_MS = 6450
const AUTO_CONTINUE_AT_MS = 8000

const PHRASES_NORMAL = [
  { at: 250, text: '先听一会儿。' },
  { at: 1700, text: '有些时刻，不必急着说清楚。' },
  { at: 3350, text: '你留下心情。' },
  { at: 4950, text: '我替你接住下一首。' },
]

const PHRASES_REDUCED = [
  { at: 80, text: '先听一会儿。' },
  { at: 650, text: '有些时刻，不必急着说清楚。' },
  { at: 1250, text: '你留下心情。' },
]

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
  const [shownPhrases, setShownPhrases] = useState(0)
  const [showSignature, setShowSignature] = useState(false)
  const [reducedMotion] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  const phraseTimersRef = useRef<number[]>([])

  const clearPhraseTimers = useCallback(() => {
    for (const timer of phraseTimersRef.current) window.clearTimeout(timer)
    phraseTimersRef.current = []
  }, [])

  const audioEndedRef = useRef<(() => void) | null>(null)

  const detachAudioEnded = useCallback(() => {
    const audio = audioRef.current
    const handler = audioEndedRef.current
    if (audio && handler) audio.removeEventListener('ended', handler)
    audioEndedRef.current = null
  }, [])

  const attachAudioEnded = useCallback(() => {
    const audio = audioRef.current
    if (!audio) return
    detachAudioEnded()
    const onEnded = () => {
      if (mountedRef.current && !leavingRef.current) continueToOnboardingRef.current()
    }
    audioEndedRef.current = onEnded
    audio.addEventListener('ended', onEnded)
  }, [detachAudioEnded])

  const continueToOnboardingRef = useRef<() => void>(() => {})
  useEffect(() => {
    continueToOnboardingRef.current = continueToOnboarding
  })

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
      if (!audio.getAttribute('src')) audio.src = WELCOME_AUDIO_SRC
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
    const audioOutputInterrupted = () => {
      const audio = audioRef.current
      return !audio || audio.paused || audio.ended
    }
    const handleOutputMayHaveChanged = () => {
      if (startedRef.current && audioOutputInterrupted()) scheduleOutputRetry()
    }
    const handleVisibilityChange = () => {
      if (startedRef.current && document.visibilityState === 'visible' && audioOutputInterrupted()) scheduleOutputRetry()
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
      clearPhraseTimers()
      detachAudioEnded()
      stopWelcomeAudio({ releaseSource: true })
    }
  }, [clearPhraseTimers, detachAudioEnded, scheduleOutputRetry, stopWelcomeAudio])

  function scheduleSequence(autoAdvanceMs: number | null) {
    clearPhraseTimers()
    const plan = reducedMotion ? PHRASES_REDUCED : PHRASES_NORMAL
    const timers: number[] = []
    plan.forEach((phrase, index) => {
      timers.push(window.setTimeout(() => {
        if (mountedRef.current && !leavingRef.current) setShownPhrases(index + 1)
      }, phrase.at))
    })
    if (!reducedMotion) {
      timers.push(window.setTimeout(() => {
        if (mountedRef.current && !leavingRef.current) setShowSignature(true)
      }, SIGNATURE_AT_MS))
    }
    if (autoAdvanceMs != null) {
      timers.push(window.setTimeout(() => {
        if (mountedRef.current && !leavingRef.current) continueToOnboarding()
      }, autoAdvanceMs))
    }
    phraseTimersRef.current = timers
  }

  async function startExperience(withSound: boolean) {
    userMutedRef.current = !withSound
    startedRef.current = true
    setMuted(!withSound)
    setStarted(true)
    setAudioUnavailable(false)
    if (!withSound) {
      scheduleSequence(reducedMotion ? 2350 : AUTO_CONTINUE_AT_MS)
      return
    }
    const played = await startWelcomeAudio({ restart: true, reloadSource: true })
    if (!played && mountedRef.current) {
      setAudioUnavailable(true)
      scheduleSequence(reducedMotion ? 2350 : AUTO_CONTINUE_AT_MS)
      return
    }
    scheduleSequence(null)
    if (played) attachAudioEnded()
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
    void startWelcomeAudio({ restart: audio.ended }).then((played) => {
      if (played) attachAudioEnded()
    })
  }

  function continueToOnboarding() {
    if (leavingRef.current) return
    leavingRef.current = true
    setLeaving(true)
    setContinueError(false)
    clearPhraseTimers()
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
      {started && <MeetingCanvas durationMs={MEET_DURATION_MS} className="first-run-welcome-field" />}
      <button data-testid="first-run-skip" className="first-run-skip" type="button" onClick={continueToOnboarding} disabled={leaving}>跳过前奏</button>
      {started && (
        <button className="first-run-mute" type="button" onClick={toggleMute} disabled={leaving} aria-label={muted ? '打开声音' : '静音'}>
          {muted ? <VolumeX size={15} /> : <Volume2 size={15} />}
          <span>{muted ? '打开声音' : '静音'}</span>
        </button>
      )}

      <section className="first-run-welcome-stage" aria-label="Echo 首次欢迎">
        {!started ? (
          <div className="first-run-gate">
            <div className="first-run-kicker">ECHO · 第一次见面</div>
            <h1>先听一会儿。</h1>
            <p>这段前奏只在第一次见面时播放。你的生活和 Echo 的回应，会在下面汇成一条线。</p>
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
            <div className="first-run-legend" aria-hidden="true"><span>你的生活</span><span>Echo</span></div>
            <div className="first-run-lines">
              {(reducedMotion ? PHRASES_REDUCED : PHRASES_NORMAL).map((phrase, index) => (
                <div className={index < shownPhrases ? 'first-run-line in' : 'first-run-line'} key={phrase.text}>
                  {phrase.text}
                </div>
              ))}
              <div className={showSignature ? 'first-run-signature in' : 'first-run-signature'} aria-hidden="true">Echo</div>
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
