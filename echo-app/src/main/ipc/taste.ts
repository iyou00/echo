import { ipcMain } from 'electron'
import { runAgent } from '../runtime/runtime'
import { getMemoryAudit } from '../services/memoryAudit'
import { correctProfileMemory } from '../services/profileCorrection'
import { tastePortraitRefreshAgent } from '../services/schedulerAgents'
import { applySignal, getProfileWithQuestions, refreshStructuredProfile, respondToProfileInsight } from '../services/taste'
import { recordTasteQuestionAnswer } from '../services/tasteQuestionScheduler'
import { getLanguageDistribution } from '../db/semantics'
import { listTasteProfileVersions, restoreTasteProfileVersion } from '../db/taste'

export function registerTasteIpc(): void {
  ipcMain.handle('taste:getProfile', () => {
    if (process.env.ECHO_E2E === '1' && process.env.ECHO_E2E_SCENARIO === 'startup-degraded') {
      throw new Error('forced optional boot failure')
    }
    return getProfileWithQuestions()
  })
  ipcMain.handle('taste:getMemoryAudit', () => getMemoryAudit())
  ipcMain.handle('taste:getProfileVersions', () => listTasteProfileVersions())
  ipcMain.handle('taste:refreshStructuredProfile', () => refreshStructuredProfile('semantic_update'))
  ipcMain.handle('taste:regeneratePortrait', () => runAgent(tastePortraitRefreshAgent, undefined, {
    phase: 'portrait',
    total: 3,
    cancellable: true,
    uniqueKey: 'taste-portrait:manual',
    messageForResult: (profile) => profile?.profile_meta?.portraitRefreshOutcome === 'retained'
      ? '新画像未通过质量检查，已保留原画像。'
      : profile ? '画像文案已刷新。' : '暂无可刷新的画像。',
  }))
  ipcMain.handle('taste:applySignal', (_event, kind: string, payload: Record<string, unknown>) => applySignal(kind, payload))
  ipcMain.handle('taste:respondToInsight', (_event, insight, action) => respondToProfileInsight(insight, action))
  ipcMain.handle('taste:restoreProfileVersion', (_event, id: number) => restoreTasteProfileVersion(id))
  ipcMain.handle('taste:correctMemory', (_event, note: string) => correctProfileMemory(note))
  ipcMain.handle('taste:answerQuestion', (_event, id: number, answer: string) => recordTasteQuestionAnswer(id, answer))
  ipcMain.handle('taste:languageDistribution', () => getLanguageDistribution())
}
