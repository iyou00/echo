import { BrowserWindow, ipcMain } from 'electron'
import { cancelTask, getRecentTasks, getTask } from '../runtime/runtime'
import { setRuntimeBroadcaster } from '../runtime/eventBus'

function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(channel, payload)
  }
}

export function registerRuntimeIpc(): void {
  setRuntimeBroadcaster(broadcast)
  ipcMain.handle('runtime:getTask', (_event, id: string) => {
    const task = getTask(id)
    return task?.visibility === 'user' ? task : null
  })
  ipcMain.handle('runtime:getRecentTasks', () => getRecentTasks('user'))
  ipcMain.handle('runtime:cancelTask', (_event, id: string) => ({ ok: cancelTask(id) }))
}
