import { ipcMain } from 'electron'
import { answerQuestion, applySignal, getProfileWithQuestions, regeneratePortrait } from '../services/taste'

export function registerTasteIpc(): void {
  ipcMain.handle('taste:getProfile', () => getProfileWithQuestions())
  ipcMain.handle('taste:regeneratePortrait', () => regeneratePortrait())
  ipcMain.handle('taste:applySignal', (_event, kind: string, payload: Record<string, unknown>) => applySignal(kind, payload))
  ipcMain.handle('taste:answerQuestion', (_event, id: number, answer: string) => answerQuestion(id, answer))
}
