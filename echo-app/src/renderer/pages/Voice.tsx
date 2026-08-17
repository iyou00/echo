import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { EchoApi, PlaybackState, Track, UiBoundarySnapshot } from '../../types/ipc'
import type { AppPageProps } from '../appState'
import { getVoiceLongAbsence, markVoiceSeen, pickVoiceIdleGreeting } from '../../data/voice-idle-greetings'
import { sameTrack, trackIdentity } from '../../shared/trackIdentity'
import { friendlyOperationError } from '../../shared/runtimeRecovery'
import { nextVoiceFailureAction, shouldAcceptVoiceContinuousTrigger, shouldTriggerNextVoiceSegment } from './voiceContinuous'
import { BoundaryState } from '../components/BoundaryState'

interface VoicePageProps extends AppPageProps {
  echo: EchoApi
  playbackState: PlaybackState
  setPlaybackState: (state: PlaybackState) => void
  refreshQueue: () => Promise<Track[]>
  autoStartToken?: number
  isActive?: boolean
  voiceContinuous: boolean
  setVoiceContinuous: (value: boolean) => void
  /** 联动：点击音乐书签 → 打开一起听视图（连续回声不停） */
  onOpenListening?: () => void
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

function voiceFriendlyError(error: unknown): string {
  const message = error instanceof Error ? error.message : String(error)
  if (/取消|cancell?ed|aborted/i.test(message)) return '好，我先停一下。'
  if (/API.?key|鉴权|401|403|配置/i.test(message)) return '我这会儿没连上模型，去设置里看一眼。'
  if (/网易云|登录|cookie/i.test(message)) return '音乐这边掉线了，重新登录网易云后再试。'
  if (/超时|网络|fetch|ECONN|ENOTFOUND|服务端/i.test(message)) return '刚才连接有点慢，我先停一下。'
  return '我刚才没说出来，稍后再试一次。'
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
  playbackState,
  setPlaybackState,
  refreshQueue,
  autoStartToken = 0,
  isActive = false,
  voiceContinuous,
  setVoiceContinuous,
  onOpenListening,
}: VoicePageProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const sourceRef = useRef<MediaElementAudioSourceNode | null>(null)
  const rafRef = useRef<number | null>(null)
  const musicTimerRef = useRef<number | null>(null)
  const failureRetryTimerRef = useRef<number | null>(null)
  const restoreVolumeRef = useRef(100)
  const volumeRestoreArmedRef = useRef(false)
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
  const sessionIdRef = useRef(0)
  const currentAutomaticRef = useRef(false)
  const backgroundPlaybackFailedRef = useRef(false)
  const recoveringTtsRef = useRef(false)
  const isActiveRef = useRef(isActive)
  const voiceContinuousRef = useRef(voiceContinuous)
  const lastContinuousTriggerAtRef = useRef(0)
  const lastAutoStartTokenRef = useRef(0)
  const prevAudioUrlRef = useRef('')
  const [status, setStatus] = useState<VoiceStatus>('idle')
  const [text, setText] = useState('让我说一段?')
  const [idleGreeting, setIdleGreeting] = useState(() => pickVoiceIdleGreeting({ playbackState }))
  const [audioUrl, setAudioUrl] = useState('')
  const [progress, setProgress] = useState(0)
  const [waveLevels, setWaveLevels] = useState(idleWave)
  const [notice, setNotice] = useState('')
  const [voiceBoundary, setVoiceBoundary] = useState<UiBoundarySnapshot | null>(null)
  // —— 信笺：连续模式下写完的段落与音乐插曲累积在纸上；散句写完墨散淡出 ——
  const [paragraphs, setParagraphs] = useState<Array<{ id: number; kind: 'text'; text: string } | { id: number; kind: 'music'; label: string }>>([])
  const [trackLabel, setTrackLabel] = useState('')
  const [fading, setFading] = useState(false)
  const [entering, setEntering] = useState(false)
  const paraIdRef = useRef(0)
  const letterRef = useRef<HTMLDivElement | null>(null)
  const parts = useMemo(() => splitByProgress(text, status === 'done' || status === 'text-only-done' ? 1 : progress), [text, progress, status])
  const statusLabel = status === 'generating'
    ? '研 墨 中'
    : status === 'speaking'
      ? '正 在 书 写'
      : status === 'done' || status === 'text-only-done'
        ? voiceContinuous ? '笔 未 停' : '墨 迹 已 干'
        : status === 'error'
          ? '墨 断 了'
          : '落 笔 前'

  function settleTextParagraph(): void {
    const finished = text.trim()
    if (!finished) return
    paraIdRef.current += 1
    setParagraphs((current) => [...current, { id: paraIdRef.current, kind: 'text', text: finished }])
  }

  function settleMusicInterlude(label: string): void {
    if (!label) return
    paraIdRef.current += 1
    setParagraphs((current) => [...current, { id: paraIdRef.current, kind: 'music', label }])
  }

  // 墨线：waveLevels（TTS 频谱）→ 一条两端细中间饱满的墨带，粗细随音量呼吸
  const inkPathD = useMemo(() => {
    const width = 100, height = 40, mid = height / 2
    const points = waveLevels.map((level, index) => {
      const x = (index / (voiceWaveCount - 1)) * width
      const envelope = Math.sin((index / (voiceWaveCount - 1)) * Math.PI) ** 1.5
      const amplitude = Math.max(1.4, ((level - 12) / 70) * 15 * envelope + 1.2 * envelope)
      return { x, top: mid - amplitude, bottom: mid + amplitude }
    })
    const head = points.map((point, index) => `${index === 0 ? 'M' : 'L'} ${point.x.toFixed(2)} ${point.top.toFixed(2)}`).join(' ')
    const tail = [...points].reverse().map((point) => `L ${point.x.toFixed(2)} ${point.bottom.toFixed(2)}`).join(' ')
    return `${head} ${tail} Z`
  }, [waveLevels])

  // 信纸跟随：新段落落笔时滚到最新
  useEffect(() => {
    const letter = letterRef.current
    if (letter) letter.scrollTop = letter.scrollHeight
  }, [paragraphs, text])

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

  const restorePlaybackVolume = useCallback(async () => {
    if (!volumeRestoreArmedRef.current) return
    volumeRestoreArmedRef.current = false
    try {
      const next = await echo.playback.setVolume(restoreVolumeRef.current)
      setPlaybackState(next)
    } catch (error) {
      volumeRestoreArmedRef.current = true
      throw error
    }
  }, [echo, setPlaybackState])

  useEffect(() => {
    playbackStateRef.current = playbackState
  }, [playbackState])

  useEffect(() => {
    isActiveRef.current = isActive
  }, [isActive])

  useEffect(() => {
    voiceContinuousRef.current = voiceContinuous
  }, [voiceContinuous])

  useEffect(() => {
    statusRef.current = status
  }, [status])

  const endCurrentListeningSession = useCallback(async () => {
    const sessionId = sessionIdRef.current
    sessionIdRef.current = 0
    try {
      await echo.listening.endSession(sessionId > 0 ? sessionId : undefined)
    } catch (error) {
      if (sessionId > 0 && sessionIdRef.current === 0) sessionIdRef.current = sessionId
      throw error
    }
  }, [echo])

  function markVoiceRunSucceeded(): void {
    autoFailureCountRef.current = 0
    backgroundPlaybackFailedRef.current = false
    if (failureRetryTimerRef.current) {
      window.clearTimeout(failureRetryTimerRef.current)
      failureRetryTimerRef.current = null
    }
  }

  function failVoiceRun(error: unknown): void {
    musicStartedRef.current = false
    backgroundPlaybackFailedRef.current = false
    const decision = nextVoiceFailureAction({
      automatic: currentAutomaticRef.current,
      continuous: voiceContinuousRef.current,
      previousFailures: autoFailureCountRef.current,
    })
    autoFailureCountRef.current = decision.failureCount
    if (decision.action === 'retry') {
      setNotice('刚才没接上，我再试一次。')
      setProgress(1)
      setStatus('done')
      if (failureRetryTimerRef.current) window.clearTimeout(failureRetryTimerRef.current)
      failureRetryTimerRef.current = window.setTimeout(() => {
        failureRetryTimerRef.current = null
        if (!isActiveRef.current || !voiceContinuousRef.current || statusRef.current !== 'done') return
        triggerContinuousSegment()
      }, 2000)
      return
    }
    if (decision.action === 'stop') {
      if (failureRetryTimerRef.current) window.clearTimeout(failureRetryTimerRef.current)
      failureRetryTimerRef.current = null
      setVoiceContinuous(false)
      voiceContinuousRef.current = false
      void endCurrentListeningSession().catch(() => undefined)
      setNotice('我先停一下，连续两次都没接上。')
      setStatus('error')
      return
    }
    setNotice(voiceFriendlyError(error))
    setStatus('error')
  }

  function triggerContinuousSegment(): void {
    const now = Date.now()
    if (!shouldAcceptVoiceContinuousTrigger(lastContinuousTriggerAtRef.current, now)) return
    lastContinuousTriggerAtRef.current = now
    speakRef.current?.(true).catch(() => undefined)
  }

  useEffect(() => {
    if (isActive) return
    if (failureRetryTimerRef.current) {
      window.clearTimeout(failureRetryTimerRef.current)
      failureRetryTimerRef.current = null
    }
    // 经导航离开（无显式退出按钮）：停 TTS 与墨线、恢复闪避音量、纸面回到落笔前。
    if (statusRef.current !== 'idle') {
      fadeRunRef.current += 1
      if (musicTimerRef.current) {
        window.clearTimeout(musicTimerRef.current)
        musicTimerRef.current = null
      }
      stopTtsWave(true)
      audioRef.current?.pause()
      clearCurrentAudioUrl(false)
      setProgress(0)
      setNotice('')
      setFading(false)
      setText('')
      setTrackLabel('')
      setStatus('idle')
      restorePlaybackVolume().catch((error) => console.warn('[Voice] restore volume failed (leave page)', error))
    }
    if (sessionIdRef.current > 0) void endCurrentListeningSession().catch(() => undefined)
  }, [endCurrentListeningSession, isActive, restorePlaybackVolume])

  useEffect(() => {
    if (!isActive) return
    setEntering(true)
    const timer = window.setTimeout(() => setEntering(false), 900)
    return () => window.clearTimeout(timer)
  }, [isActive])

  // 携带音乐进入：正在播的歌直接成为背景书签（点击可去一起听）
  useEffect(() => {
    if (!isActive) return
    const current = playbackState.current
    if (current && !trackLabel && statusRef.current === 'idle') {
      setTrackLabel(`${current.title} · ${current.artist}`)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isActive, playbackState.current])

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
      if (shouldTriggerNextVoiceSegment({
        isActive,
        voiceContinuous,
        status: statusRef.current,
        musicStarted: musicStartedRef.current,
        baselinePlaybackKey: voiceBaselinePlaybackKeyRef.current,
        current,
      })) {
        triggerContinuousSegment()
        return
      }
    }

    if (!current || current.sourceContext === 'voice') return
    const baselineKey = voiceBaselinePlaybackKeyRef.current
    const isBaselineMusic = Boolean(baselineKey && trackIdentity(current) === baselineKey)
    if (isBaselineMusic && statusRef.current !== 'idle') return
    if (statusRef.current === 'idle' && !voiceContinuous) return

    voiceBaselinePlaybackKeyRef.current = ''
    if (voiceContinuous) {
      setVoiceContinuous(false)
      voiceContinuousRef.current = false
      void endCurrentListeningSession().catch(() => undefined)
    }
    fadeRunRef.current += 1
    if (musicTimerRef.current) {
      window.clearTimeout(musicTimerRef.current)
      musicTimerRef.current = null
    }
    if (failureRetryTimerRef.current) {
      window.clearTimeout(failureRetryTimerRef.current)
      failureRetryTimerRef.current = null
    }
    stopTtsWave(true)
    audioRef.current?.pause()
    musicStartedRef.current = false
    trackRef.current = null
    clearCurrentAudioUrl(false)
    setProgress(0)
    setNotice('')
    setStatus('idle')
    restorePlaybackVolume().catch((error) => console.warn('[Voice] restore volume failed (playback change)', error))
  }, [echo, endCurrentListeningSession, isActive, playbackState, restorePlaybackVolume, setVoiceContinuous, voiceContinuous])

  useEffect(() => () => {
    fadeRunRef.current += 1
    if (musicTimerRef.current) window.clearTimeout(musicTimerRef.current)
    if (failureRetryTimerRef.current) window.clearTimeout(failureRetryTimerRef.current)
    if (rafRef.current) window.cancelAnimationFrame(rafRef.current)
    clearCurrentAudioUrl()
    audioRef.current?.pause()
    audioContextRef.current?.close().catch(() => undefined)
    restorePlaybackVolume().catch((error) => console.warn('[Voice] restore volume failed (unmount)', error))
    void endCurrentListeningSession().catch(() => undefined)
  }, [echo, endCurrentListeningSession, restorePlaybackVolume])

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
    if (isSameTrack(playbackState.current, nextTrack)) {
      const next = await echo.playback.setVolume(30)
      setPlaybackState(next)
      musicStartedRef.current = true
    } else {
      const next = await echo.playback.play(nextTrack, { initialVolume: 30 })
      setPlaybackState(next)
      musicStartedRef.current = true
      await refreshQueue()
    }
    markVoiceRunSucceeded()
  }

  function scheduleBackgroundMusic(nextTrack: Track | null) {
    if (musicTimerRef.current) window.clearTimeout(musicTimerRef.current)
    musicTimerRef.current = window.setTimeout(() => {
      startBackgroundMusic(nextTrack).catch(() => {
        backgroundPlaybackFailedRef.current = true
        setNotice('歌曲刚才没接上，等这句话说完我再试一次。')
      })
    }, 800)
  }

  async function recoverFromTtsPlaybackFailure(): Promise<void> {
    if (recoveringTtsRef.current) return
    recoveringTtsRef.current = true
    try {
      if (musicTimerRef.current) {
        window.clearTimeout(musicTimerRef.current)
        musicTimerRef.current = null
      }
      clearCurrentAudioUrl()
      setProgress(1)
      const nextTrack = trackRef.current
      if (!nextTrack) {
        markVoiceRunSucceeded()
        setNotice('语音播放失败，文字已经保留。')
        setStatus('text-only-done')
        return
      }
      if (musicStartedRef.current) {
        markVoiceRunSucceeded()
        setNotice('语音播放失败，歌曲还在继续。')
        setStatus('text-only-done')
        return
      }
      const next = await echo.playback.play(nextTrack)
      setPlaybackState(next)
      musicStartedRef.current = true
      volumeRestoreArmedRef.current = false
      markVoiceRunSucceeded()
      await refreshQueue()
      setNotice('语音播放失败，歌曲已经接上。')
      setStatus('text-only-done')
    } catch (error) {
      failVoiceRun(error)
    } finally {
      recoveringTtsRef.current = false
    }
  }

  async function finishSpeaking() {
    const runId = fadeRunRef.current
    stopTtsWave()
    setProgress(1)
    if (backgroundPlaybackFailedRef.current) {
      await restorePlaybackVolume().catch(() => undefined)
      failVoiceRun(new Error('背景音乐播放失败'))
      return
    }
    setStatus('done')
    const currentVolume = await echo.playback.getVolume().catch(() => 30)
      if (fadeRunRef.current !== runId) return
    fadeVolumeRef.current = true
    try {
      await fadeVolume(echo, currentVolume, restoreVolumeRef.current, 1500, setPlaybackState, () => fadeRunRef.current !== runId)
      if (fadeRunRef.current === runId) volumeRestoreArmedRef.current = false
    } finally {
      fadeVolumeRef.current = false
    }
  }

  async function speak(automatic = false, continuation = false) {
    if (speakingLockRef.current) return
    if (statusRef.current === 'generating' || statusRef.current === 'speaking') return
    speakingLockRef.current = true
    try {
      currentAutomaticRef.current = automatic
      backgroundPlaybackFailedRef.current = false
      recoveringTtsRef.current = false
      if (failureRetryTimerRef.current) {
        window.clearTimeout(failureRetryTimerRef.current)
        failureRetryTimerRef.current = null
      }
      if (!automatic) autoFailureCountRef.current = 0
      fadeRunRef.current += 1
      if (musicTimerRef.current) window.clearTimeout(musicTimerRef.current)
      stopTtsWave(true)
      audioRef.current?.pause()
      musicStartedRef.current = false
      voiceBaselinePlaybackKeyRef.current = trackIdentity(playbackStateRef.current.current)
      setStatus('generating')
      setNotice('')
      setVoiceBoundary(null)
      setProgress(0)
      setFading(false)
      clearCurrentAudioUrl()
      restoreVolumeRef.current = await echo.playback.getVolume()
      volumeRestoreArmedRef.current = true

      const segment = await echo.listening.generateSegment({ continuation: automatic || continuation, automatic })
      sessionIdRef.current = segment.sessionId
      if (!isActiveRef.current || (automatic && !voiceContinuousRef.current)) {
        await endCurrentListeningSession().catch(() => undefined)
        setStatus('idle')
        return
      }
      const musicLabel = segment.track ? `${segment.track.title} · ${segment.track.artist}` : ''
      // 连续模式：上一段写完的手迹落进信纸，再起新段
      if (voiceContinuousRef.current && text.trim() && (statusRef.current !== 'idle' || paragraphs.length > 0)) {
        settleTextParagraph()
      }
      setText(segment.text)
      trackRef.current = segment.track
      setTrackLabel(musicLabel)
      if (segment.delivery === 'silent') {
        setText('')
        settleMusicInterlude(musicLabel)
        if (segment.track) {
          const next = await echo.playback.play(segment.track)
          setPlaybackState(next)
          musicStartedRef.current = true
          await refreshQueue()
        }
        markVoiceRunSucceeded()
        volumeRestoreArmedRef.current = false
        setProgress(1)
        setStatus('done')
        return
      }
      if (!segment.audioUrl) {
        if (segment.boundary) setVoiceBoundary(segment.boundary)
        else setNotice(friendlyOperationError(segment.error, '我现在说不出话来，但文字还在。'))
        if (segment.track) {
          const next = await echo.playback.play(segment.track)
          setPlaybackState(next)
          musicStartedRef.current = true
          await refreshQueue()
        }
        markVoiceRunSucceeded()
        setProgress(1)
        setStatus('text-only-done')
        return
      }
      setCurrentAudioUrl(segment.audioUrl)
      setStatus('speaking')
      window.setTimeout(() => audioRef.current?.play().catch(() => {
        void recoverFromTtsPlaybackFailure()
      }), 80)
    } catch (error) {
      failVoiceRun(error)
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
    triggerContinuousSegment()
  }, [autoStartToken, status])

  // 连续回声兜底：仅在背景音乐从未启动时（比如没有推荐到歌），2 秒后自动触发下一段
  // 音乐在播时由 playbackState effect 检测音乐播完再触发
  useEffect(() => {
    if (!voiceContinuous) return
    if (!isActive) return
    if (status !== 'done' && status !== 'text-only-done') return
    const timer = window.setTimeout(() => {
      if (statusRef.current !== 'done' && statusRef.current !== 'text-only-done') return
      if (!shouldTriggerNextVoiceSegment({
        isActive,
        voiceContinuous,
        status: statusRef.current,
        musicStarted: musicStartedRef.current,
        baselinePlaybackKey: voiceBaselinePlaybackKeyRef.current,
        current: playbackStateRef.current.current,
      })) return
      triggerContinuousSegment()
    }, 2000)
    return () => window.clearTimeout(timer)
  }, [isActive, status, voiceContinuous])

  function toggleContinuousListening() {
    const next = !voiceContinuous
    setVoiceContinuous(next)
    voiceContinuousRef.current = next
    if (!next) void endCurrentListeningSession().catch(() => undefined)
    if (!next && failureRetryTimerRef.current) {
      window.clearTimeout(failureRetryTimerRef.current)
      failureRetryTimerRef.current = null
    }
  }

  // 收笔落款：连续结束后（含说话中收笔、写完才收笔两种时机），手上的句子落进信纸，
  // 视图回到落笔前——整封信留在纸上，墨点按钮随时可以再起一段。
  useEffect(() => {
    if (status !== 'done' && status !== 'text-only-done') return
    if (voiceContinuous || !text.trim() || paragraphs.length === 0) return
    const finished = text.trim()
    paraIdRef.current += 1
    setParagraphs((current) => [...current, { id: paraIdRef.current, kind: 'text', text: finished }])
    setText('')
    setTrackLabel('')
    setStatus('idle')
  }, [status, voiceContinuous, text, paragraphs.length])

  // 散句写完 → 墨散淡出 → 回落笔前（收笔后的信纸不淡出）
  useEffect(() => {
    if (status !== 'done' && status !== 'text-only-done') return undefined
    if (voiceContinuous || notice || voiceBoundary || paragraphs.length > 0) return undefined
    const fadeTimer = window.setTimeout(() => setFading(true), 2100)
    const clearTimer = window.setTimeout(() => {
      setText('')
      setTrackLabel('')
      setFading(false)
      setStatus('idle')
    }, 2100 + 2600)
    return () => {
      window.clearTimeout(fadeTimer)
      window.clearTimeout(clearTimer)
    }
  }, [status, voiceContinuous, notice, voiceBoundary, paragraphs.length])

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
          if (!trackRef.current) markVoiceRunSucceeded()
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
        onError={() => {
          if (statusRef.current === 'speaking') void recoverFromTtsPlaybackFailure()
        }}
        onEnded={() => finishSpeaking().catch(() => setStatus('done'))}
      />
      <div className={`voice-sheet${status === 'idle' ? ' standby' : ''}${paragraphs.length > 0 ? ' with-letter' : ''}${entering ? ' entering' : ''}`}>
        <div className="voice-status-pill">E C H O · {statusLabel}</div>

        {(paragraphs.length > 0 || status === 'speaking' || status === 'done' || status === 'text-only-done' || status === 'error') && (
          <div className={`voice-letter${status === 'idle' ? ' docked' : ''}`} ref={letterRef}>
            {paragraphs.map((entry) => (
              entry.kind === 'music' ? (
                <button
                  className="voice-interlude"
                  type="button"
                  key={entry.id}
                  onClick={() => onOpenListening?.()}
                  title="到一起听看这首歌"
                >
                  <span className="rule" aria-hidden="true" />
                  <span className="voice-interlude-text">♪ {entry.label} · 音乐接着走</span>
                </button>
              ) : (
                <p className="voice-para" key={entry.id}>{entry.text}</p>
              )
            ))}
            {text && status !== 'idle' && (
              <div className={`voice-hand${fading ? ' fading' : ''}`}>
                <span className="written">{parts.said}</span>
                <span className="wetting">{parts.now}</span>
                <span className="pending">{parts.pending}</span>
                <span className="voice-caret" aria-hidden="true" />
              </div>
            )}
          </div>
        )}

        {status === 'idle' ? (
          (() => {
            const greet = splitGreeting(idleGreeting)
            return (
              <div className="voice-standby">
                <div className="voice-greet">
                  <div className="voice-greet-primary">{greet.primary}</div>
                  {greet.secondary && <div className="voice-greet-secondary">{greet.secondary}</div>}
                </div>
                <button className="voice-ink-btn" type="button" onClick={() => { void speak() }} aria-label="听 Echo 说几句">
                  <span className="voice-ink-dot" aria-hidden="true" />
                  <span>再 写 几 句</span>
                </button>
                <button className="voice-keep-writing" type="button" onClick={() => { toggleContinuousListening(); void speak(true) }}>
                  或者，让它一直写下去
                </button>
              </div>
            )
          })()
        ) : status === 'generating' ? (
          <div className="voice-grinding" aria-live="polite">
            <span className="voice-grind-rule" />
            <span>研 墨 中</span>
          </div>
        ) : (
          <>
            {trackLabel && (
              <button className="voice-music-mark" type="button" onClick={() => onOpenListening?.()} title="到一起听看这首歌">
                <small>背 景</small>
                <b>{trackLabel}</b>
              </button>
            )}

            <svg className="voice-ink-stroke" viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true">
              <path d={inkPathD} />
            </svg>

            {notice && <div className="voice-notice" role="status">{notice}</div>}
            {voiceBoundary && <BoundaryState compact snapshot={voiceBoundary} onAction={() => { void speak(false, true) }} />}

            {voiceContinuous && (
              <div className="voice-actions">
                <button className="voice-action stop" type="button" onClick={toggleContinuousListening}>收 笔</button>
              </div>
            )}
          </>
        )}
      </div>
    </div>
  )
}
