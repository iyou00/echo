import { ipcMain } from 'electron'
import type { PingType } from '../../types/ipc'
import { listTodayCarePingPlans } from '../services/scheduler'
import { muteToday } from '../services/carePings'
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
  ipcMain.handle('carePings:muteToday', () => muteToday())
  ipcMain.handle('carePings:schedule', () => listTodayCarePingPlans())
}
