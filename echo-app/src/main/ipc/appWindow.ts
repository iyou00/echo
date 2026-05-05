import { app, BrowserWindow, ipcMain } from 'electron'

export function registerAppWindowIpc(): void {
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
