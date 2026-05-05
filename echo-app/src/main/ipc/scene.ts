import { ipcMain } from 'electron'
import { endCurrentScene, getCurrentScene, listSceneDefinitions, listTodaySceneSessions, onSceneChanged, startScene } from '../services/scene'
import { startScenePlayback } from '../services/scenePlayback'
import { broadcast } from './shared'

let sceneBroadcastRegistered = false

export function registerSceneIpc(): void {
  ipcMain.handle('scene:definitions', () => listSceneDefinitions())
  ipcMain.handle('scene:getCurrent', () => getCurrentScene())
  ipcMain.handle('scene:start', (_event, key) => startScene(key))
  ipcMain.handle('scene:play', (_event, key, options) => startScenePlayback(key, options))
  ipcMain.handle('scene:end', () => endCurrentScene())
  ipcMain.handle('scene:today', () => listTodaySceneSessions())

  if (!sceneBroadcastRegistered) {
    onSceneChanged((scene) => broadcast('scene:changed', scene))
    sceneBroadcastRegistered = true
  }
}
