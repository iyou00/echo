import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { isWindowSizePreset, windowSizeForPreset } from '../../shared/windowSize'

const FEEDBACK_URL = 'https://wj.qq.com/s2/26976706/2fcf/'

export function registerAppWindowIpc(): void {
  ipcMain.handle('app:openFeedback', async () => {
    await shell.openExternal(FEEDBACK_URL)
    return { ok: true }
  })
  ipcMain.handle('app:minimizeToTray', () => {
    BrowserWindow.getFocusedWindow()?.hide()
    return { ok: true }
  })
  ipcMain.handle('app:quit', () => {
    app.quit()
    return { ok: true }
  })
  ipcMain.handle('window:minimize', () => {
    BrowserWindow.getFocusedWindow()?.minimize()
    return { ok: true }
  })
  ipcMain.handle('window:setSizePreset', (_event, preset: unknown) => {
    const target = BrowserWindow.getFocusedWindow()
    if (!target) throw new Error('当前没有可调整的 Echo 窗口')
    if (!isWindowSizePreset(preset)) throw new Error('窗口尺寸档位无效')
    const size = windowSizeForPreset(preset)
    target.setSize(size.width, size.height, true)
    target.center()
    return { ok: true, preset, ...size }
  })
  ipcMain.handle('window:close', () => {
    BrowserWindow.getFocusedWindow()?.hide()
    return { ok: true }
  })
}
