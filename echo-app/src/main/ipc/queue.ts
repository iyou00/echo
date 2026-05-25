import { BrowserWindow, ipcMain } from 'electron'
import { clearQueueHistoryDates, getQueue, getQueueHistory, markQueueStatus } from '../services/queue'
import { countFavorites, isFavorite, listFavoriteKeys, listFavorites, toggleFavorite } from '../services/favorites'
import { recordFeedback } from '../services/feedback'

function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(channel, payload)
  }
}

export function registerQueueIpc(): void {
  ipcMain.handle('queue:get', () => getQueue())
  ipcMain.handle('queue:history', (_event, limitDays?: number) => getQueueHistory(limitDays))
  ipcMain.handle('queue:clearHistoryDates', (_event, dates: string[]) => clearQueueHistoryDates(dates))
  ipcMain.handle('queue:markStatus', (_event, track, status) => markQueueStatus(track, status))
  ipcMain.handle('favorites:list', (_event, options) => listFavorites(options))
  ipcMain.handle('favorites:count', (_event, query?: string) => countFavorites(query))
  ipcMain.handle('favorites:listKeys', () => listFavoriteKeys())
  ipcMain.handle('favorites:toggle', async (_event, track) => {
    const result = await toggleFavorite(track)
    broadcast('favorites:changed', { track, favorited: result.favorited, total: countFavorites() })
    return result
  })
  ipcMain.handle('favorites:isFavorite', (_event, track) => isFavorite(track))
  ipcMain.handle('feedback:record', (_event, track, action, context) => recordFeedback(track, action, context))
}
