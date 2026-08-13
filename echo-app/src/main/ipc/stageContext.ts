import { ipcMain } from 'electron'
import type { StageContextCorrection } from '../../types/ipc'
import { loadActiveStageContext } from '../domain/stageContext/repository'
import { correctActiveStageContext, endActiveStageContext, removeStageContext } from '../domain/stageContext/service'
import { listRecentAgentActions } from '../db/agentActions'

export function registerStageContextIpc(): void {
  ipcMain.handle('stageContext:getActive', () => loadActiveStageContext())
  ipcMain.handle('stageContext:end', () => endActiveStageContext())
  ipcMain.handle('stageContext:correct', (_event, input: StageContextCorrection) => correctActiveStageContext(input))
  ipcMain.handle('stageContext:delete', (_event, id: string) => {
    removeStageContext(id)
    return { ok: true }
  })
  ipcMain.handle('stageContext:recentActions', (_event, limit?: number) => listRecentAgentActions(limit))
}
