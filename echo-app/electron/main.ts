import { app, BrowserWindow, Menu, nativeImage, Notification, Tray } from 'electron'
import type { MenuItemConstructorOptions } from 'electron'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import type { AppNavigatePayload, AppPageKey, SceneKey } from '../src/types/ipc'
import { closeDb } from '../src/main/db'
import { getSettings, upgradeLegacySettingsSecrets } from '../src/main/db/settings'
import { upgradeLegacyNeteaseSecret } from '../src/main/netease/auth'
import { registerIpc } from '../src/main/ipc'
import { registerScheduler, runStartupCatchup, stopScheduler } from '../src/main/services/scheduler'
import { archiveDaySeal } from '../src/main/services/daySeal'
import { checkSecureStorage } from '../src/main/utils/secureStorage'
import { getState as getPlaybackState, onPlaybackStateChanged, pause, resume } from '../src/main/services/playback'
import { getCurrentScene, listSceneDefinitions, onSceneChanged } from '../src/main/services/scene'
import { NeteaseAuthRequiredError } from '../src/main/services/recommendation'
import { startScenePlayback } from '../src/main/services/scenePlayback'

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

if (process.platform === 'win32') {
  app.setAppUserModelId('local.echo.app')
}

let win: BrowserWindow | null
let isQuitting = false
let cleanupStarted = false
let tray: Tray | null = null
let traySceneRunning: SceneKey | null = null

const TRAY_SCENE_KEYS: SceneKey[] = ['work', 'focus', 'sleepy', 'relax', 'rain', 'irritated']

function createAppIcon() {
  const publicDir = process.env.VITE_PUBLIC ?? path.join(process.env.APP_ROOT ?? process.cwd(), 'public')
  const iconPath = path.join(publicDir, 'brand', 'icon.ico')
  const icon = nativeImage.createFromPath(iconPath)
  if (!icon.isEmpty()) return icon
  return nativeImage.createFromDataURL(
    'data:image/svg+xml;utf8,' +
      encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="64" height="64"><rect width="64" height="64" rx="14" fill="#639922"/><text x="32" y="41" text-anchor="middle" font-family="Georgia,serif" font-size="34" fill="white">E</text></svg>'),
  )
}

function createWindow() {
  win = new BrowserWindow({
    title: 'Echo',
    width: 440,
    height: 720,
    minWidth: 380,
    minHeight: 600,
    frame: false,
    titleBarStyle: 'hidden',
    trafficLightPosition: { x: -100, y: -100 },
    transparent: false,
    resizable: true,
    maximizable: true,
    autoHideMenuBar: true,
    center: true,
    backgroundColor: '#F5FAED',
    icon: createAppIcon(),
    webPreferences: {
      preload: path.join(__dirname, 'preload.mjs'),
      backgroundThrottling: false,
    },
  })

  win.on('close', (event) => {
    if (isQuitting) return
    event.preventDefault()
    const settings = getSettings()
    if (settings.ui.closeBehavior === 'minimize') {
      win?.hide()
      return
    }

    win?.show()
    win?.webContents.send('app:close-requested')
  })

  if (VITE_DEV_SERVER_URL) {
    win.loadURL(VITE_DEV_SERVER_URL)
  } else {
    // win.loadFile('dist/index.html')
    win.loadFile(path.join(RENDERER_DIST, 'index.html'))
  }
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
  if (error instanceof Error && error.message.trim()) return error.message
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
  await archiveDaySeal().catch(() => undefined)
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

app.on('before-quit', async (event) => {
  if (cleanupStarted) return
  event.preventDefault()
  cleanupStarted = true
  isQuitting = true
  await archiveDaySeal().catch(() => undefined)
  stopScheduler()
  closeDb()
  app.exit(0)
})

app.whenReady().then(() => {
  Menu.setApplicationMenu(null)
  checkSecureStorage()
  upgradeLegacySettingsSecrets()
  upgradeLegacyNeteaseSecret()
  registerIpc()
  registerScheduler()
  onPlaybackStateChanged(() => rebuildTrayMenu())
  onSceneChanged(() => rebuildTrayMenu())
  runStartupCatchup().catch(() => undefined)
  createWindow()
  createTray()
})
