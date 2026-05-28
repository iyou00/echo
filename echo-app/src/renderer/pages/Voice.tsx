import { useEffect, useMemo, useRef, useState } from 'react'
import type { EchoApi, PlaybackState, Track } from '../../types/ipc'
import type { AppPageProps } from '../appState'
import { getVoiceLongAbsence, markVoiceSeen, pickVoiceIdleGreeting } from '../../data/voice-idle-greetings'
import { pageLabels } from '../labels'
import { sameTrack, trackIdentity } from '../../shared/trackIdentity'

interface VoicePageProps extends AppPageProps {
  echo: EchoApi
  playbackState: PlaybackState
  setPlaybackState: (state: PlaybackState) => void
  refreshQueue: () => Promise<Track[]>
  autoStartToken?: number
  isActive?: boolean
  voiceContinuous: boolean
  setVoiceContinuous: (value: boolean) => void
}

type VoiceStatus = 'idle' | 'generating' | 'speaking' | 'done' | 'text-only-done' | 'error'

const voiceWaveCount = 25
const voiceWaveMid = (voiceWaveCount - 1) / 2
const idleWave = Array.from({ length: voiceWaveCount }, (_, index) => {
  const distance = Math.abs(index - voiceWaveMid) / voiceWaveMid
  return Math.round(16 + (1 - distance) * 46)
})

function splitByProgress(text: string, progress: number) {
  const index = Math.max(0, Math.min(text.length, Math.floor(text.length * progress)))
  return {
    said: text.slice(0, index),
    now: text[index] ?? '',
    pending: text.slice(index + 1),
  }
}

/**
 * 把待机问候拆成"主句"+"副句"两段，让 standby 视图有视觉层次。
 * 优先按 "——" / "—" 切；其次按问号/句号切。
 * 短到没法分时返回单段。
 */
function splitGreeting(text: string): { primary: string; secondary?: string } {
  const trimmed = text.trim()
  if (!trimmed) return { primary: '' }

  const dashMatch = trimmed.match(/^(.+?)(?:——|—)\s*(.+)$/)
  if (dashMatch && dashMatch[1].trim().length >= 2 && dashMatch[2].trim().length >= 2) {
    return { primary: dashMatch[1].trim(), secondary: dashMatch[2].trim() }
  }

  const punctMatch = trimmed.match(/^(.+?[?。?！!])\s*(.+)$/)
  if (punctMatch && punctMatch[1].trim().length >= 4 && punctMatch[2].trim().length >= 3) {
    return { primary: punctMatch[1].trim(), secondary: punctMatch[2].trim() }
  }

  const commaMatch = trimmed.match(/^(.+?[,，])\s*(.+)$/)
  if (commaMatch && commaMatch[1].trim().length >= 4 && commaMatch[2].trim().length >= 4) {
    return { primary: commaMatch[1].trim().replace(/[,，]\s*$/, ''), secondary: commaMatch[2].trim() }
  }

  return { primary: trimmed }
}

function isSameTrack(left: Track | null | undefined, right: Track | null | undefined) {
  return sameTrack(left, right)
}

async function fadeVolume(
  echo: EchoApi,
  from: number,
  to: number,
  durationMs: number,
  setPlaybackState: (state: PlaybackState) => void,
  shouldCancel?: () => boolean,
) {
  const steps = 12
  for (let index = 1; index <= steps; index += 1) {
    if (shouldCancel?.()) return
    const value = Math.round(from + ((to - from) * index) / steps)
    const next = await echo.playback.setVolume(value)
    setPlaybackState(next)
    await new Promise((resolve) => window.setTimeout(resolve, durationMs / steps))
  }
}

export function VoicePage({
  echo,
  navigate,
  playbackState,
  setPlaybackState,
  refreshQueue,
  autoStartToken = 0,
  isActive = false,
  voiceContinuous,
  setVoiceContinuous,
}: VoicePageProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const sourceRef = useRef<MediaElementAudioSourceNode | null>(null)
  const rafRef = useRef<number | null>(null)
  const musicTimerRef = useRef<number | null>(null)
  const restoreVolumeRef = useRef(100)
  const musicStartedRef = useRef(false)
  const trackRef = useRef<Track | null>(null)
  const fadeRunRef = useRef(0)
  const fadeVolumeRef = useRef(false)
  const voiceBaselinePlaybackKeyRef = useRef('')
  const playbackStateRef = useRef(playbackState)
  const statusRef = useRef<VoiceStatus>('idle')
  const speakRef = useRef<(automatic?: boolean) => Promise<void>>()
  const speakingLockRef = useRef(false)
  const autoFailureCountRef = useRef(0)
  const lastAutoStartTokenRef = useRef(0)
  const prevAudioUrlRef = useRef('')
  const [status, setStatus] = useState<VoiceStatus>('idle')
  const [text, setText] = useState('让我说一段?')
  const [idleGreeting, setIdleGreeting] = useState(() => pickVoiceIdleGreeting({ playbackState }))
  const [audioUrl, setAudioUrl] = useState('')
  const [progress, setProgress] = useState(0)
  const [waveLevels, setWaveLevels] = useState(idleWave)
  const [notice, setNotice] = useState('')
  const parts = useMemo(() => splitByProgress(text, status === 'done' || status === 'text-only-done' ? 1 : progress), [text, progress, status])
  const statusLabel = status === 'generating' ? 'T H I N K I N G' : status === 'speaking' ? 'S P E A K I N G' : status === 'done' || status === 'text-only-done' ? 'D O N E' : 'S T A N D B Y'

  function clearCurrentAudioUrl(updateState = true) {
    if (prevAudioUrlRef.current.startsWith('blob:')) URL.revokeObjectURL(prevAudioUrlRef.current)
    prevAudioUrlRef.current = ''
    if (updateState) setAudioUrl('')
  }

  function setCurrentAudioUrl(url: string) {
    if (prevAudioUrlRef.current.startsWith('blob:') && prevAudioUrlRef.current !== url) {
      URL.revokeObjectURL(prevAudioUrlRef.current)
    }
    prevAudioUrlRef.current = url
    setAudioUrl(url)
  }

  useEffect(() => {
    playbackStateRef.current = playbackState
  }, [playbackState])

  useEffect(() => {
    statusRef.current = status
  }, [status])

  useEffect(() => {
    if (!isActive) return undefined
    if (statusRef.current !== 'idle') return undefined
    let alive = true
    const longAbsent = getVoiceLongAbsence()
    const fallbackGreeting = pickVoiceIdleGreeting({ playbackState: playbackStateRef.current, longAbsent })
    setIdleGreeting(fallbackGreeting)
    markVoiceSeen()

    echo.weather.get().then((weather) => {
      if (!alive || statusRef.current !== 'idle') return
      setIdleGreeting(pickVoiceIdleGreeting({ weather, playbackState: playbackStateRef.current, longAbsent }))
    }).catch(() => undefined)

    return () => {
      alive = false
    }
  }, [echo, isActive])

  useEffect(() => {
    if (fadeVolumeRef.current) return
    const current = playbackState.current

    // 连续回声：检测背景音乐播完（track 变了或变成 null）→ 触发下一段（仅回声页面）
    if (isActive && voiceContinuous && (statusRef.current === 'done' || statusRef.current === 'text-only-done') && musicStartedRef.current) {
      const baselineKey = voiceBaselinePlaybackKeyRef.current
      const stillSameTrack = (baselineKey && current && trackIdentity(current) === baselineKey) || current?.sourceContext === 'voice'
      if (!stillSameTrack) {
        speakRef.current?.(true).catch(() => undefined)
        return
      }
    }

    if (!current || current.sourceContext === 'voice') return
    const baselineKey = voiceBaselinePlaybackKeyRef.current
    const isBaselineMusic = Boolean(baselineKey && trackIdentity(current) === baselineKey)
    if (isBaselineMusic && statusRef.current !== 'idle') return
    if (statusRef.current === 'idle' && !voiceContinuous) return

    voiceBaselinePlaybackKeyRef.current = ''
    if (voiceContinuous) setVoiceContinuous(false)
    fadeRunRef.current += 1
    if (musicTimerRef.current) {
      window.clearTimeout(musicTimerRef.current)
      musicTimerRef.current = null
    }
    stopTtsWave(true)
    audioRef.current?.pause()
    musicStartedRef.current = false
    trackRef.current = null
    clearCurrentAudioUrl(false)
    setProgress(0)
    setNotice('')
    setStatus('idle')
    echo.playback.setVolume(restoreVolumeRef.current).then(setPlaybackState).catch((error) => console.warn('[Voice] restore volume failed (playback change)', error))
  }, [echo, isActive, playbackState, setPlaybackState, setVoiceContinuous, voiceContinuous])

  useEffect(() => () => {
    fadeRunRef.current += 1
    if (musicTimerRef.current) window.clearTimeout(musicTimerRef.current)
    if (rafRef.current) window.cancelAnimationFrame(rafRef.current)
    clearCurrentAudioUrl()
    audioRef.current?.pause()
    audioContextRef.current?.close().catch(() => undefined)
    echo.playback.setVolume(restoreVolumeRef.current).then(setPlaybackState).catch((error) => console.warn('[Voice] restore volume failed (unmount)', error))
  }, [echo, setPlaybackState])

  function stopTtsWave(reset = false) {
    if (rafRef.current) {
      window.cancelAnimationFrame(rafRef.current)
      rafRef.current = null
    }
    if (reset) setWaveLevels(idleWave)
  }

  async function startTtsWave() {
    const audio = audioRef.current
    if (!audio) return
    try {
      const context = audioContextRef.current ?? new AudioContext()
      audioContextRef.current = context
      if (context.state === 'suspended') await context.resume()
      if (!sourceRef.current) {
        const source = context.createMediaElementSource(audio)
        const gainNode = context.createGain()
        gainNode.gain.value = 1.5
        const analyser = context.createAnalyser()
        analyser.fftSize = 64
        analyser.smoothingTimeConstant = 0.68
        source.connect(gainNode)
        gainNode.connect(analyser)
        analyser.connect(context.destination)
        sourceRef.current = source
        analyserRef.current = analyser
      }
      const analyser = analyserRef.current
      if (!analyser) return
      const data = new Uint8Array(analyser.frequencyBinCount)
      const tick = () => {
        analyser.getByteFrequencyData(data)
        setWaveLevels(Array.from({ length: voiceWaveCount }, (_, index) => {
          const value = data[index % data.length] ?? 0
          const distance = Math.abs(index - voiceWaveMid) / voiceWaveMid
          const shape = 1 - distance * 0.62
          return Math.max(14, Math.round((18 + (value / 255) * 68) * shape))
        }))
        rafRef.current = window.requestAnimationFrame(tick)
      }
      stopTtsWave()
      tick()
    } catch {
      setWaveLevels(idleWave.map((level, index) => level + (index % 3) * 8))
    }
  }

  async function startBackgroundMusic(nextTrack: Track | null) {
    if (!nextTrack || musicStartedRef.current) return
    musicStartedRef.current = true
    if (isSameTrack(playbackState.current, nextTrack)) {
      const next = await echo.playback.setVolume(30)
      setPlaybackState(next)
    } else {
      const next = await echo.playback.play(nextTrack, { initialVolume: 30 })
      setPlaybackState(next)
      await refreshQueue()
    }
  }

  function scheduleBackgroundMusic(nextTrack: Track | null) {
    if (musicTimerRef.current) window.clearTimeout(musicTimerRef.current)
    musicTimerRef.current = window.setTimeout(() => {
      startBackgroundMusic(nextTrack).catch(() => undefined)
    }, 800)
  }

  async function finishSpeaking() {
    const runId = fadeRunRef.current
    stopTtsWave()
    setProgress(1)
    setStatus('done')
    const currentVolume = await echo.playback.getVolume().catch(() => 30)
    if (fadeRunRef.current !== runId) return
    fadeVolumeRef.current = true
    try {
      await fadeVolume(echo, currentVolume, restoreVolumeRef.current, 1500, setPlaybackState, () => fadeRunRef.current !== runId)
    } finally {
      fadeVolumeRef.current = false
    }
  }

  async function speak(automatic = false, continuation = false) {
    if (speakingLockRef.current) return
    if (statusRef.current === 'generating' || statusRef.current === 'speaking') return
    speakingLockRef.current = true
    try {
      fadeRunRef.current += 1
      if (musicTimerRef.current) window.clearTimeout(musicTimerRef.current)
      stopTtsWave(true)
      audioRef.current?.pause()
      musicStartedRef.current = false
      voiceBaselinePlaybackKeyRef.current = trackIdentity(playbackStateRef.current.current)
      setStatus('generating')
      setNotice('')
      setProgress(0)
      clearCurrentAudioUrl()
      restoreVolumeRef.current = await echo.playback.getVolume()

      const segment = await echo.listening.generateSegment({ continuation: automatic || continuation })
      autoFailureCountRef.current = 0
      setText(segment.text)
      trackRef.current = segment.track
      if (!segment.audioUrl) {
        setNotice(segment.error ?? '我现在说不出话来,但你能看到我说什么。')
        if (segment.track) {
          const next = await echo.playback.play(segment.track)
          setPlaybackState(next)
          await refreshQueue()
        }
        setProgress(1)
        setStatus('text-only-done')
        return
      }
      setCurrentAudioUrl(segment.audioUrl)
      setStatus('speaking')
      window.setTimeout(() => audioRef.current?.play().catch(() => {
        setNotice('语音播放失败,文字已经保留。')
        setProgress(1)
        setStatus('text-only-done')
      }), 80)
    } catch (error) {
      if (automatic) {
        autoFailureCountRef.current += 1
        if (autoFailureCountRef.current >= 2) {
          setVoiceContinuous(false)
          setNotice('我先停一下，刚才没接上。')
          setStatus('error')
          return
        }
      }
      setNotice(error instanceof Error ? error.message : `${pageLabels.voice}生成失败`)
      setStatus('error')
    } finally {
      speakingLockRef.current = false
    }
  }
  speakRef.current = speak

  useEffect(() => {
    if (autoStartToken <= 0) return
    if (lastAutoStartTokenRef.current === autoStartToken) return
    lastAutoStartTokenRef.current = autoStartToken
    // status 检查放在 lastAutoStartTokenRef 更新之后：
    // 即使当前 speak() 正在执行（generating/speaking），也要先把 token 标记为已处理。
    // 否则等 status 变回 done 时 effect 会因 status 依赖重入，误判为"未处理"而重复触发 speak()。
    if (statusRef.current === 'generating' || statusRef.current === 'speaking') return
    speakRef.current?.(true).catch(() => undefined)
  }, [autoStartToken, status])

  // 连续回声兜底：仅在背景音乐从未启动时（比如没有推荐到歌），2 秒后自动触发下一段
  // 音乐在播时由 playbackState effect 检测音乐播完再触发
  useEffect(() => {
    if (!voiceContinuous) return
    if (!isActive) return
    if (status !== 'done' && status !== 'text-only-done') return
    const timer = window.setTimeout(() => {
      if (statusRef.current !== 'done' && statusRef.current !== 'text-only-done') return
      if (musicStartedRef.current) return
      speakRef.current?.(true).catch(() => undefined)
    }, 2000)
    return () => window.clearTimeout(timer)
  }, [isActive, status, voiceContinuous])

  function backToChat() {
    setVoiceContinuous(false)
    voiceBaselinePlaybackKeyRef.current = ''
    fadeRunRef.current += 1
    if (musicTimerRef.current) window.clearTimeout(musicTimerRef.current)
    stopTtsWave(true)
    audioRef.current?.pause()
    echo.playback.setVolume(restoreVolumeRef.current).then(setPlaybackState).catch((error) => console.warn('[Voice] restore volume failed (backToChat)', error))
    navigate('chat')
  }

  return (
    <div className="phone-surface voice-page">
      <audio
        ref={audioRef}
        src={audioUrl}
        onLoadedMetadata={(event) => {
          if (!event.currentTarget.duration) setProgress(0)
        }}
        onPlay={() => {
          startTtsWave().catch(() => undefined)
          if (playbackState.current) {
            const runId = fadeRunRef.current
            fadeVolume(echo, restoreVolumeRef.current, 30, 800, setPlaybackState, () => fadeRunRef.current !== runId).catch(() => undefined)
          }
          scheduleBackgroundMusic(trackRef.current)
        }}
        onTimeUpdate={(event) => {
          const duration = event.currentTarget.duration || Math.max(4, text.length * 0.12)
          setProgress(Math.min(1, event.currentTarget.currentTime / duration))
        }}
        onEnded={() => finishSpeaking().catch(() => setStatus('done'))}
      />
      <div className={status === 'idle' ? 'voice-sheet standby' : 'voice-sheet'}>
        <div className="voice-status-pill">E C H O · {statusLabel}</div>
        {status === 'idle' ? (
          (() => {
            const greet = splitGreeting(idleGreeting)
            return (
              <div className="voice-standby">
                <div className="voice-greet">
                  <div className="voice-greet-primary">{greet.primary}</div>
                  {greet.secondary && <div className="voice-greet-secondary">{greet.secondary}</div>}
                </div>
                <button className="voice-orb-button" type="button" onClick={() => { void speak() }} aria-label="听 Echo 说几句">
                  <span className="voice-orb" aria-hidden="true">
                    <span className="voice-orb-ring ring-one" />
                    <span className="voice-orb-ring ring-two" />
                    <span className="voice-orb-core" />
                  </span>
                  <span className="voice-primary">听 Echo 说几句</span>
                </button>
              </div>
            )
          })()
        ) : status === 'generating' ? (
          <div className="voice-generating">
            <span />
            <span />
            <span />
          </div>
        ) : (
          <>
            <div className="voice-text">
              <span className="said">{parts.said}</span>
              <span className="now">{parts.now}</span>
              <span className="pending">{parts.pending}</span>
            </div>
            <div className="big-wave">
              <div className={status === 'speaking' ? 'tts-wave active' : status === 'done' || status === 'text-only-done' ? 'tts-wave music' : 'tts-wave'}>
                {waveLevels.map((level, index) => (
                  <span
                    style={{
                      height: `${level}px`,
                      animationDelay: `${Math.abs(index - voiceWaveMid) * 0.055}s`,
                      animationDuration: `${0.98 + (Math.abs(index - voiceWaveMid) % 5) * 0.06}s`,
                    }}
                    key={index}
                  />
                ))}
              </div>
            </div>
            {notice && <div className="voice-notice">{notice}</div>}
            <div className="voice-foot">
              <div className="voice-actions">
                <button className={voiceContinuous ? 'exit-btn voice-loop active' : 'exit-btn voice-loop'} type="button" onClick={() => setVoiceContinuous(!voiceContinuous)}>
                  连 续 回 声
                </button>
                <button className="exit-btn" type="button" onClick={() => { void speak(false, true) }} disabled={status === 'speaking'}>再 来 一 次</button>
                <button className="exit-btn" type="button" onClick={backToChat}>回 到 首 页</button>
              </div>
            </div>
          </>
        )}
      </div>
    </div>
  )
}
