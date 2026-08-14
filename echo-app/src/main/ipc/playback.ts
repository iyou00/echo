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
  reportPlaybackError,
  removeFromQueue,
  removeTrackFromQueue,
  reorderQueue,
  resume,
  seek,
  setVolume,
} from '../services/playback'
import { createUiBoundary } from '../../shared/uiBoundary'

export function registerPlaybackIpc(): void {
  ipcMain.handle('playback:play', (_event, track, options) => play(track, options))
  ipcMain.handle('playback:enqueue', (_event, track) => enqueue(track))
  ipcMain.handle('playback:next', (_event, playbackInstanceId?: string) => next({ playbackInstanceId }))
  ipcMain.handle('playback:finishCurrent', (_event, playbackInstanceId?: string) => finishCurrent(playbackInstanceId))
  ipcMain.handle('playback:prev', () => prev())
  ipcMain.handle('playback:pause', () => pause())
  ipcMain.handle('playback:resume', () => resume())
  ipcMain.handle('playback:setVolume', (_event, percent: number) => setVolume(percent))
  ipcMain.handle('playback:getVolume', () => getVolume())
  ipcMain.handle('playback:seek', (_event, positionMs: number) => seek(positionMs))
  ipcMain.handle('playback:removeFromQueue', (_event, index: number) => removeFromQueue(index))
  ipcMain.handle('playback:removeTrackFromQueue', (_event, track) => removeTrackFromQueue(track))
  ipcMain.handle('playback:clearQueue', () => clearQueue())
  ipcMain.handle('playback:reorderQueue', (_event, fromIndex: number, toIndex: number) => reorderQueue(fromIndex, toIndex))
  ipcMain.handle('playback:heartbeat', (_event, state) => heartbeat(state))
  ipcMain.handle('playback:reportError', (_event, playbackInstanceId, failureKind) => reportPlaybackError(playbackInstanceId, failureKind))
  ipcMain.handle('playback:refreshUrl', async (_event, trackId: string) => {
    try {
      const result = await refreshUrl(trackId)
      return { ok: true as const, ...result }
    } catch {
      return {
        ok: false as const,
        state: getPlaybackState(),
        boundary: createUiBoundary('playback_recovering', { sourceId: trackId }),
      }
    }
  })
  ipcMain.handle('playback:getState', () => getPlaybackState())
}
