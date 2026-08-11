import { app, BrowserWindow, ipcMain, shell } from 'electron'

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
  ipcMain.handle('window:toggleMaximize', () => {
    const target = BrowserWindow.getFocusedWindow()
    if (!target) return { ok: false }
    if (target.isMaximized()) target.unmaximize()
    else target.maximize()
    return { ok: true, maximized: target.isMaximized() }
  })
  ipcMain.handle('window:close', () => {
    BrowserWindow.getFocusedWindow()?.hide()
    return { ok: true }
  })
}
