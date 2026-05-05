import { ipcMain } from 'electron'
import { runStartupCatchup } from '../services/scheduler'
import { checkServiceHealth, getServiceHealth } from '../services/health'

export function registerHealthIpc(): void {
  ipcMain.handle('health:get', () => getServiceHealth())
  ipcMain.handle('health:check', () => checkServiceHealth())
  ipcMain.handle('scheduler:runCatchup', () => runStartupCatchup())
}
