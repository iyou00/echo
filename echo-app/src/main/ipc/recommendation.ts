import { ipcMain } from 'electron'
import { buildForImportedTracks, getSummary as getSemanticSummary } from '../services/semantics'
import { recommendationAgent } from '../services/recommendation/agent'
import { runAgent } from '../runtime/runtime'

export function registerRecommendationIpc(): void {
  ipcMain.handle('semantics:buildForImportedTracks', () => buildForImportedTracks())
  ipcMain.handle('semantics:getSummary', () => getSemanticSummary())
  ipcMain.handle('recommendation:recommendFromNetease', (_event, text: string) => runAgent(recommendationAgent, { text }, {
    phase: 'recommend',
    total: 1,
    cancellable: true,
    healthService: 'netease',
    messageForResult: (tracks) => `推荐 ${tracks.length} 首`,
  }))
}
