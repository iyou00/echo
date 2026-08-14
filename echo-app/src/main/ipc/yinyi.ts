import { ipcMain } from 'electron'
import { getByDate, getRandom, getRange } from '../services/yinyi'
import { yinyiGenerateAgent } from '../services/schedulerAgents'
import { runAgent } from '../runtime/runtime'
import type { YinyiEntry } from '../../types/ipc'
import { createUiBoundary } from '../../shared/uiBoundary'

function withBoundary(entry: YinyiEntry | null): YinyiEntry | null {
  if (!entry) return null
  if (entry.meta?.status === 'failed') return { ...entry, boundary: createUiBoundary('yinyi_failed', { sourceId: entry.date }) }
  if (entry.meta?.status === 'absent') return { ...entry, boundary: createUiBoundary('yinyi_empty', { sourceId: entry.date }) }
  return entry
}

export function registerYinyiIpc(): void {
  ipcMain.handle('yinyi:generate', async (_event, date?: string) => withBoundary(await runAgent(yinyiGenerateAgent, { date }, {
    phase: 'generate',
    total: 1,
    cancellable: false,
    isFailureResult: (entry) => entry.meta?.status === 'failed',
    messageForResult: (entry) => entry.meta?.status === 'failed'
      ? '风信生成失败。'
      : entry.meta?.status === 'absent'
        ? '今天还没有足够内容写风信。'
        : '风信已生成。',
  })))
  ipcMain.handle('yinyi:getByDate', (_event, date: string) => withBoundary(getByDate(date)))
  ipcMain.handle('yinyi:getRange', (_event, limit?: number) => getRange(limit).map((entry) => withBoundary(entry) as YinyiEntry))
  ipcMain.handle('yinyi:getRandom', () => withBoundary(getRandom()))
}
