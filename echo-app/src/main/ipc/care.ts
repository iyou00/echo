import { ipcMain } from 'electron'
import type { PingType } from '../../types/ipc'
import { listTodayCarePingPlans } from '../services/scheduler'
import { muteToday, testCarePing } from '../services/carePings'

export function registerCareIpc(): void {
  ipcMain.handle('carePings:test', (_event, type?: PingType) => testCarePing(type))
  ipcMain.handle('carePings:muteToday', () => muteToday())
  ipcMain.handle('carePings:schedule', () => listTodayCarePingPlans())
}
