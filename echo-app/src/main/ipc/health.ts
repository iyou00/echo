import { ipcMain } from 'electron'
import { checkServiceHealth, getServiceHealth } from '../services/health'
import { schedulerCatchupAgent } from '../services/schedulerAgents'
import { runAgent } from '../runtime/runtime'

export function registerHealthIpc(): void {
  ipcMain.handle('health:get', () => getServiceHealth())
  ipcMain.handle('health:check', () => checkServiceHealth())
  ipcMain.handle('scheduler:runCatchup', () => runAgent(schedulerCatchupAgent, undefined, {
    phase: 'catchup',
    total: 1,
    uniqueKey: 'scheduler-catchup:manual',
    cancellable: false,
    isFailureResult: (report) => !report.ok,
    messageForResult: (report) => report.primary.message,
  }))
}
