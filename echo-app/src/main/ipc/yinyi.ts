import { ipcMain } from 'electron'
import { generateYinyi, getByDate, getRandom, getRange } from '../services/yinyi'

export function registerYinyiIpc(): void {
  ipcMain.handle('yinyi:generate', (_event, date?: string) => generateYinyi(date))
  ipcMain.handle('yinyi:getByDate', (_event, date: string) => getByDate(date))
  ipcMain.handle('yinyi:getRange', (_event, limit?: number) => getRange(limit))
  ipcMain.handle('yinyi:getRandom', () => getRandom())
}
