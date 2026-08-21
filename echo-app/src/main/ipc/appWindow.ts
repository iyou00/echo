import { app, BrowserWindow, ipcMain, shell } from 'electron'
import { isWindowSizePreset, windowSizeForPreset } from '../../shared/windowSize'

const FEEDBACK_URL = 'https://wj.qq.com/s2/26976706/2fcf/'

export function registerAppWindowIpc(): void {
  ipcMain.handle('app:openFeedback', async () => {
    await shell.openExternal(FEEDBACK_URL)
    return { ok: true }
  })
  ipcMain.handle('app:minimizeToTray', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.hide()
    return { ok: true }
  })
  ipcMain.handle('app:quit', () => {
    app.quit()
    return { ok: true }
  })
  ipcMain.handle('window:minimize', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.minimize()
    return { ok: true }
  })
  ipcMain.handle('window:setSizePreset', (event, preset: unknown) => {
    const target = BrowserWindow.fromWebContents(event.sender)
    if (!target) throw new Error('当前没有可调整的 Echo 窗口')
    if (!isWindowSizePreset(preset)) throw new Error('窗口尺寸档位无效')
    const size = windowSizeForPreset(preset)
    // Windows 上 resizable:false 的窗口连续 setSize 会失效（首次生效，之后被系统钉死），
    // 调整前临时解锁、调整完锁回；animate 关掉避免连续切换时与动画竞态。
    target.setResizable(true)
    target.setSize(size.width, size.height, false)
    target.center()
    target.setResizable(false)
    return { ok: true, preset, ...size }
  })
  ipcMain.handle('window:close', (event) => {
    BrowserWindow.fromWebContents(event.sender)?.close()
    return { ok: true }
  })
}
