import { ipcMain } from 'electron'
import { listLearnedCases, setLearnedCaseStatus } from '../db/learnedCases'

export function registerLearnedCasesIpc(): void {
  ipcMain.handle('learnedCases:list', () => listLearnedCases(['active', 'pending', 'retired']))
  ipcMain.handle('learnedCases:delete', (_event, id: string) => {
    setLearnedCaseStatus(id, 'deleted')
    return { ok: true }
  })
}
