import { ipcMain } from 'electron'
import type { PingType } from '../../types/ipc'
import { listTodayCarePingPlans } from '../services/scheduler'
import { muteToday, pauseCarePings } from '../services/carePings'
import { carePingTestAgent } from '../services/schedulerAgents'
import { runAgent } from '../runtime/runtime'

export function registerCareIpc(): void {
  ipcMain.handle('carePings:test', (_event, type?: PingType) => runAgent(carePingTestAgent, { type }, {
    phase: 'generate',
    total: 1,
    cancellable: false,
    isFailureResult: (result) => !result.ok,
    messageForResult: (result) => result.message,
  }))
  ipcMain.handle('carePings:muteToday', (_event, carePingId?: number) => muteToday(carePingId))
  ipcMain.handle('carePings:pause', (_event, mode: 'today' | 'week' | 'resume') => pauseCarePings(mode))
  ipcMain.handle('carePings:schedule', () => listTodayCarePingPlans())
}
