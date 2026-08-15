import { Component, useCallback, useEffect, useMemo, useRef, useState, type ErrorInfo, type ReactNode } from 'react'
import type { ActiveScene, PlaybackState, SceneKey, SettingUpdatePatch, Settings, Track } from './types/ipc'
import { getEchoApi } from './renderer/api'
import { AboutEchoPage } from './renderer/pages/AboutEcho'
import { ChatPage } from './renderer/pages/Chat'
import { EchoProfilePage } from './renderer/pages/EchoProfile'
import { QueuePage } from './renderer/pages/Queue'
import { ReviewPage } from './renderer/pages/Review'
import { SettingsPage } from './renderer/pages/Settings'
import { VoicePage } from './renderer/pages/Voice'
import { YinyiPage } from './renderer/pages/Yinyi'
import { FirstRunWelcome } from './renderer/components/FirstRunWelcome'
import { Player } from './renderer/components/Player'
import { EchoShell } from './renderer/shell/EchoShell'
import { ContextDrawer } from './renderer/shell/ContextDrawer'
import { BoundaryState } from './renderer/components/BoundaryState'
import { X } from 'lucide-react'
import { WindowField, type WindowFieldMode } from './renderer/shell/WindowField'
import {
  isVoiceContinuousActive,
  scenePlaybackStatePatch,
  voiceContinuousStatePatch,
  type AppPageProps,
  type PageKey,
  useAppState,
} from './renderer/appState'
import { friendlyOperationError } from './shared/runtimeRecovery'
import {
  getOnboardingDisplayState,
  hasConfiguredLlm,
  isOnboardingComplete,
  onboardingCompletionPatchesIfReady,
  onboardingPatchesAfterImport,
  onboardingPatchesAfterLlmReady,
} from './shared/onboardingPolicy'
import { remainingStartupDelay } from './shared/startupPresentation'
import { deriveWindowFieldMode, type ChatStageMode } from './renderer/stageMode'

const SCENE_CONTINUATION_RETRY_DELAYS_MS = [8000, 20_000]

class ErrorBoundary extends Component<{ children: ReactNode }, { hasError: boolean }> {
  state = { hasError: false }
  static getDerivedStateFromError() { return { hasError: true } }
  componentDidCatch(error: Error, info: ErrorInfo) {
    console.warn('[app] render error', error, info.componentStack)
  }
  render() {
    if (this.state.hasError) {
      return (
        <div style={{ padding: 32, textAlign: 'center', color: '#666' }}>
          <p>Echo 遇到了一个意外错误。</p>
          <button onClick={() => window.location.reload()} style={{ marginTop: 12, padding: '6px 16px', cursor: 'pointer' }}>重新载入</button>
        </div>
      )
    }
    return this.props.children
  }
}

function logAppAsyncError(area: string, error: unknown): void {
  console.warn(`[app] ${area} failed`, error)
}

function App() {
  const echo = useMemo(() => getEchoApi(), [])
  const [state, dispatch] = useAppState()
  const handledImportTaskIdsRef = useRef(new Set<string>())
  const playbackNoticeTimerRef = useRef<number | null>(null)
  const sceneRetryTimerRef = useRef<number | null>(null)
  const sceneRetryAttemptsRef = useRef(0)
  const onboardingDeferredForSessionRef = useRef(false)
  const voiceContinuousRef = useRef(false)
  const [chatStageMode, setChatStageMode] = useState<ChatStageMode>('idle')
  const [localPlaybackActive, setLocalPlaybackActive] = useState(false)
  const {
    page,
    settings,
    bootReady,
    profile,
    queue,
    sceneDefinitions,
    currentScene,
    importTask,
    playbackNotice,
    careMuteToast,
    careMuteCountdown,
    carePingId,
    voiceAutoStartToken,
    voiceContinuous,
    closeDialogOpen,
    closeReadiness,
    rememberCloseChoice,
    latestYinyiDate,
    onboardingOpen,
    firstRunWelcomeOpen,
    settingsImportFocusToken,
    settingsApiFocusToken,
    playbackState,
    boundaries,
  } = state

  const setPage = useCallback((page: PageKey) => dispatch({ page }), [dispatch])
  const setSettings = useCallback((settings: Settings | null) => dispatch({ settings }), [dispatch])

  const resetPlaybackSnapshot = useCallback((): PlaybackState => ({
    current: null,
    position: 0,
    duration: 0,
    status: 'idle',
    volume: 100,
    queue: [],
    history: [],
  }), [])
  const setPlaybackState = useCallback((playbackState: PlaybackState) => dispatch({ playbackState }), [dispatch])
  const showPlaybackNotice = useCallback((message: string, autoHideMs = 5000) => {
    if (playbackNoticeTimerRef.current !== null) {
      window.clearTimeout(playbackNoticeTimerRef.current)
      playbackNoticeTimerRef.current = null
    }
    dispatch({ playbackNotice: message })
    if (autoHideMs > 0) {
      playbackNoticeTimerRef.current = window.setTimeout(() => {
        playbackNoticeTimerRef.current = null
        dispatch({ playbackNotice: '' })
      }, autoHideMs)
    }
  }, [dispatch])

  const openCloseDialog = useCallback(async () => {
    try {
      const readiness = await echo.boundary.getCloseReadiness()
      dispatch({ closeDialogOpen: true, closeReadiness: readiness })
    } catch (error) {
      logAppAsyncError('load close readiness', error)
      dispatch({ closeDialogOpen: true, closeReadiness: null })
    }
  }, [dispatch, echo])

  useEffect(() => () => {
    if (playbackNoticeTimerRef.current !== null) window.clearTimeout(playbackNoticeTimerRef.current)
    if (sceneRetryTimerRef.current !== null) window.clearTimeout(sceneRetryTimerRef.current)
  }, [])

  useEffect(() => {
    voiceContinuousRef.current = voiceContinuous
  }, [voiceContinuous])

  const hasLlmConfig = Boolean(settings?.llm.baseUrl && settings.llm.apiKey && settings.llm.model)

  const refreshProfile = useCallback(async () => {
    const next = await echo.taste.getProfile()
    dispatch({ profile: next.profile })
  }, [dispatch, echo])

  const refreshQueue = useCallback(async (): Promise<Track[]> => {
    const next = await echo.queue.get()
    dispatch({ queue: next })
    return next
  }, [dispatch, echo])

  const refreshScene = useCallback(async (): Promise<ActiveScene | null> => {
    const next = await echo.scene.getCurrent()
    dispatch((current) => {
      if (!next) return { currentScene: null }
      if (current.voiceContinuous) return {}
      return scenePlaybackStatePatch(next)
    })
    return next
  }, [dispatch, echo])

  const refreshBoundaries = useCallback(async (): Promise<void> => {
    dispatch({ boundaries: await echo.boundary.get() })
  }, [dispatch, echo])

  const reloadSettings = useCallback(async (): Promise<void> => {
    try {
      const next = await echo.settings.get()
      setSettings(next)
      dispatch({ playbackNotice: '' })
    } catch (error) {
      logAppAsyncError('reload settings', error)
      dispatch({ playbackNotice: friendlyOperationError(error, '设置读取失败，请重新读取。') })
    }
  }, [dispatch, echo, setSettings])

  const handleDataReset = useCallback((nextSettings: Settings) => {
    clearSceneContinuationRetry()
    onboardingDeferredForSessionRef.current = false
    handledImportTaskIdsRef.current.clear()
    const onboardingDisplay = getOnboardingDisplayState(nextSettings, false)
    dispatch({
      settings: nextSettings,
      profile: null,
      queue: [],
      currentScene: null,
      importTask: null,
      playbackState: resetPlaybackSnapshot(),
      latestYinyiDate: '',
      playbackNotice: '',
      careMuteToast: false,
      voiceContinuous: false,
      firstRunWelcomeOpen: onboardingDisplay.firstRunWelcomeOpen,
      onboardingOpen: onboardingDisplay.onboardingOpen,
    })
  }, [dispatch, resetPlaybackSnapshot])

  useEffect(() => {
    let alive = true
    const bootStartedAt = performance.now()

    function bootTimeout<T>(promise: Promise<T>, ms: number, fallback: T): Promise<T> {
      return Promise.race([
        promise,
        new Promise<T>((resolve) => setTimeout(() => resolve(fallback), ms)),
      ]).catch((error) => {
        logAppAsyncError('boot optional resource', error)
        return fallback
      })
    }

    function bootRequired<T>(promise: Promise<T>, ms: number, message: string): Promise<T> {
      return Promise.race([
        promise,
        new Promise<T>((_, reject) => setTimeout(() => reject(new Error(message)), ms)),
      ])
    }

    async function boot() {
      try {
        const [nextSettings, nextTaste, nextQueue, nextPlayback, nextYinyi, nextScenes, nextScene, nextImportTask, nextBoundaries] = await Promise.all([
          bootRequired(echo.settings.get(), 10_000, '设置读取超时，请重试。'),
          bootTimeout(echo.taste.getProfile(), 10_000, { profile: null, questions: [] }),
          bootTimeout(echo.queue.get(), 10_000, []),
          bootTimeout(echo.playback.getState(), 10_000, { current: null, position: 0, duration: 0, status: 'idle', volume: 100, queue: [], history: [] }),
          bootTimeout(echo.yinyi.getRange(1), 10_000, []),
          bootTimeout(echo.scene.definitions(), 10_000, []),
          bootTimeout(echo.scene.getCurrent(), 10_000, null),
          bootTimeout(echo.import.getSnapshot(), 10_000, null),
          bootTimeout(echo.boundary.get(), 10_000, []),
        ])

        if (!alive) return
        dispatch({
          settings: nextSettings,
          profile: nextTaste.profile,
          queue: nextQueue,
          playbackState: nextPlayback,
          latestYinyiDate: nextYinyi[0]?.date ?? '',
          sceneDefinitions: nextScenes,
          currentScene: nextScene,
          importTask: nextImportTask,
          boundaries: nextBoundaries,
        })
        if (!nextSettings) {
          dispatch({ page: 'settings' })
        } else {
          const llmReady = hasConfiguredLlm(nextSettings)
          const completionPatches = onboardingCompletionPatchesIfReady(nextSettings, Boolean(nextTaste.profile))
          if (completionPatches.length > 0) {
            echo.settings.updateBatch(completionPatches)
              .then(setSettings)
              .catch((error) => logAppAsyncError('backfill onboarding completion', error))
          }
          const onboardingDisplay = getOnboardingDisplayState(nextSettings, Boolean(nextTaste.profile))
          dispatch({
            firstRunWelcomeOpen: onboardingDisplay.firstRunWelcomeOpen,
            onboardingOpen: onboardingDisplay.onboardingOpen,
          })
          const isRealElectron = Boolean(window.echo)
          const onboardingActive = onboardingDisplay.firstRunWelcomeOpen || onboardingDisplay.onboardingOpen
          if (!onboardingActive && isRealElectron && !llmReady) {
            dispatch({ page: 'settings' })
          }
        }
      } catch (error) {
        console.error('[app] boot failed', error)
        if (!alive) return
        dispatch({
          page: 'settings',
          playbackNotice: friendlyOperationError(error, 'Echo 启动初始化失败，请重新载入。'),
        })
      } finally {
        const delay = remainingStartupDelay(bootStartedAt, performance.now())
        if (delay > 0) await new Promise((resolve) => window.setTimeout(resolve, delay))
        if (alive) dispatch({ bootReady: true })
      }
    }

    boot()
    return () => {
      alive = false
    }
  }, [dispatch, echo, setSettings])

  useEffect(() => {
    const timer = window.setInterval(() => {
      refreshScene().catch((error) => logAppAsyncError('refresh scene', error))
      refreshBoundaries().catch((error) => logAppAsyncError('refresh boundaries', error))
    }, 60000)
    return () => window.clearInterval(timer)
  }, [refreshBoundaries, refreshScene])

  useEffect(() => {
    if (!bootReady) return
    refreshBoundaries().catch((error) => logAppAsyncError('refresh boundaries after settings change', error))
  }, [bootReady, profile, refreshBoundaries, settings?.llm.apiKey, settings?.llm.baseUrl, settings?.llm.model])

  useEffect(() => {
    return echo.scene.onChanged((next) => {
      dispatch((current) => {
        if (!next) return { currentScene: null }
        if (current.voiceContinuous) return {}
        return scenePlaybackStatePatch(next)
      })
    })
  }, [dispatch, echo])

  useEffect(() => {
    return echo.playback.onStateChanged((next) => {
      setPlaybackState(next)
      void refreshQueue().catch((error) => logAppAsyncError('refresh queue after playback change', error))
    })
  }, [echo, refreshQueue, setPlaybackState])

  useEffect(() => {
    return echo.import.onChanged((next) => {
      dispatch({ importTask: next })
    })
  }, [dispatch, echo])

  useEffect(() => {
    if (!settings) return
    if (importTask?.status !== 'succeeded') return
    if (handledImportTaskIdsRef.current.has(importTask.id)) return
    handledImportTaskIdsRef.current.add(importTask.id)
    refreshProfile().catch((error) => logAppAsyncError('refresh profile after import', error))
    refreshQueue().catch((error) => logAppAsyncError('refresh queue after import', error))
    if (!settings.meta.onboardingCompletedAt) {
      const updates: SettingUpdatePatch[] = onboardingPatchesAfterImport(settings)
      echo.settings.updateBatch(updates)
        .then(setSettings)
        .catch((error) => logAppAsyncError('mark onboarding import complete', error))
    }
  }, [echo, importTask, refreshProfile, refreshQueue, setSettings, settings])

  useEffect(() => {
    return echo.playback.onCookieExpired((message) => {
      showPlaybackNotice(message)
    })
  }, [echo, showPlaybackNotice])

  useEffect(() => {
    return echo.app.onCloseRequested(() => {
      void openCloseDialog()
    })
  }, [echo, openCloseDialog])

  useEffect(() => {
    if (!closeDialogOpen) return
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') dispatch({ closeDialogOpen: false, closeReadiness: null })
    }
    window.addEventListener('keydown', onKeyDown)
    return () => window.removeEventListener('keydown', onKeyDown)
  }, [closeDialogOpen, dispatch])

  useEffect(() => {
    return echo.app.onNavigate((payload) => {
      dispatch((current) => ({
        page: payload.page,
        voiceAutoStartToken: payload.action === 'start_listening' ? current.voiceAutoStartToken + 1 : current.voiceAutoStartToken,
      }))
      if (payload.canMuteToday) {
        dispatch({ careMuteToast: true, careMuteCountdown: 5, carePingId: payload.carePingId ?? null })
      }
    })
  }, [dispatch, echo])

  useEffect(() => {
    if (!careMuteToast) return
    const timer = window.setInterval(() => {
      dispatch((current) => {
        if (current.careMuteCountdown <= 1) {
          window.clearInterval(timer)
          return { careMuteCountdown: 0, careMuteToast: false, carePingId: null }
        }
        return { careMuteCountdown: current.careMuteCountdown - 1 }
      })
    }, 1000)
    return () => window.clearInterval(timer)
  }, [careMuteToast, dispatch])

  useEffect(() => {
    if (page === 'profile') {
      refreshProfile().catch((error) => logAppAsyncError('refresh profile on page enter', error))
    }
  }, [page, refreshProfile])

  useEffect(() => {
    return echo.yinyi.onGenerated((payload) => {
      if (payload.status !== 'failed') {
        dispatch((current) => ({ latestYinyiDate: payload.date > current.latestYinyiDate ? payload.date : current.latestYinyiDate }))
      }
    })
  }, [dispatch, echo])

  useEffect(() => {
    if (page !== 'yinyi') return
    if (!latestYinyiDate) return
    if (settings?.meta?.lastViewedYinyiAt === latestYinyiDate) return
    echo.settings.update('meta.lastViewedYinyiAt', latestYinyiDate)
      .then(setSettings)
      .catch((error) => logAppAsyncError('mark yinyi viewed', error))
  }, [page, latestYinyiDate, settings?.meta?.lastViewedYinyiAt, echo, setSettings])

  const yinyiUnread = Boolean(latestYinyiDate) && latestYinyiDate !== (settings?.meta?.lastViewedYinyiAt ?? '')

  useEffect(() => {
    if (!bootReady || !settings) return
    const onboardingDisplay = getOnboardingDisplayState(settings, Boolean(profile))
    if (onboardingDisplay.firstRunWelcomeOpen) {
      onboardingDeferredForSessionRef.current = false
    }
    dispatch({
      firstRunWelcomeOpen: onboardingDisplay.firstRunWelcomeOpen,
      onboardingOpen: onboardingDisplay.onboardingOpen
        && !firstRunWelcomeOpen
        && !onboardingDeferredForSessionRef.current,
    })
  }, [bootReady, dispatch, settings, profile, firstRunWelcomeOpen])

  async function rememberCloseChoiceAs(behavior: NonNullable<Settings['ui']['closeBehavior']>) {
    if (!rememberCloseChoice) return
    const next = await echo.settings.update('ui.closeBehavior', behavior)
    setSettings(next)
  }

  async function minimizeToTray() {
    try {
      await rememberCloseChoiceAs('minimize')
      dispatch({ closeDialogOpen: false, closeReadiness: null })
      await echo.app.minimizeToTray()
    } catch (error) { logAppAsyncError('minimizeToTray', error) }
  }

  async function quitEcho() {
    try {
      await rememberCloseChoiceAs('quit')
      dispatch({ closeDialogOpen: false, closeReadiness: null })
      await echo.app.quit()
    } catch (error) { logAppAsyncError('quitEcho', error) }
  }

  async function muteCareToday() {
    try {
      await echo.carePings.muteToday(carePingId ?? undefined)
      dispatch({ careMuteToast: false, carePingId: null })
    } catch (error) { logAppAsyncError('muteCareToday', error) }
  }

  async function updateAutoPlayNext(value: boolean) {
    try {
      const next = await echo.settings.update('playback.autoPlayNext', value)
      setSettings(next)
    } catch (error) {
      logAppAsyncError('updateAutoPlayNext', error)
      throw error
    }
  }

  async function completeFirstRunWelcome() {
    try {
      const next = await echo.settings.update('meta.firstRunWelcomeCompletedAt', new Date().toISOString())
      setSettings(next)
      const onboardingComplete = isOnboardingComplete(next, Boolean(profile))
      dispatch({ firstRunWelcomeOpen: false, onboardingOpen: !onboardingComplete })
    } catch (error) {
      logAppAsyncError('completeFirstRunWelcome', error)
      throw error
    }
  }

  async function startOnboardingApi() {
    onboardingDeferredForSessionRef.current = true
    try {
      if (settings?.meta.onboardingStep !== 'api') {
        const next = await echo.settings.update('meta.onboardingStep', 'api')
        setSettings(next)
      }
    } catch (error) {
      logAppAsyncError('mark onboarding api step', error)
    } finally {
      dispatch((current) => ({ onboardingOpen: false, page: 'settings', settingsApiFocusToken: current.settingsApiFocusToken + 1 }))
    }
  }

  async function startOnboardingImport() {
    onboardingDeferredForSessionRef.current = true
    try {
      if (settings?.meta.onboardingStep !== 'playlist') {
        const next = await echo.settings.update('meta.onboardingStep', 'playlist')
        setSettings(next)
      }
    } catch (error) {
      logAppAsyncError('mark onboarding playlist step', error)
    } finally {
      dispatch((current) => ({ onboardingOpen: false, page: 'settings', settingsImportFocusToken: current.settingsImportFocusToken + 1 }))
    }
  }

  async function advanceOnboardingAfterLlmReady() {
    if (!settings || settings.meta.onboardingCompletedAt) return
    const patches = onboardingPatchesAfterLlmReady(Boolean(profile))
    const next = patches.length === 1
      ? await echo.settings.update(patches[0].path, patches[0].value)
      : await echo.settings.updateBatch(patches)
    setSettings(next)
    onboardingDeferredForSessionRef.current = true
    dispatch((current) => profile
      ? { onboardingOpen: false }
      : {
          onboardingOpen: false,
          page: 'settings',
          settingsImportFocusToken: current.settingsImportFocusToken + 1,
        })
  }

  async function skipOnboarding() {
    try {
      const next = await echo.settings.updateBatch([
        { path: 'meta.onboardingStep', value: 'done' },
        { path: 'meta.onboardingCompletedAt', value: new Date().toISOString() },
      ])
      setSettings(next)
      dispatch({ onboardingOpen: false })
    } catch (error) { logAppAsyncError('skipOnboarding', error) }
  }

  function setVoiceContinuous(value: boolean) {
    voiceContinuousRef.current = value
    if (value) {
      clearSceneContinuationRetry()
      if (currentScene) {
        echo.scene.end().catch((error) => logAppAsyncError('end scene for voice continuous', error))
      }
    }
    dispatch(voiceContinuousStatePatch(value))
  }

  function clearSceneContinuationRetry(resetAttempts = true) {
    if (sceneRetryTimerRef.current !== null) {
      window.clearTimeout(sceneRetryTimerRef.current)
      sceneRetryTimerRef.current = null
    }
    if (resetAttempts) sceneRetryAttemptsRef.current = 0
  }

  function scheduleSceneContinuationRetry(scene: ActiveScene, enqueueOnly = false) {
    if (sceneRetryTimerRef.current !== null) return
    const attempt = sceneRetryAttemptsRef.current
    const delay = SCENE_CONTINUATION_RETRY_DELAYS_MS[attempt]
    if (delay === undefined) {
      sceneRetryAttemptsRef.current = 0
      showPlaybackNotice('这个场景先停一下。你再点一次，我重新帮你找。')
      return
    }
    sceneRetryAttemptsRef.current += 1
    sceneRetryTimerRef.current = window.setTimeout(() => {
      sceneRetryTimerRef.current = null
      if (voiceContinuousRef.current) return
      continueScene(scene, true, enqueueOnly).catch((error) => {
        logAppAsyncError('retry scene continuation', error)
      })
    }, delay)
  }

  async function playScene(key: SceneKey) {
    clearSceneContinuationRetry()
    voiceContinuousRef.current = false
    dispatch({ voiceContinuous: false })
    const result = await echo.scene.play(key, { appendChatMessage: true, targetCount: 3 })
    if (result.tracks.length > 0 || result.message) {
      dispatch(scenePlaybackStatePatch(result.scene))
      setPlaybackState(result.state)
      await refreshQueue()
    }
    return result
  }

  async function continueScene(scene: ActiveScene, fromRetry = false, enqueueOnly = false) {
    if (voiceContinuousRef.current) return
    if (!fromRetry) clearSceneContinuationRetry()
    const current = await echo.scene.getCurrent()
    if (!current || current.id !== scene.id || current.key !== scene.key) return
    const result = await echo.scene.play(current.key, {
      appendChatMessage: false,
      continueSession: true,
      targetCount: enqueueOnly ? 2 : 1,
      enqueueOnly,
    })
    if (result.tracks.length > 0 || result.message) {
      clearSceneContinuationRetry()
      dispatch(scenePlaybackStatePatch(result.scene))
      setPlaybackState(result.state)
      await refreshQueue()
      return
    }
    scheduleSceneContinuationRetry(current, enqueueOnly)
  }

  async function endScene() {
    clearSceneContinuationRetry()
    await echo.scene.end()
    dispatch({ currentScene: null })
  }

  async function closeWindow() {
    try {
      if (settings?.ui.closeBehavior === 'minimize') {
        await echo.app.minimizeToTray()
        return
      }
      if (settings?.ui.closeBehavior === 'quit') {
        await echo.app.quit()
        return
      }
      await openCloseDialog()
    } catch (error) {
      logAppAsyncError('closeWindow', error)
      dispatch({ playbackNotice: friendlyOperationError(error, '关闭窗口失败，请重试。') })
      await openCloseDialog()
    }
  }

  const fieldMode: WindowFieldMode = deriveWindowFieldMode({
    page,
    voiceContinuous,
    currentScene: Boolean(currentScene),
    playbackStatus: playbackState.status,
    localPlaybackActive,
    chatStageMode,
  })
  const drawerOpen = page === 'review' || page === 'queue' || page === 'profile' || page === 'settings' || page === 'about'
  const [settingsDrawerTitle, setSettingsDrawerTitle] = useState('设置')
  const offlineBoundary = boundaries.find((item) => item.code === 'offline')
  const modelInvalidBoundary = boundaries.find((item) => item.code === 'model_invalid')
  const drawerTitle = page === 'review'
    ? '回望今天'
    : page === 'queue'
    ? '音乐与队列'
    : page === 'profile'
      ? 'Echo 对你的理解'
      : page === 'about'
        ? '关于 Echo'
        : settingsDrawerTitle

  const commonProps: AppPageProps = { navigate: setPage }
  const closeDrawer = useCallback(() => setPage('chat'), [setPage])

  if (!bootReady) {
    return (
      <div className="echo-shell boot-shell">
        <WindowField mode="quiet" />
        <main className="app-frame has-global-player">
          <div className="boot-splash" role="status" aria-live="polite">
            <div className="boot-splash-mark">E C H O</div>
            <div className="boot-splash-tip">正在重新接上</div>
          </div>
        </main>
      </div>
    )
  }

  return (
    <EchoShell
      page={page}
      fieldMode={fieldMode}
      yinyiUnread={yinyiUnread}
      connected={hasLlmConfig && !offlineBoundary && !modelInvalidBoundary}
      onNavigate={setPage}
      onMinimize={() => echo.window.minimize().catch((error) => logAppAsyncError('window minimize', error))}
      onClose={closeWindow}
    >
        {offlineBoundary && <BoundaryState compact snapshot={offlineBoundary} onAction={() => { void refreshBoundaries() }} />}
        {playbackNotice && <div className="playback-notice">{playbackNotice}</div>}
        {careMuteToast && (
          <div className="care-mute-toast">
            <span>今天先让 Echo 安静一点？<small>{careMuteCountdown} 秒后收起</small></span>
            <button type="button" onClick={muteCareToday}>今天别再提醒</button>
          </div>
        )}
        <section className="shell-body">
          {/*
            主 tab 和设置页用 display 切换、保持挂载，
            避免每次切回去都重新 loadRecent / fetch history、闪一下空白。
            画像与关于页按需挂载。
          */}
          <div className="shell-page d2-now-page" style={{ display: page === 'chat' || drawerOpen ? 'flex' : 'none' }}>
            <ChatPage
              {...commonProps}
              echo={echo}
              queue={queue}
              playbackState={playbackState}
              setPlaybackState={setPlaybackState}
              hasLlmConfig={hasLlmConfig}
              profile={profile}
              refreshQueue={refreshQueue}
              restoreOnStart={Boolean(settings?.chat.restoreOnStart)}
              scenes={sceneDefinitions}
              currentScene={currentScene}
              playScene={playScene}
              endScene={endScene}
              autoPlayNext={settings?.playback.autoPlayNext ?? true}
              updateAutoPlayNext={updateAutoPlayNext}
              focusApiSettings={() => dispatch((current) => ({ settingsApiFocusToken: current.settingsApiFocusToken + 1 }))}
              boundaries={boundaries}
              onStageModeChange={setChatStageMode}
            />
          </div>
          <div className="shell-page" style={{ display: page === 'yinyi' ? 'flex' : 'none' }}>
            <YinyiPage
              {...commonProps}
              echo={echo}
              isActive={page === 'yinyi'}
              openWithRandom={Boolean(settings?.yinyi.openWithRandom)}
              boundary={boundaries.find((item) => item.code === 'yinyi_empty')}
            />
          </div>
          <div className="shell-page" style={{ display: page === 'voice' ? 'flex' : 'none' }}>
            <VoicePage
              {...commonProps}
              echo={echo}
              playbackState={playbackState}
              setPlaybackState={setPlaybackState}
              refreshQueue={refreshQueue}
              autoStartToken={voiceAutoStartToken}
              isActive={page === 'voice'}
              voiceContinuous={voiceContinuous}
              setVoiceContinuous={setVoiceContinuous}
            />
          </div>
        </section>
        <ContextDrawer open={drawerOpen} title={drawerTitle} view={page} onClose={closeDrawer}>
          <div className="d2-drawer-view" style={{ display: page === 'review' ? 'flex' : 'none' }}>
            <ReviewPage echo={echo} isActive={page === 'review'} />
          </div>
          <div className="d2-drawer-view" style={{ display: page === 'queue' ? 'flex' : 'none' }}>
            <QueuePage
              {...commonProps}
              queue={queue}
              echo={echo}
              playbackState={playbackState}
              setPlaybackState={setPlaybackState}
              refreshQueue={refreshQueue}
              autoPlayNext={settings?.playback.autoPlayNext ?? true}
              boundary={boundaries.find((item) => item.code === 'queue_empty')}
              updateAutoPlayNext={updateAutoPlayNext}
            />
          </div>
          {page === 'profile' && (
            <div className="d2-drawer-view">
            <EchoProfilePage
                {...commonProps}
                echo={echo}
                profile={profile}
                playbackState={playbackState}
                setPlaybackState={setPlaybackState}
                refreshQueue={refreshQueue}
                refreshProfile={refreshProfile}
                boundary={boundaries.find((item) => item.code === 'taste_empty')}
              />
            </div>
          )}
          <div className="d2-drawer-view" style={{ display: page === 'settings' ? 'flex' : 'none' }}>
            <SettingsPage
              {...commonProps}
              echo={echo}
              settings={settings}
              setSettings={setSettings}
              reloadSettings={reloadSettings}
              hasLlmConfig={hasLlmConfig}
              refreshProfile={refreshProfile}
              refreshQueue={refreshQueue}
              importFocusToken={settingsImportFocusToken}
              apiFocusToken={settingsApiFocusToken}
              importTask={importTask}
              onOnboardingLlmReady={advanceOnboardingAfterLlmReady}
              onRestartOnboarding={() => {
                onboardingDeferredForSessionRef.current = false
                dispatch({ onboardingOpen: true, page: 'chat' })
              }}
              onTitleChange={setSettingsDrawerTitle}
              onDataReset={handleDataReset}
            />
          </div>
          {page === 'about' && (
            <div className="d2-drawer-view"><AboutEchoPage {...commonProps} /></div>
          )}
        </ContextDrawer>
        <div className={`d2-player-layer player-${fieldMode} page-${page}${page === 'voice' ? ' voice-mode-active' : ''}`}>
          <Player
            echo={echo}
            state={playbackState}
            setState={setPlaybackState}
            refreshQueue={refreshQueue}
            autoPlayNext={settings?.playback.autoPlayNext ?? true}
            currentScene={currentScene}
            voiceContinuous={isVoiceContinuousActive(page, voiceContinuous)}
            onSceneTrackEnded={(scene, mode) => {
              continueScene(scene, false, mode === 'refill').catch((error) => {
                showPlaybackNotice(friendlyOperationError(error, '这个场景暂时没找到下一首，已经停下来了。'))
              })
            }}
            onVoiceTrackEnded={() => {
              setPage('voice')
              dispatch((current) => ({ voiceAutoStartToken: current.voiceAutoStartToken + 1 }))
            }}
            onOpenQueue={() => setPage('queue')}
            onLocalPlayingChange={setLocalPlaybackActive}
          />
        </div>
        {firstRunWelcomeOpen && <FirstRunWelcome onContinue={completeFirstRunWelcome} />}
        {closeDialogOpen && (
          <div className="close-dialog-layer" role="presentation">
            <section className="close-dialog" role="dialog" aria-modal="true" aria-labelledby="close-dialog-title">
              <button
                className="close-dialog-dismiss"
                type="button"
                title="继续使用 Echo"
                aria-label="继续使用 Echo"
                onClick={() => dispatch({ closeDialogOpen: false, closeReadiness: null })}
              >
                <X size={15} />
              </button>
              <div className="close-dialog-kicker">E C H O · C L O S E</div>
              <h2 id="close-dialog-title">{closeReadiness?.boundary ? '还有事情正在继续。' : '要让我先待在托盘里吗？'}</h2>
              {closeReadiness?.activities.length ? (
                <div className="close-activity-list">
                  {closeReadiness.activities.map((activity, index) => (
                    <div className="close-activity" key={`${activity.kind}-${activity.sourceId ?? index}`}>
                      <span className={activity.kind} aria-hidden="true" />
                      {activity.label}
                    </div>
                  ))}
                  <p>留在托盘会继续这些事情。直接退出会明确结束本次运行，不会把未完成任务记成成功。</p>
                </div>
              ) : (
                <p>我可以安静地留在后台，音乐继续，下次点开还能接着刚才的位置。你也可以直接退出，下次见。</p>
              )}
              <label className="close-dialog-check">
                <input
                  type="checkbox"
                  checked={rememberCloseChoice}
                  onChange={(event) => dispatch({ rememberCloseChoice: event.target.checked })}
                />
                <span>下次不再提醒，记住这次选择</span>
              </label>
              <div className="close-dialog-actions">
                <button className="d2-dialog-btn close-quit-btn" type="button" onClick={quitEcho}>直接退出</button>
                <button className="d2-dialog-btn primary close-minimize-btn" type="button" onClick={minimizeToTray}>最小化到托盘</button>
              </div>
            </section>
          </div>
        )}
        {onboardingOpen && (
          <div className="d2-onboarding-layer" role="presentation">
            <section className="d2-onboarding" role="dialog" aria-modal="true" aria-labelledby="onboarding-title">
              <div className="d2-onboarding-kicker">ECHO · FIRST</div>
              {!hasLlmConfig ? (
                <>
                  <h2 id="onboarding-title">先给我一颗大脑</h2>
                  <p>
                    填好 AI 模型的地址和密钥后，我才能真正理解你的音乐——标签、情绪、场景都会更准。
                  </p>
                  <button className="d2-dialog-btn primary d2-onboarding-primary" type="button" onClick={() => { void startOnboardingApi() }}>
                    去填写模型设置
                  </button>
                  <button data-testid="onboarding-skip" className="d2-onboarding-skip" type="button" onClick={() => { void skipOnboarding() }}>
                    先逛逛
                  </button>
                </>
              ) : (
                <>
                  <h2 id="onboarding-title">先让我认识你的歌</h2>
                  <p>
                    导入一份歌单后，我会先读懂你的口味、常听情绪和反复回来的声音。后面推荐、风信、画像和主动关心都会从这里长出来。
                  </p>
                  <button className="d2-dialog-btn primary d2-onboarding-primary" type="button" onClick={() => { void startOnboardingImport() }}>
                    开始导入歌单
                  </button>
                  <button data-testid="onboarding-skip" className="d2-onboarding-skip" type="button" onClick={() => { void skipOnboarding() }}>
                    先逛逛
                  </button>
                </>
              )}
            </section>
          </div>
        )}
    </EchoShell>
  )
}

export default function Root() {
  return (
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  )
}
