import { ipcMain } from 'electron'
import { getByDate, getRandom, getRange } from '../services/yinyi'
import { yinyiGenerateAgent } from '../services/schedulerAgents'
import { runAgent } from '../runtime/runtime'

export function registerYinyiIpc(): void {
  ipcMain.handle('yinyi:generate', (_event, date?: string) => runAgent(yinyiGenerateAgent, { date }, {
    phase: 'generate',
    total: 1,
    cancellable: false,
    isFailureResult: (entry) => entry.meta?.status === 'failed',
    messageForResult: (entry) => entry.meta?.status === 'failed'
      ? '风信生成失败。'
      : entry.meta?.status === 'absent'
        ? '今天还没有足够内容写风信。'
        : '风信已生成。',
  }))
  ipcMain.handle('yinyi:getByDate', (_event, date: string) => getByDate(date))
  ipcMain.handle('yinyi:getRange', (_event, limit?: number) => getRange(limit))
  ipcMain.handle('yinyi:getRandom', () => getRandom())
}
