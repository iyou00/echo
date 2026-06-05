import { Component, useCallback, useEffect, useMemo, useRef, type ErrorInfo, type ReactNode } from 'react'
import type { ActiveScene, PlaybackState, SceneKey, SettingUpdatePatch, Settings, Track } from './types/ipc'
import { getEchoApi } from './renderer/api'
import { AboutEchoPage } from './renderer/pages/AboutEcho'
import { ChatPage } from './renderer/pages/Chat'
import { EchoProfilePage } from './renderer/pages/EchoProfile'
import { QueuePage } from './renderer/pages/Queue'
import { SettingsPage } from './renderer/pages/Settings'
import { VoicePage } from './renderer/pages/Voice'
import { YinyiPage } from './renderer/pages/Yinyi'
import { FirstRunWelcome } from './renderer/components/FirstRunWelcome'
import { Player } from './renderer/components/Player'
import { HeaderAvatar, WindowControls } from './renderer/components'
import { pageLabels } from './renderer/labels'
import { type AppPageProps, type PageKey, useAppState } from './renderer/appState'

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
          <button onClick={() => this.setState({ hasError: false })} style={{ marginTop: 12, padding: '6px 16px', cursor: 'pointer' }}>重试</button>
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
    voiceAutoStartToken,
    voiceContinuous,
    closeDialogOpen,
    rememberCloseChoice,
    latestYinyiDate,
    onboardingOpen,
    firstRunWelcomeOpen,
    settingsImportFocusToken,
    settingsApiFocusToken,
    playbackState,
  } = state

  const setPage = useCallback((page: PageKey) => dispatch({ page }), [dispatch])
  const setSettings = useCallback((settings: Settings | null) => dispatch({ settings }), [dispatch])
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

  useEffect(() => () => {
    if (playbackNoticeTimerRef.current !== null) window.clearTimeout(playbackNoticeTimerRef.current)
  }, [])

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
    dispatch({ currentScene: next })
    return next
  }, [dispatch, echo])

  const reloadSettings = useCallback(async (): Promise<void> => {
    try {
      const next = await echo.settings.get()
      setSettings(next)
      dispatch({ playbackNotice: '' })
    } catch (error) {
      logAppAsyncError('reload settings', error)
      dispatch({ playbackNotice: error instanceof Error ? error.message : '设置读取失败' })
    }
  }, [dispatch, echo, setSettings])

  useEffect(() => {
    let alive = true

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
        const [nextSettings, nextTaste, nextQueue, nextPlayback, nextYinyi, nextScenes, nextScene, nextImportTask] = await Promise.all([
          bootRequired(echo.settings.get(), 10_000, '设置读取超时，请重试。'),
          bootTimeout(echo.taste.getProfile(), 10_000, { profile: null, questions: [] }),
          bootTimeout(echo.queue.get(), 10_000, []),
          bootTimeout(echo.playback.getState(), 10_000, { current: null, position: 0, duration: 0, status: 'idle', volume: 100, queue: [], history: [] }),
          bootTimeout(echo.yinyi.getRange(1), 10_000, []),
          bootTimeout(echo.scene.definitions(), 10_000, []),
          bootTimeout(echo.scene.getCurrent(), 10_000, null),
          bootTimeout(echo.import.getSnapshot(), 10_000, null),
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
        })
        if (!nextSettings) {
          dispatch({ page: 'settings' })
        } else {
          const isExistingUser = Boolean(nextSettings.meta.onboardingCompletedAt) || Boolean(nextTaste.profile)
          const shouldShowFirstRunWelcome = !isExistingUser && !nextSettings.meta.firstRunWelcomeCompletedAt
          dispatch({
            firstRunWelcomeOpen: shouldShowFirstRunWelcome,
            onboardingOpen: !shouldShowFirstRunWelcome && !nextSettings.meta.onboardingCompletedAt && !nextTaste.profile,
          })
          const isRealElectron = Boolean(window.echo)
          const needsOnboarding = !shouldShowFirstRunWelcome && !nextSettings.meta.onboardingCompletedAt && !nextTaste.profile
          if (!needsOnboarding && isRealElectron && (!nextSettings.llm.baseUrl || !nextSettings.llm.apiKey || !nextSettings.llm.model)) {
            dispatch({ page: 'settings' })
          }
        }
      } catch (error) {
        console.error('[app] boot failed', error)
        if (!alive) return
        dispatch({
          page: 'settings',
          playbackNotice: error instanceof Error ? error.message : 'Echo 启动初始化失败',
        })
      } finally {
        if (alive) dispatch({ bootReady: true })
      }
    }

    boot()
    return () => {
      alive = false
    }
  }, [dispatch, echo])

  useEffect(() => {
    const timer = window.setInterval(() => {
      refreshScene().catch((error) => logAppAsyncError('refresh scene', error))
    }, 60000)
    return () => window.clearInterval(timer)
  }, [refreshScene])

  useEffect(() => {
    return echo.scene.onChanged((next) => {
      dispatch({ currentScene: next })
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
    if (settings.meta.onboardingStep === 'playlist' || !settings.meta.onboardingCompletedAt) {
      const updates: SettingUpdatePatch[] = [
        { path: 'meta.onboardingStep' as const, value: 'done' },
        ...(!settings.meta.onboardingCompletedAt ? [{ path: 'meta.onboardingCompletedAt' as const, value: new Date().toISOString() }] : []),
      ]
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
      dispatch({ closeDialogOpen: true })
    })
  }, [dispatch, echo])

  useEffect(() => {
    return echo.app.onNavigate((payload) => {
      dispatch((current) => ({
        page: payload.page,
        voiceAutoStartToken: payload.action === 'start_listening' ? current.voiceAutoStartToken + 1 : current.voiceAutoStartToken,
      }))
      if (payload.canMuteToday) {
        dispatch({ careMuteToast: true, careMuteCountdown: 5 })
      }
    })
  }, [dispatch, echo])

  useEffect(() => {
    if (!careMuteToast) return
    const timer = window.setInterval(() => {
      dispatch((current) => {
        if (current.careMuteCountdown <= 1) {
          window.clearInterval(timer)
          return { careMuteCountdown: 0, careMuteToast: false }
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
    const firstRunDone = Boolean(settings.meta.firstRunWelcomeCompletedAt)
    dispatch({ onboardingOpen: firstRunDone && !firstRunWelcomeOpen && !settings.meta.onboardingCompletedAt && !profile })
  }, [bootReady, dispatch, settings, profile, firstRunWelcomeOpen])

  async function rememberCloseChoiceAs(behavior: NonNullable<Settings['ui']['closeBehavior']>) {
    if (!rememberCloseChoice) return
    const next = await echo.settings.update('ui.closeBehavior', behavior)
    setSettings(next)
  }

  async function minimizeToTray() {
    try {
      await rememberCloseChoiceAs('minimize')
      dispatch({ closeDialogOpen: false })
      await echo.app.minimizeToTray()
    } catch (error) { logAppAsyncError('minimizeToTray', error) }
  }

  async function quitEcho() {
    try {
      await rememberCloseChoiceAs('quit')
      dispatch({ closeDialogOpen: false })
      await echo.app.quit()
    } catch (error) { logAppAsyncError('quitEcho', error) }
  }

  async function muteCareToday() {
    try {
      await echo.carePings.muteToday()
      dispatch({ careMuteToast: false })
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
      dispatch({ firstRunWelcomeOpen: false, onboardingOpen: !next.meta.onboardingCompletedAt && !profile })
    } catch (error) { logAppAsyncError('completeFirstRunWelcome', error) }
  }

  async function startOnboardingApi() {
    try {
      const next = await echo.settings.update('meta.onboardingCompletedAt', new Date().toISOString())
      setSettings(next)
      dispatch((current) => ({ onboardingOpen: false, page: 'settings', settingsApiFocusToken: current.settingsApiFocusToken + 1 }))
    } catch (error) { logAppAsyncError('startOnboardingApi', error) }
  }

  async function startOnboardingImport() {
    try {
      const next = await echo.settings.updateBatch([
        { path: 'meta.onboardingStep', value: 'playlist' },
        { path: 'meta.onboardingCompletedAt', value: new Date().toISOString() },
      ])
      setSettings(next)
      dispatch((current) => ({ onboardingOpen: false, page: 'settings', settingsImportFocusToken: current.settingsImportFocusToken + 1 }))
    } catch (error) { logAppAsyncError('startOnboardingImport', error) }
  }

  async function skipOnboarding() {
    try {
      const next = await echo.settings.update('meta.onboardingCompletedAt', new Date().toISOString())
      setSettings(next)
      dispatch({ onboardingOpen: false })
    } catch (error) { logAppAsyncError('skipOnboarding', error) }
  }

  function setVoiceContinuous(value: boolean) {
    dispatch({ voiceContinuous: value })
    localStorage.setItem('echo:voiceContinuous', value ? '1' : '0')
  }

  async function playScene(key: SceneKey) {
    const result = await echo.scene.play(key, { appendChatMessage: true, targetCount: 1 })
    if (result.tracks.length > 0 || result.message) {
      dispatch({ currentScene: result.scene })
      setPlaybackState(result.state)
      await refreshQueue()
    }
    return result
  }

  async function continueScene(scene: ActiveScene) {
    const current = await echo.scene.getCurrent()
    if (!current || current.id !== scene.id || current.key !== scene.key) return
    const result = await echo.scene.play(current.key, { appendChatMessage: true, continueSession: true, targetCount: 1 })
    if (result.tracks.length > 0 || result.message) {
      dispatch({ currentScene: result.scene })
      setPlaybackState(result.state)
      await refreshQueue()
    }
  }

  async function endScene() {
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
      dispatch({ closeDialogOpen: true })
    } catch (error) {
      logAppAsyncError('closeWindow', error)
      dispatch({
        closeDialogOpen: true,
        playbackNotice: error instanceof Error ? error.message : '关闭窗口失败，请重试。',
      })
    }
  }

  const tabItems: Array<{ key: PageKey; label: string }> = [
    { key: 'chat', label: pageLabels.chat },
    { key: 'yinyi', label: pageLabels.yinyi },
    { key: 'voice', label: pageLabels.voice },
    { key: 'queue', label: pageLabels.queue },
  ]
  const isMainTab = page === 'chat' || page === 'yinyi' || page === 'voice' || page === 'queue'

  function renderShellHeader() {
    if (isMainTab) {
      return (
        <header className="shell-hdr">
          <button className="shell-avatar-button" type="button" onClick={() => setPage('profile')} title="Echo 主页">
            <HeaderAvatar offline={!hasLlmConfig} />
          </button>
          <nav className="shell-tabs" aria-label="Echo 页面">
            {tabItems.map((item) => (
              <button
                className={page === item.key ? 'shell-tab active' : 'shell-tab'}
                type="button"
                key={item.key}
                onClick={() => setPage(item.key)}
              >
                {item.label}
                {item.key === 'yinyi' && yinyiUnread && <span className="tab-unread" aria-label={`今日新${pageLabels.yinyi}`} />}
              </button>
            ))}
          </nav>
          <WindowControls
            onMinimize={() => echo.window.minimize().catch((error) => logAppAsyncError('window minimize', error))}
            onToggleMaximize={() => echo.window.toggleMaximize().catch((error) => logAppAsyncError('window toggle maximize', error))}
            onClose={closeWindow}
          />
        </header>
      )
    }

    return (
      <header className="shell-hdr shell-hdr-detail">
        <button className="shell-return" type="button" onClick={() => setPage(page === 'settings' ? 'profile' : page === 'about' ? 'settings' : 'chat')}>
          ◁ 返回
        </button>
        <div className="shell-title">
          {page === 'settings' ? '设 置' : page === 'about' ? '关 于' : 'Echo'}
          <small>{page === 'settings' ? 'S E T T I N G S' : page === 'about' ? 'A B O U T' : 'P R O F I L E'}</small>
        </div>
        <WindowControls
          onMinimize={() => echo.window.minimize().catch((error) => logAppAsyncError('window minimize', error))}
          onToggleMaximize={() => echo.window.toggleMaximize().catch((error) => logAppAsyncError('window toggle maximize', error))}
          onClose={closeWindow}
        />
      </header>
    )
  }

  const commonProps: AppPageProps = { navigate: setPage }

  if (!bootReady) {
    return (
      <div className="echo-shell">
        <main className="app-frame has-global-player">
          <div className="boot-splash" role="status" aria-live="polite">
            <div className="boot-splash-mark">E C H O</div>
            <div className="boot-splash-tip">在醒过来...</div>
          </div>
        </main>
      </div>
    )
  }

  return (
    <div className="echo-shell">
      <main className="app-frame has-global-player">
        {renderShellHeader()}
        {playbackNotice && <div className="playback-notice">{playbackNotice}</div>}
        {careMuteToast && (
          <div className="care-mute-toast">
            <span>今天先让 Echo 安静一点？<small>{careMuteCountdown} 秒后收起</small></span>
            <button type="button" onClick={muteCareToday}>今天别再提醒</button>
          </div>
        )}
        <section className="shell-body">
          {/*
            主 tab(chat/yinyi/voice/queue) 用 display 切换、保持挂载，
            避免每次切回去都重新 loadRecent / fetch history、闪一下空白。
            详情页(profile/settings) 仍然按需挂载，进入即拉数据。
          */}
          <div className="shell-page" style={{ display: page === 'chat' ? 'flex' : 'none' }}>
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
            />
          </div>
          <div className="shell-page" style={{ display: page === 'yinyi' ? 'flex' : 'none' }}>
            <YinyiPage
              {...commonProps}
              echo={echo}
              isActive={page === 'yinyi'}
              openWithRandom={Boolean(settings?.yinyi.openWithRandom)}
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
          <div className="shell-page" style={{ display: page === 'queue' ? 'flex' : 'none' }}>
            <QueuePage
              {...commonProps}
              queue={queue}
              echo={echo}
              playbackState={playbackState}
              setPlaybackState={setPlaybackState}
              refreshQueue={refreshQueue}
              autoPlayNext={settings?.playback.autoPlayNext ?? true}
              updateAutoPlayNext={updateAutoPlayNext}
            />
          </div>
          {page === 'profile' && (
            <EchoProfilePage
              {...commonProps}
              echo={echo}
              profile={profile}
              setPlaybackState={setPlaybackState}
              refreshQueue={refreshQueue}
              refreshProfile={refreshProfile}
            />
          )}
          {page === 'settings' && (
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
            />
          )}
          {page === 'about' && (
            <AboutEchoPage {...commonProps} />
          )}
        </section>
        <div className={page === 'voice' ? 'voice-mode-active' : ''}>
          <Player
            echo={echo}
            state={playbackState}
            setState={setPlaybackState}
            refreshQueue={refreshQueue}
            autoPlayNext={settings?.playback.autoPlayNext ?? true}
            currentScene={currentScene}
            voiceContinuous={voiceContinuous}
            onSceneTrackEnded={(scene) => {
              continueScene(scene).catch((error) => {
                showPlaybackNotice(error instanceof Error ? error.message : '场景续播失败')
              })
            }}
            onVoiceTrackEnded={() => {
              setPage('voice')
              dispatch((current) => ({ voiceAutoStartToken: current.voiceAutoStartToken + 1 }))
            }}
          />
        </div>
        {firstRunWelcomeOpen && <FirstRunWelcome onContinue={completeFirstRunWelcome} />}
        {closeDialogOpen && (
          <div className="close-dialog-layer" role="presentation">
            <section className="close-dialog" role="dialog" aria-modal="true" aria-labelledby="close-dialog-title">
              <div className="close-dialog-kicker">E C H O · C L O S E</div>
              <h2 id="close-dialog-title">要让我先待在托盘里吗？</h2>
              <p>
                我可以安静地留在后台，音乐继续，下次点开还能接着刚才的位置。你也可以直接退出，下次见。
              </p>
              <label className="close-dialog-check">
                <input
                  type="checkbox"
                  checked={rememberCloseChoice}
                  onChange={(event) => dispatch({ rememberCloseChoice: event.target.checked })}
                />
                <span>下次不再提醒，记住这次选择</span>
              </label>
              <div className="close-dialog-actions">
                <button className="btn sec close-quit-btn" type="button" onClick={quitEcho}>直接退出</button>
                <button className="btn close-minimize-btn" type="button" onClick={minimizeToTray}>最小化到托盘</button>
              </div>
            </section>
          </div>
        )}
        {onboardingOpen && (
          <div className="onboarding-layer" role="presentation">
            <section className="onboarding-card" role="dialog" aria-modal="true" aria-labelledby="onboarding-title">
              <div className="onboarding-kicker">E C H O · F I R S T</div>
              {!hasLlmConfig ? (
                <>
                  <h2 id="onboarding-title">先给我一颗大脑</h2>
                  <p>
                    填好 AI 模型的地址和密钥后，我才能真正理解你的音乐——标签、情绪、场景都会更准。
                  </p>
                  <button className="btn onboarding-primary" type="button" onClick={() => { void startOnboardingApi() }}>
                    去填写模型设置
                  </button>
                  <button className="btn sec onboarding-skip" type="button" onClick={() => { void skipOnboarding() }}>
                    先逛逛
                  </button>
                </>
              ) : (
                <>
                  <h2 id="onboarding-title">先让我认识你的歌</h2>
                  <p>
                    导入一份歌单后，我会先读懂你的口味、常听情绪和安全区。后面推荐、风信、画像和主动关心都会从这里长出来。
                  </p>
                  <button className="btn onboarding-primary" type="button" onClick={() => { void startOnboardingImport() }}>
                    开始导入歌单
                  </button>
                  <button className="btn sec onboarding-skip" type="button" onClick={() => { void skipOnboarding() }}>
                    先逛逛
                  </button>
                </>
              )}
            </section>
          </div>
        )}
      </main>
    </div>
  )
}

export default function Root() {
  return (
    <ErrorBoundary>
      <App />
    </ErrorBoundary>
  )
}
