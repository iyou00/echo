import { ipcMain } from 'electron'
import { buildForImportedTracks, getSummary as getSemanticSummary } from '../services/semantics'
import { recommendFromNetease } from '../services/recommendation'

export function registerRecommendationIpc(): void {
  ipcMain.handle('semantics:buildForImportedTracks', () => buildForImportedTracks())
  ipcMain.handle('semantics:getSummary', () => getSemanticSummary())
  ipcMain.handle('recommendation:recommendFromNetease', (_event, text: string) => recommendFromNetease(text))
}
