import { useCallback, useEffect, useMemo, useState } from 'react'
import type { ActiveScene, PlaybackState, SceneDefinition, SceneKey, Settings, TasteProfile, TasteQuestion, Track } from './types/ipc'
import { getEchoApi } from './renderer/api'
import { ChatPage } from './renderer/pages/Chat'
import { EchoProfilePage } from './renderer/pages/EchoProfile'
import { QueuePage } from './renderer/pages/Queue'
import { SettingsPage } from './renderer/pages/Settings'
import { VoicePage } from './renderer/pages/Voice'
import { YinyiPage } from './renderer/pages/Yinyi'
import { Player } from './renderer/components/Player'
import { HeaderAvatar, WindowControls } from './renderer/components'
import { pageLabels } from './renderer/labels'

export type PageKey = 'chat' | 'profile' | 'yinyi' | 'voice' | 'queue' | 'settings'

export interface AppPageProps {
  navigate: (page: PageKey) => void
}

function App() {
  const echo = useMemo(() => getEchoApi(), [])
  const [page, setPage] = useState<PageKey>('chat')
  const [settings, setSettings] = useState<Settings | null>(null)
  const [bootReady, setBootReady] = useState(false)
  const [profile, setProfile] = useState<TasteProfile | null>(null)
  const [questions, setQuestions] = useState<TasteQuestion[]>([])
  const [queue, setQueue] = useState<Track[]>([])
  const [sceneDefinitions, setSceneDefinitions] = useState<SceneDefinition[]>([])
  const [currentScene, setCurrentScene] = useState<ActiveScene | null>(null)
  const [playbackNotice, setPlaybackNotice] = useState('')
  const [careMuteToast, setCareMuteToast] = useState(false)
  const [careMuteCountdown, setCareMuteCountdown] = useState(5)
  const [voiceAutoStartToken, setVoiceAutoStartToken] = useState(0)
  const [closeDialogOpen, setCloseDialogOpen] = useState(false)
  const [rememberCloseChoice, setRememberCloseChoice] = useState(false)
  const [latestYinyiDate, setLatestYinyiDate] = useState('')
  const [playbackState, setPlaybackState] = useState<PlaybackState>({
    current: null,
    position: 0,
    duration: 0,
    status: 'idle',
    volume: 100,
    queue: [],
    history: [],
  })

  const hasLlmConfig = Boolean(settings?.llm.baseUrl && settings.llm.apiKey && settings.llm.model)

  const refreshProfile = useCallback(async () => {
    const next = await echo.taste.getProfile()
    setProfile(next.profile)
    setQuestions(next.questions)
  }, [echo])

  const refreshQueue = useCallback(async (): Promise<Track[]> => {
    const next = await echo.queue.get()
    setQueue(next)
    return next
  }, [echo])

  const refreshScene = useCallback(async (): Promise<ActiveScene | null> => {
    const next = await echo.scene.getCurrent()
    setCurrentScene(next)
    return next
  }, [echo])

  useEffect(() => {
    let alive = true

    async function boot() {
      const [nextSettings, nextTaste, nextQueue, nextPlayback, nextYinyi, nextScenes, nextScene] = await Promise.all([
        echo.settings.get(),
        echo.taste.getProfile(),
        echo.queue.get(),
        echo.playback.getState(),
        echo.yinyi.getRange(1).catch(() => []),
        echo.scene.definitions(),
        echo.scene.getCurrent(),
      ])

      if (!alive) return
      setSettings(nextSettings)
      setProfile(nextTaste.profile)
      setQuestions(nextTaste.questions)
      setQueue(nextQueue)
      setPlaybackState(nextPlayback)
      setLatestYinyiDate(nextYinyi[0]?.date ?? '')
      setSceneDefinitions(nextScenes)
      setCurrentScene(nextScene)
      const isRealElectron = Boolean(window.echo)
      if (isRealElectron && (!nextSettings.llm.baseUrl || !nextSettings.llm.apiKey || !nextSettings.llm.model)) {
        setPage('settings')
      }
      // 所有初始数据都到位后才解锁主界面，避免渲染时 settings 还是 null 闪一下"去设置"提示。
      setBootReady(true)
    }

    boot()
    return () => {
      alive = false
    }
  }, [echo])

  useEffect(() => {
    const timer = window.setInterval(() => {
      refreshScene().catch(() => undefined)
    }, 60000)
    return () => window.clearInterval(timer)
  }, [refreshScene])

  useEffect(() => {
    return echo.playback.onStateChanged((next) => {
      setPlaybackState(next)
      refreshQueue()
    })
  }, [echo, refreshQueue])

  useEffect(() => {
    return echo.playback.onCookieExpired((message) => {
      setPlaybackNotice(message)
      window.setTimeout(() => setPlaybackNotice(''), 5000)
    })
  }, [echo])

  useEffect(() => {
    return echo.app.onCloseRequested(() => {
      setCloseDialogOpen(true)
    })
  }, [echo])

  useEffect(() => {
    return echo.app.onNavigate((payload) => {
      setPage(payload.page)
      if (payload.action === 'start_listening') setVoiceAutoStartToken((value) => value + 1)
      if (payload.canMuteToday) {
        setCareMuteToast(true)
        setCareMuteCountdown(5)
      }
    })
  }, [echo])

  useEffect(() => {
    if (!careMuteToast) return
    const timer = window.setInterval(() => {
      setCareMuteCountdown((current) => {
        if (current <= 1) {
          window.clearInterval(timer)
          setCareMuteToast(false)
          return 0
        }
        return current - 1
      })
    }, 1000)
    return () => window.clearInterval(timer)
  }, [careMuteToast])

  useEffect(() => {
    if (page === 'profile') {
      refreshProfile().catch(() => undefined)
    }
  }, [page, refreshProfile])

  useEffect(() => {
    return echo.yinyi.onGenerated((payload) => {
      if (payload.status !== 'failed') {
        setLatestYinyiDate((current) => (payload.date > current ? payload.date : current))
      }
    })
  }, [echo])

  useEffect(() => {
    if (page !== 'yinyi') return
    if (!latestYinyiDate) return
    if (settings?.meta?.lastViewedYinyiAt === latestYinyiDate) return
    echo.settings.update('meta.lastViewedYinyiAt', latestYinyiDate).then(setSettings).catch(() => undefined)
  }, [page, latestYinyiDate, settings?.meta?.lastViewedYinyiAt, echo])

  const yinyiUnread = Boolean(latestYinyiDate) && latestYinyiDate !== (settings?.meta?.lastViewedYinyiAt ?? '')

  async function rememberMinimizeChoice() {
    if (!rememberCloseChoice) return
    const next = await echo.settings.update('ui.closeBehavior', 'minimize')
    setSettings(next)
  }

  async function minimizeToTray() {
    await rememberMinimizeChoice()
    setCloseDialogOpen(false)
    await echo.app.minimizeToTray()
  }

  async function quitEcho() {
    await rememberMinimizeChoice()
    setCloseDialogOpen(false)
    await echo.app.quit()
  }

  async function muteCareToday() {
    await echo.carePings.muteToday()
    setCareMuteToast(false)
  }

  async function updateAutoPlayNext(value: boolean) {
    const next = await echo.settings.update('playback.autoPlayNext', value)
    setSettings(next)
  }

  async function startScene(key: SceneKey) {
    const next = await echo.scene.start(key)
    setCurrentScene(next)
    return next
  }

  async function endScene() {
    await echo.scene.end()
    setCurrentScene(null)
  }

  async function closeWindow() {
    if (settings?.ui.closeBehavior === 'minimize') {
      await echo.app.minimizeToTray()
      return
    }
    setCloseDialogOpen(true)
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
            onMinimize={() => echo.window.minimize().catch(() => undefined)}
            onToggleMaximize={() => echo.window.toggleMaximize().catch(() => undefined)}
            onClose={closeWindow}
          />
        </header>
      )
    }

    return (
      <header className="shell-hdr shell-hdr-detail">
        <button className="shell-return" type="button" onClick={() => setPage(page === 'settings' ? 'profile' : 'chat')}>
          ◁ 返回
        </button>
        <div className="shell-title">
          {page === 'settings' ? '设 置' : 'Echo'}
          <small>{page === 'settings' ? 'S E T T I N G S' : 'P R O F I L E'}</small>
        </div>
        <WindowControls
          onMinimize={() => echo.window.minimize().catch(() => undefined)}
          onToggleMaximize={() => echo.window.toggleMaximize().catch(() => undefined)}
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
              startScene={startScene}
              endScene={endScene}
              autoPlayNext={settings?.playback.autoPlayNext ?? true}
              updateAutoPlayNext={updateAutoPlayNext}
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
              currentScene={currentScene}
              endScene={endScene}
            />
          </div>
          {page === 'profile' && (
            <EchoProfilePage
              {...commonProps}
              echo={echo}
              profile={profile}
              questions={questions}
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
              hasLlmConfig={hasLlmConfig}
              refreshProfile={refreshProfile}
              refreshQueue={refreshQueue}
            />
          )}
        </section>
        <div className={page === 'voice' ? 'voice-mode-active' : ''}>
          <Player
            echo={echo}
            state={playbackState}
            setState={setPlaybackState}
            refreshQueue={refreshQueue}
            autoPlayNext={settings?.playback.autoPlayNext ?? true}
          />
        </div>
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
                  onChange={(event) => setRememberCloseChoice(event.target.checked)}
                />
                <span>下次不再提醒，默认最小化到托盘</span>
              </label>
              <div className="close-dialog-actions">
                <button className="btn sec close-quit-btn" type="button" onClick={quitEcho}>直接退出</button>
                <button className="btn close-minimize-btn" type="button" onClick={minimizeToTray}>最小化到托盘</button>
              </div>
            </section>
          </div>
        )}
      </main>
    </div>
  )
}

export default App
