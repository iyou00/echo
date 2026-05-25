import { ipcMain } from 'electron'
import { endCurrentScene, getCurrentScene, listSceneDefinitions, listTodaySceneSessions, onSceneChanged, startScene } from '../services/scene'
import { scenePlaybackAgent } from '../services/scenePlaybackAgent'
import { broadcast } from './shared'
import { cancelTasksByKind, runAgent } from '../runtime/runtime'

let sceneBroadcastRegistered = false

export function registerSceneIpc(): void {
  ipcMain.handle('scene:definitions', () => listSceneDefinitions())
  ipcMain.handle('scene:getCurrent', () => getCurrentScene())
  ipcMain.handle('scene:start', (_event, key) => startScene(key))
  ipcMain.handle('scene:play', (_event, key, options) => runAgent(scenePlaybackAgent, { key, options }, {
    phase: 'recommend',
    total: 4,
    sourceName: String(key),
    cancellable: true,
    uniqueKey: 'scene-playback',
    healthService: 'netease',
    messageForResult: (result) => result.scene.label,
  }))
  ipcMain.handle('scene:end', () => {
    cancelTasksByKind('scene-playback')
    return endCurrentScene()
  })
  ipcMain.handle('scene:today', () => listTodaySceneSessions())

  if (!sceneBroadcastRegistered) {
    onSceneChanged((scene) => broadcast('scene:changed', scene))
    sceneBroadcastRegistered = true
  }
}
