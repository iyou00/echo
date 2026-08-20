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
  /** 书写进度上报：落笔前 false（封面隐藏），文字开始逐步写出后 true（右侧淡入封面） */
  onWritingChange?: (writing: boolean) => void
}

type VoiceStatus = 'idle' | 'generating' | 'speaking' | 'done' | 'text-only-done' | 'error'

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
  onWritingChange,
}: VoicePageProps) {
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const audioContextRef = useRef<AudioContext | null>(null)
  const analyserRef = useRef<AnalyserNode | null>(null)
  const sourceRef = useRef<MediaElementAudioSourceNode | null>(null)
  const rafRef = useRef<number | null>(null)
  const musicTimerRef = useRef<number | null>(null)
  const failureRetryTimerRef = useRef<number | null>(null)
  const ttsWatchdogRef = useRef<number | null>(null)
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
  // 墨线按 preview 的算法运行：时间正弦永远呼吸，音量只做幅度增强——
  // 音频分析不可用时线条依然是活的，不会死平。
  const [inkTime, setInkTime] = useState(0)
  const inkLevelRef = useRef(0)
  const [notice, setNotice] = useState('')
  const [voiceBoundary, setVoiceBoundary] = useState<UiBoundarySnapshot | null>(null)
  // —— 信笺：连续模式下写完的段落与音乐插曲累积在纸上；散句写完墨散淡出 ——
  const [paragraphs, setParagraphs] = useState<Array<{ id: number; kind: 'text'; text: string } | { id: number; kind: 'music'; label: string }>>([])
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

  // 墨线（preview 原算法）：轴线 wob 游移，thick 双正弦起伏，env 两端收细；
  // energy 用实时音量缩放整体幅度。
  const inkPathD = useMemo(() => {
    const width = 200, height = 40, mid = height / 2
    const t = inkTime
    const energy = 1 + inkLevelRef.current * 1.6
    const top: string[] = []
    const bottom: string[] = []
    const steps = 100
    for (let i = 0; i <= steps; i += 1) {
      const u = i / steps
      const x = u * width
      const env = Math.sin(u * Math.PI) ** 1.5
      const wob = Math.sin(u * 7 + t) * 5.5 * env
      const thick = (2.2 + Math.sin(u * 12 - t * 1.7) * 1.4 + Math.sin(t * 2.3) * 0.9) * env * energy
      const y = mid + wob
      top.push(`${i === 0 ? 'M' : 'L'} ${x.toFixed(2)} ${(y - thick).toFixed(2)}`)
      bottom.push(`L ${x.toFixed(2)} ${(y + thick).toFixed(2)}`)
    }
    return `${top.join(' ')} ${bottom.reverse().join(' ')} Z`
  }, [inkTime])

  // 书写中：墨线自走时钟（rAF），音频电平缓入缓出
  useEffect(() => {
    if (status !== 'speaking') return undefined
    let raf = 0
    const tick = () => {
      setInkTime((t) => t + 0.055)
      raf = window.requestAnimationFrame(tick)
    }
    tick()
    return () => window.cancelAnimationFrame(raf)
  }, [status])

  useEffect(() => {
    if (status === 'speaking') return
    inkLevelRef.current = 0
  }, [status])

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
    // 离开回声页时收起封面：回来是阅读态，封面等下一段真正开始书写再淡入
    if (!isActive) onWritingChange?.(false)
  }, [isActive, onWritingChange])

  useEffect(() => {
    onWritingChange?.(status !== 'idle' && status !== 'generating')
  }, [status, onWritingChange])

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
      setText('')
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

  useEffect(() => () => disarmTtsWatchdog(), [])

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
    if (reset) inkLevelRef.current = 0
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
        let sum = 0
        for (let i = 0; i < data.length; i += 1) sum += data[i]
        const avg = sum / data.length / 255
        inkLevelRef.current = inkLevelRef.current * 0.7 + avg * 0.3
        rafRef.current = window.requestAnimationFrame(tick)
      }
      stopTtsWave()
      tick()
    } catch {
      // 分析器不可用（如合成手势挂起 AudioContext）：墨线由时间驱动继续呼吸。
      inkLevelRef.current = 0
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

  // TTS 看门狗：音频处于"播放中"却长时间不前进（坏流/无声停滞，不触发 error 也不
  // 触发 ended）时主动恢复——文字保留、音乐接上，连续回声继续下一段，不再整页卡死。
  function disarmTtsWatchdog() {
    if (ttsWatchdogRef.current != null) {
      window.clearInterval(ttsWatchdogRef.current)
      ttsWatchdogRef.current = null
    }
  }

  function armTtsWatchdog() {
    disarmTtsWatchdog()
    let lastTime = -1
    let stalledSince = 0
    ttsWatchdogRef.current = window.setInterval(() => {
      if (statusRef.current !== 'speaking') {
        disarmTtsWatchdog()
        return
      }
      const audio = audioRef.current
      if (!audio || audio.paused) return
      if (audio.currentTime > lastTime + 0.05) {
        lastTime = audio.currentTime
        stalledSince = 0
        return
      }
      if (!stalledSince) {
        stalledSince = performance.now()
        return
      }
      if (performance.now() - stalledSince >= 6000) {
        disarmTtsWatchdog()
        void recoverFromTtsPlaybackFailure()
      }
    }, 1500)
  }

  async function recoverFromTtsPlaybackFailure(): Promise<void> {
    if (recoveringTtsRef.current) return
    recoveringTtsRef.current = true
    disarmTtsWatchdog()
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
    disarmTtsWatchdog()
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
      disarmTtsWatchdog()
      if (musicTimerRef.current) window.clearTimeout(musicTimerRef.current)
      stopTtsWave(true)
      audioRef.current?.pause()
      musicStartedRef.current = false
      voiceBaselinePlaybackKeyRef.current = trackIdentity(playbackStateRef.current.current)
      const hadFinishedHand = statusRef.current === 'done' || statusRef.current === 'text-only-done'
      setStatus('generating')
      setNotice('')
      setVoiceBoundary(null)
      setProgress(0)
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
      // 连续模式：上一段"已写完"的手迹落进信纸再起新段。
      // hadFinishedHand 在 generating 置位前捕获——否则占位句"让我说一段?"会被当成第一段沉淀。
      if (voiceContinuousRef.current && hadFinishedHand && text.trim()) {
        settleTextParagraph()
      }
      setText(segment.text)
      trackRef.current = segment.track
      if (segment.delivery === 'silent') {
        setText('')
        settleMusicInterlude(segment.track ? `${segment.track.title} · ${segment.track.artist}` : '')
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
      armTtsWatchdog()
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

  // 收笔落款：由「连续 → 停止」的下降沿驱动。说话中收笔的，等当前段写完再结算；
  // 单句写完（从未进入连续）不触发——纸面停在墨迹已干，不再弹回落笔前。
  const settleOnStopRef = useRef(false)
  const prevContinuousRef = useRef(voiceContinuous)
  useEffect(() => {
    if (prevContinuousRef.current && !voiceContinuous) settleOnStopRef.current = true
    prevContinuousRef.current = voiceContinuous
  }, [voiceContinuous])
  useEffect(() => {
    if (!settleOnStopRef.current) return
    if (voiceContinuous) {
      settleOnStopRef.current = false
      return
    }
    if (status !== 'done' && status !== 'text-only-done') return
    settleOnStopRef.current = false
    const finished = text.trim()
    if (finished) {
      paraIdRef.current += 1
      setParagraphs((current) => [...current, { id: paraIdRef.current, kind: 'text', text: finished }])
    }
    setText('')
    setStatus('idle')
  }, [status, voiceContinuous, text])

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
              <div className="voice-hand">
                <span className="written">{parts.said}</span>
                <span className="wetting">{parts.now}</span>
                <span className="voice-caret" aria-hidden="true" />
                <span className="pending">{parts.pending}</span>
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
                <button className="voice-ink-btn" type="button" onClick={() => { void speak() }} aria-label={paragraphs.length > 0 ? '再听 Echo 写几句' : '赏歌一曲'}>
                  <span className="voice-ink-dot" aria-hidden="true" />
                  <span>{paragraphs.length > 0 ? '再 写 几 句' : '赏 歌 一 曲'}</span>
                </button>
                <button className="voice-keep-writing" type="button" onClick={() => { toggleContinuousListening(); void speak(true) }}>
                  或者，让它一直写下去
                </button>
              </div>
            )
          })()
        ) : status === 'generating' ? (
          <div className="voice-grinding" aria-live="polite">
            <svg className="voice-grind-svg" viewBox="0 0 240 96" aria-hidden="true">
              <ellipse className="grind-pool" cx="120" cy="72" rx="86" ry="10" />
              <ellipse className="grind-ink" cx="120" cy="72" rx="58" ry="6.5" />
              <g className="grind-stick">
                <rect x="-5" y="0" width="10" height="26" rx="2" />
                <rect className="grind-stick-tip" x="-5" y="23" width="10" height="4" rx="2" />
              </g>
            </svg>
            <span>研 墨 中</span>
          </div>
        ) : (
          <>
            <svg className={`voice-ink-stroke${status === 'speaking' ? ' breathing' : ''}`} viewBox="0 0 100 40" preserveAspectRatio="none" aria-hidden="true">
              <path d={inkPathD} />
            </svg>

            {notice && <div className="voice-notice" role="status">{notice}</div>}
            {voiceBoundary && <BoundaryState compact snapshot={voiceBoundary} onAction={() => { void speak(false, true) }} />}

            <div className="voice-actions">
              {voiceContinuous ? (
                <button className="voice-action stop" type="button" onClick={toggleContinuousListening}>收 笔</button>
              ) : (
                <button className="voice-action" type="button" onClick={() => { void speak(false, true) }}>再 写 几 句</button>
              )}
            </div>
          </>
        )}
      </div>
    </div>
  )
}
