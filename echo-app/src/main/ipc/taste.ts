import { ipcMain } from 'electron'
import { runAgent } from '../runtime/runtime'
import { applyMemorySignal } from '../services/memoryPolicy'
import { getMemoryAudit } from '../services/memoryAudit'
import { correctProfileMemory } from '../services/profileCorrection'
import { tastePortraitRefreshAgent } from '../services/schedulerAgents'
import { answerQuestion, applySignal, getProfileWithQuestions } from '../services/taste'

export function registerTasteIpc(): void {
  ipcMain.handle('taste:getProfile', () => getProfileWithQuestions())
  ipcMain.handle('taste:getMemoryAudit', () => getMemoryAudit())
  ipcMain.handle('taste:regeneratePortrait', () => runAgent(tastePortraitRefreshAgent, undefined, {
    phase: 'portrait',
    total: 2,
    cancellable: true,
    uniqueKey: 'taste-portrait:manual',
    messageForResult: (profile) => profile ? '画像文案已刷新。' : '暂无可刷新的画像。',
  }))
  ipcMain.handle('taste:applySignal', (_event, kind: string, payload: Record<string, unknown>) => applySignal(kind, payload))
  ipcMain.handle('taste:correctMemory', (_event, note: string) => correctProfileMemory(note))
  ipcMain.handle('taste:answerQuestion', async (_event, id: number, answer: string) => {
    const result = await answerQuestion(id, answer)
    await applyMemorySignal('correct_assumption', { target: answer, strength: 0.2, note: `taste_question:${id}` }, {
      source: 'taste_question',
      refreshReason: 'taste_question',
    })
    return result
  })
}
