import { ipcMain } from 'electron'
import {
  clearQueue,
  enqueue,
  finishCurrent,
  getState as getPlaybackState,
  getVolume,
  heartbeat,
  next,
  pause,
  play,
  prev,
  refreshUrl,
  removeFromQueue,
  reorderQueue,
  resume,
  seek,
  setVolume,
} from '../services/playback'

export function registerPlaybackIpc(): void {
  ipcMain.handle('playback:play', (_event, track, options) => play(track, options))
  ipcMain.handle('playback:enqueue', (_event, track) => enqueue(track))
  ipcMain.handle('playback:next', () => next())
  ipcMain.handle('playback:finishCurrent', () => finishCurrent())
  ipcMain.handle('playback:prev', () => prev())
  ipcMain.handle('playback:pause', () => pause())
  ipcMain.handle('playback:resume', () => resume())
  ipcMain.handle('playback:setVolume', (_event, percent: number) => setVolume(percent))
  ipcMain.handle('playback:getVolume', () => getVolume())
  ipcMain.handle('playback:seek', (_event, positionMs: number) => seek(positionMs))
  ipcMain.handle('playback:removeFromQueue', (_event, index: number) => removeFromQueue(index))
  ipcMain.handle('playback:clearQueue', () => clearQueue())
  ipcMain.handle('playback:reorderQueue', (_event, fromIndex: number, toIndex: number) => reorderQueue(fromIndex, toIndex))
  ipcMain.handle('playback:heartbeat', (_event, state) => heartbeat(state))
  ipcMain.handle('playback:refreshUrl', (_event, trackId: string) => refreshUrl(trackId))
  ipcMain.handle('playback:getState', () => getPlaybackState())
}
