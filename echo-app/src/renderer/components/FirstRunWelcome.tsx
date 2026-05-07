import { useEffect, useRef, useState } from 'react'
import { Volume2, VolumeX } from 'lucide-react'

interface FirstRunWelcomeProps {
  onContinue: () => Promise<void> | void
}

const TARGET_VOLUME = 0.22
const FADE_IN_MS = 3600
const FADE_OUT_MS = 1000

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
  const [muted, setMuted] = useState(false)
  const [leaving, setLeaving] = useState(false)

  useEffect(() => {
    const audio = audioRef.current
    if (!audio) return

    audio.volume = 0
    audio.play().then(() => {
      cancelFadeRef.current = fadeAudio(audio, 0, TARGET_VOLUME, FADE_IN_MS)
    }).catch(() => undefined)

    return () => {
      cancelFadeRef.current?.()
      audio.pause()
    }
  }, [])

  function toggleMute() {
    const audio = audioRef.current
    setMuted((nextMuted) => {
      const value = !nextMuted
      cancelFadeRef.current?.()
      if (audio) {
        audio.muted = value
        audio.volume = value ? 0 : TARGET_VOLUME
      }
      return value
    })
  }

  function continueToOnboarding() {
    if (leaving) return
    setLeaving(true)
    cancelFadeRef.current?.()

    const audio = audioRef.current
    if (!audio || muted) {
      window.setTimeout(() => { void onContinue() }, FADE_OUT_MS)
      return
    }

    const currentVolume = audio.volume
    cancelFadeRef.current = fadeAudio(audio, currentVolume, 0, FADE_OUT_MS, () => {
      audio.pause()
      audio.currentTime = 0
      void onContinue()
    })
  }

  return (
    <div className={leaving ? 'first-run-welcome-layer first-run-leaving' : 'first-run-welcome-layer'}>
      <audio ref={audioRef} src="./welcome/first-run-welcome.mp3" preload="auto" />
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
