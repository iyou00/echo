import { ipcMain } from 'electron'
import { getAllImportedTracks } from '../db/playlists'
import { buildSemanticsForTracks, getSummary as getSemanticSummary } from '../services/semantics'
import { recommendationAgent } from '../services/recommendation/agent'
import { runAgent, runTask } from '../runtime/runtime'

export function registerRecommendationIpc(): void {
  ipcMain.handle('semantics:buildForImportedTracks', () => runTask({
    kind: 'semantic-analysis',
    phase: 'semantics',
    total: 1,
    cancellable: false,
  }, async (context) => {
    const result = await buildSemanticsForTracks(getAllImportedTracks(), (payload) => {
      context.report({ phase: payload.phase, current: payload.current, total: payload.total })
    }, { signal: context.signal })
    context.report({ phase: 'done', current: 1, total: 1, message: `新增语义标签 ${result.tagged} 首` })
    return result
  }))
  ipcMain.handle('semantics:getSummary', () => getSemanticSummary())
  ipcMain.handle('recommendation:recommendFromNetease', (_event, text: string) => runAgent(recommendationAgent, { text }, {
    phase: 'recommend',
    total: 1,
    cancellable: true,
    healthService: 'netease',
    messageForResult: (tracks) => `推荐 ${tracks.length} 首`,
  }))
}
