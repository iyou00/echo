import { app, BrowserWindow, Menu, nativeImage, Tray } from 'electron'
import { fileURLToPath } from 'node:url'
import path from 'node:path'
import { closeDb } from '../src/main/db'
import { getSettings, upgradeLegacySettingsSecrets } from '../src/main/db/settings'
import { upgradeLegacyNeteaseSecret } from '../src/main/netease/auth'
import { registerIpc } from '../src/main/ipc'
import { registerScheduler, runStartupCatchup, stopScheduler } from '../src/main/services/scheduler'
import { archiveDaySeal } from '../src/main/services/daySeal'
import { checkSecureStorage } from '../src/main/utils/secureStorage'

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

function createTray() {
  if (tray) return
  tray = new Tray(createAppIcon())
  tray.setToolTip('Echo')
  tray.setContextMenu(Menu.buildFromTemplate([
    {
      label: '显示 Echo',
      click: () => {
        win?.show()
        win?.focus()
      },
    },
    {
      label: '退出 Echo',
      click: () => {
        isQuitting = true
        app.quit()
      },
    },
  ]))
  tray.on('click', () => {
    win?.show()
    win?.focus()
  })
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
  runStartupCatchup().catch(() => undefined)
  createWindow()
  createTray()
})
