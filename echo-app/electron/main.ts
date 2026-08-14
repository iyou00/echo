import { app, BrowserWindow, Menu, nativeImage, Notification, shell, Tray } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import fs from 'node:fs'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import type { AppNavigatePayload, AppPageKey, SceneKey } from '../src/types/ipc'
import { closeDb } from '../src/main/db'
import { getSettings, upgradeLegacySettingsSecrets } from '../src/main/db/settings'
import { pruneOldData } from '../src/main/db/maintenance'
import { upgradeLegacyNeteaseSecret } from '../src/main/netease/auth'
import { registerIpc } from '../src/main/ipc'
import { registerScheduler, runStartupCatchup, stopScheduler } from '../src/main/services/scheduler'
import { archiveDaySeal, warmMostRecentSealCache } from '../src/main/services/daySeal'
import { checkSecureStorage } from '../src/main/utils/secureStorage'
import { getState as getPlaybackState, onPlaybackStateChanged, pause, recordAppClosedPlayback, resume } from '../src/main/services/playback'
import { getCurrentScene, listSceneDefinitions, onSceneChanged } from '../src/main/services/scene'
import { NeteaseAuthRequiredError } from '../src/main/services/recommendation'
import { startScenePlayback } from '../src/main/services/scenePlayback'
import { recordSchedulerHealth } from '../src/main/services/health'
import { warmRootFileCache } from '../src/main/utils/paths'
import { loadActiveStageContext } from '../src/main/domain/stageContext/repository'
import { recoverInterruptedAgentActions } from '../src/main/domain/agentAction/repository'
import { reconcileCarePingOutcomes } from '../src/main/services/carePings'
import { windowSizeForPreset } from '../src/shared/windowSize'

const __dirname = path.dirname(fileURLToPath(import.meta.url))

// The built directory structure
//
// ├─┬─┬ dist
// │ │ └── index.html
// │ │
// │ ├─┬ dist-electron
// │ │ ├── main.js
// │ │ └── preload.mjs
// │
process.env.APP_ROOT = path.join(__dirname, '..')

// 🚧 Use ['ENV_NAME'] avoid vite:define plugin - Vite@2.x
export const VITE_DEV_SERVER_URL = process.env['VITE_DEV_SERVER_URL']
export const MAIN_DIST = path.join(process.env.APP_ROOT, 'dist-electron')
export const RENDERER_DIST = path.join(process.env.APP_ROOT, 'dist')

process.env.VITE_PUBLIC = VITE_DEV_SERVER_URL ? path.join(process.env.APP_ROOT, 'public') : RENDERER_DIST

app.disableHardwareAcceleration()
app.commandLine.appendSwitch('disable-gpu')

if (VITE_DEV_SERVER_URL) {
  app.setPath('userData', path.join(process.env.APP_ROOT, '.electron-user-data'))
}

if (process.platform === 'win32') {
  app.setAppUserModelId('app.echo.desktop')
}

process.on('uncaughtException', (error) => {
  console.error('[fatal] uncaught exception:', error)
})

process.on('unhandledRejection', (reason) => {
  console.error('[fatal] unhandled rejection:', reason)
})

let win: BrowserWindow | null
let isQuitting = false
let cleanupStarted = false
let tray: Tray | null = null
let traySceneRunning: SceneKey | null = null

const TRAY_SCENE_KEYS: SceneKey[] = ['focus', 'sleepy', 'relax', 'irritated', 'random']
const gotSingleInstanceLock = app.requestSingleInstanceLock()

if (!gotSingleInstanceLock) {
  app.quit()
}

function createAppIcon() {
  const publicDir = process.env.VITE_PUBLIC ?? path.join(process.env.APP_ROOT ?? process.cwd(), 'public')
  const iconPaths = [
    path.join(process.resourcesPath, 'brand', 'icon.ico'),
    path.join(publicDir, 'brand', 'icon.ico'),
  ]
  for (const iconPath of iconPaths) {
    const icon = nativeImage.createFromPath(iconPath)
    if (!icon.isEmpty()) return icon
  }
  return nativeImage.createFromDataURL(
    'data:image/svg+xml;utf8,' +
      encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" rx="14" fill="#639922"/><text x="32" y="41" text-anchor="middle" font-family="Georgia,serif" font-size="34" fill="white">E</text></svg>'),
  )
}

function createWindow() {
  const windowSize = windowSizeForPreset(getSettings().ui.windowSize)
  const target = new BrowserWindow({
    title: 'Echo',
    ...windowSize,
    frame: false,
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: -100, y: -100 },
    transparent: false,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    autoHideMenuBar: true,
    center: true,
    backgroundColor: '#F5FAED',
    icon: createAppIcon(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
      backgroundThrottling: false,
    },
  })

  win = target
  target.webContents.session.webRequest.onHeadersReceived((details, callback) => {
    const connectSrc = VITE_DEV_SERVER_URL ? "'self' http://localhost:* ws://localhost:* http://127.0.0.1:* ws://127.0.0.1:*" : "'self'"
    const scriptSrc = VITE_DEV_SERVER_URL ? "'self' 'unsafe-inline'" : "'self'"
    callback({
      responseHeaders: {
        ...details.responseHeaders,
        'Content-Security-Policy': [
          [
            "default-src 'self'",
            `script-src ${scriptSrc}`,
            "style-src 'self' 'unsafe-inline'",
            "img-src 'self' data: https:",
            "media-src 'self' blob: data: https: http:",
            `connect-src ${connectSrc} https: http:`,
            "font-src 'self' data:",
            "object-src 'none'",
          ].join('; '),
        ],
      },
    })
  })

  target.on('close', (event) => {
    if (isQuitting) return
    event.preventDefault()
    const settings = getSettings()
    if (settings.ui.closeBehavior === 'minimize') {
      win?.hide()
      return
    }
    if (settings.ui.closeBehavior === 'quit') {
      isQuitting = true
      app.quit()
      return
    }

    win?.show()
    win?.webContents.send('app:close-requested')
  })

  const load = VITE_DEV_SERVER_URL
    ? target.loadURL(VITE_DEV_SERVER_URL)
    : target.loadFile(path.join(RENDERER_DIST, 'index.html'))
  void load.catch((error) => {
    if (target.isDestroyed() || win !== target) return
    target.destroy()
    createStartupFailureWindow(error)
  })
}

function startupLogDirectory(): string {
  return path.join(app.getPath('userData'), 'logs')
}

function logStartupFailure(error: unknown): string | null {
  try {
    const logDir = startupLogDirectory()
    fs.mkdirSync(logDir, { recursive: true })
    const detail = error instanceof Error ? error.stack ?? error.message : String(error)
    const logPath = path.join(logDir, 'startup-error.log')
    fs.appendFileSync(logPath, `[${new Date().toISOString()}]\n${detail}\n\n`, 'utf8')
    return logPath
  } catch (logError) {
    console.warn('[startup] failed to write recovery log', logError)
    return null
  }
}

function createStartupFailureWindow(error: unknown): void {
  console.error('[startup] initialization failed', error)
  logStartupFailure(error)
  if (win && !win.isDestroyed()) win.destroy()
  win = new BrowserWindow({
    title: 'Echo 启动恢复',
    width: 680,
    height: 440,
    resizable: false,
    maximizable: false,
    fullscreenable: false,
    autoHideMenuBar: true,
    center: true,
    backgroundColor: '#EEF0EB',
    icon: createAppIcon(),
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  })
  win.webContents.on('will-navigate', (event, url) => {
    if (!url.startsWith('echo-action://')) return
    event.preventDefault()
    if (url === 'echo-action://retry') {
      isQuitting = true
      app.relaunch()
      app.quit()
      return
    }
    if (url === 'echo-action://logs') {
      void shell.openPath(startupLogDirectory()).catch((openError) => {
        console.warn('[startup] failed to open diagnostics directory', openError)
      })
      return
    }
    if (url === 'echo-action://quit') {
      isQuitting = true
      app.quit()
    }
  })
  const html = `<!doctype html>
<html lang="zh-CN">
<meta charset="utf-8">
<title>Echo 启动恢复</title>
<style>
  *{box-sizing:border-box}body{margin:0;background:#eef0eb;color:#19201b;font-family:"Microsoft YaHei",sans-serif;display:grid;place-items:center;min-height:100vh}
  main{width:min(540px,calc(100vw - 64px));border-left:3px solid #d94d38;padding:8px 0 8px 28px}
  small{display:block;margin-bottom:18px;color:#d94d38;font-size:10px;letter-spacing:3px}
  h1{font:400 28px/1.4 Georgia,"SimSun",serif;margin:0 0 14px;letter-spacing:0}
  p{max-width:470px;font-size:13px;line-height:1.8;margin:0;color:#6e766f;letter-spacing:0}
  .code{margin-top:12px;color:#6e766f;font:10px/1.4 Consolas,monospace}
  nav{display:flex;flex-wrap:wrap;gap:9px;margin-top:28px}
  a{display:inline-flex;min-height:36px;align-items:center;padding:7px 14px;border:1px solid #c8cec7;border-radius:2px;background:#f8f8f3;color:#19201b;font-size:12px;text-decoration:none}
  a.primary{border-color:#184734;background:#184734;color:white}
</style>
<main>
  <small>E C H O · R E C O V E R Y</small>
  <h1>Echo 这次没有顺利醒来</h1>
  <p>你的本地数据没有被清理。可以先重新启动；如果仍然失败，打开诊断目录，把 startup-error.log 留给排查。</p>
  <div class="code">STARTUP_FAILED · 本地数据已保留</div>
  <nav>
    <a class="primary" href="echo-action://retry">重新启动 Echo</a>
    <a href="echo-action://logs">打开诊断目录</a>
    <a href="echo-action://quit">退出</a>
  </nav>
</main>
</html>`
  win.on('closed', () => {
    isQuitting = true
    app.quit()
  })
  void win.loadURL(`data:text/html;charset=utf-8,${encodeURIComponent(html)}`).catch((loadError) => {
    console.error('[startup] recovery window failed to load', loadError)
    app.quit()
  })
}

function sendNavigate(target: BrowserWindow, payload: AppNavigatePayload): void {
  const send = () => {
    if (!target.isDestroyed()) target.webContents.send('app:navigate', payload)
  }
  if (target.webContents.isLoading()) {
    target.webContents.once('did-finish-load', send)
  } else {
    send()
  }
}

function showWindow(page?: AppPageKey, action?: AppNavigatePayload['action']): void {
  if (!win || win.isDestroyed()) createWindow()
  if (!win) return
  if (win.isMinimized()) win.restore()
  win.show()
  win.focus()
  if (process.platform === 'win32') {
    win.setAlwaysOnTop(true)
    win.setAlwaysOnTop(false)
  }
  if (page) sendNavigate(win, { page, action, canMuteToday: false })
}

function showTrayNotification(body: string): void {
  if (!Notification.isSupported()) return
  new Notification({
    title: 'Echo',
    body,
    icon: createAppIcon(),
  }).show()
}

function trayActionErrorMessage(error: unknown): string {
  if (error instanceof NeteaseAuthRequiredError) return '先登录网易云，Echo 才能在后台给你放歌。'
  if (error instanceof Error && /网络|fetch|ECONN|ENOTFOUND|超时/i.test(error.message)) {
    return '刚才连接不太顺，稍后再试一次。'
  }
  return 'Echo 这次没接上，稍后再试。'
}

function buildTrayMenuTemplate(): MenuItemConstructorOptions[] {
  const playback = getPlaybackState()
  const currentScene = getCurrentScene()
  const sceneDefinitions = new Map(listSceneDefinitions().map((scene) => [scene.key, scene]))
  const playbackControlLabel = playback.status === 'paused' ? '继续播放' : '暂停播放'

  const sceneItems: MenuItemConstructorOptions[] = TRAY_SCENE_KEYS.map((key) => {
    const scene = sceneDefinitions.get(key)
    return {
      label: scene?.label ?? key,
      type: 'checkbox',
      checked: currentScene?.key === key,
      enabled: traySceneRunning === null || traySceneRunning === key,
      click: () => {
        void runTrayScene(key)
      },
    }
  })

  return [
    {
      label: '显示 Echo',
      click: () => showWindow(),
    },
    {
      label: '回声一下',
      click: () => showWindow('voice', 'start_listening'),
    },
    { type: 'separator' },
    ...sceneItems,
    { type: 'separator' },
    {
      label: playbackControlLabel,
      enabled: Boolean(playback.current),
      click: () => {
        const state = getPlaybackState()
        if (!state.current) return
        if (state.status === 'paused') resume()
        else pause()
        rebuildTrayMenu()
      },
    },
    { type: 'separator' },
    {
      label: '退出 Echo',
      click: () => {
        isQuitting = true
        app.quit()
      },
    },
  ]
}

function rebuildTrayMenu(): void {
  if (!tray) return
  tray.setContextMenu(Menu.buildFromTemplate(buildTrayMenuTemplate()))
}

async function runTrayScene(key: SceneKey): Promise<void> {
  if (traySceneRunning) return
  traySceneRunning = key
  rebuildTrayMenu()
  try {
    const result = await startScenePlayback(key)
    const first = result.tracks[0]
    const trackLine = first ? `先放《${first.title}》。` : ''
    showTrayNotification(`Echo 已进入${result.scene.label}场景。${trackLine}`)
  } catch (error) {
    showTrayNotification(trayActionErrorMessage(error))
  } finally {
    traySceneRunning = null
    rebuildTrayMenu()
  }
}

function createTray() {
  if (tray) return
  tray = new Tray(createAppIcon())
  tray.setToolTip('Echo')
  rebuildTrayMenu()
  tray.on('click', () => {
    showWindow()
  })
  tray.on('right-click', () => rebuildTrayMenu())
}

// Quit when all windows are closed, except on macOS. There, it's common
// for applications and their menu bar to stay active until the user quits
// explicitly with Cmd + Q.
app.on('window-all-closed', async () => {
  await archiveDaySeal().catch((error) => {
    console.warn('[daySeal] archive failed during window-all-closed', error)
  })
  if (isQuitting && process.platform !== 'darwin') {
    app.quit()
    win = null
  }
})

app.on('activate', () => {
  // On OS X it's common to re-create a window in the app when the
  // dock icon is clicked and there are no other windows open.
  if (BrowserWindow.getAllWindows().length === 0) {
    createWindow()
  }
})

app.on('second-instance', () => {
  showWindow()
})

app.on('before-quit', async (event) => {
  if (cleanupStarted) return
  event.preventDefault()
  cleanupStarted = true
  isQuitting = true
  await archiveDaySeal().catch((error) => {
    console.warn('[daySeal] archive failed during before-quit', error)
  })
  recordAppClosedPlayback()
  stopScheduler()
  closeDb()
  app.exit(0)
})

if (gotSingleInstanceLock) {
  app.whenReady()
    .then(() => {
      try {
        Menu.setApplicationMenu(null)
        checkSecureStorage()
        upgradeLegacySettingsSecrets()
        upgradeLegacyNeteaseSecret()
        loadActiveStageContext()
        recoverInterruptedAgentActions()
        reconcileCarePingOutcomes()
        registerIpc()
        pruneOldData()
        registerScheduler()
        onPlaybackStateChanged(() => rebuildTrayMenu())
        onSceneChanged(() => rebuildTrayMenu())
        warmRootFileCache([
          'prompts/system.md',
          'prompts/agent-soul.md',
          'prompts/yinyi-writer-v5.md',
          'prompts/yinyi-writer-v4.md',
          'prompts/seal-writer.md',
          'prompts/care-ping-recommend.md',
          'prompts/care-ping-voice-invite.md',
          'prompts/care-ping-casual.md',
          'prompts/portrait-writer-v2.md',
          'prompts/portrait-writer.md',
          'prompts/scenario-100.md',
          'samples/artist-genre-seed.json',
        ]).catch((error) => {
          console.warn('[paths] warm root file cache failed', error)
        })
        warmMostRecentSealCache().catch((error) => {
          console.warn('[daySeal] warm cache failed', error)
        })
        runStartupCatchup().catch((error) => {
          const message = error instanceof Error ? error.message : String(error)
          recordSchedulerHealth('catchup', 'degraded', '启动补偿失败。', message)
        })
        createWindow()
        createTray()
      } catch (error) {
        createStartupFailureWindow(error)
      }
    })
    .catch((error) => {
      createStartupFailureWindow(error)
    })
}
