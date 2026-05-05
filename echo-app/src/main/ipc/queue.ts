import { ipcMain } from 'electron'
import { clearQueueHistoryDates, getQueue, getQueueHistory, markQueueStatus } from '../services/queue'
import { isFavorite, listFavorites, toggleFavorite } from '../services/favorites'
import { recordFeedback } from '../services/feedback'

export function registerQueueIpc(): void {
  ipcMain.handle('queue:get', () => getQueue())
  ipcMain.handle('queue:history', (_event, limitDays?: number) => getQueueHistory(limitDays))
  ipcMain.handle('queue:clearHistoryDates', (_event, dates: string[]) => clearQueueHistoryDates(dates))
  ipcMain.handle('queue:markStatus', (_event, track, status) => markQueueStatus(track, status))
  ipcMain.handle('favorites:list', () => listFavorites())
  ipcMain.handle('favorites:toggle', (_event, track) => toggleFavorite(track))
  ipcMain.handle('favorites:isFavorite', (_event, track) => isFavorite(track))
  ipcMain.handle('feedback:record', (_event, track, action, context) => recordFeedback(track, action, context))
}
