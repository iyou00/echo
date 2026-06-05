import { ipcMain } from 'electron'
import { runAgent } from '../runtime/runtime'
import { getMemoryAudit } from '../services/memoryAudit'
import { correctProfileMemory } from '../services/profileCorrection'
import { tastePortraitRefreshAgent } from '../services/schedulerAgents'
import { applySignal, getProfileWithQuestions } from '../services/taste'
import { recordTasteQuestionAnswer } from '../services/tasteQuestionScheduler'

export function registerTasteIpc(): void {
  ipcMain.handle('taste:getProfile', () => getProfileWithQuestions())
  ipcMain.handle('taste:getMemoryAudit', () => getMemoryAudit())
  ipcMain.handle('taste:regeneratePortrait', () => runAgent(tastePortraitRefreshAgent, undefined, {
    phase: 'portrait',
    total: 3,
    cancellable: true,
    uniqueKey: 'taste-portrait:manual',
    messageForResult: (profile) => profile ? '画像文案已刷新。' : '暂无可刷新的画像。',
  }))
  ipcMain.handle('taste:applySignal', (_event, kind: string, payload: Record<string, unknown>) => applySignal(kind, payload))
  ipcMain.handle('taste:correctMemory', (_event, note: string) => correctProfileMemory(note))
  ipcMain.handle('taste:answerQuestion', (_event, id: number, answer: string) => recordTasteQuestionAnswer(id, answer))
}
