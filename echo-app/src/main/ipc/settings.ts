import { ipcMain } from 'electron'
import { getSettings, importPlaylistFromDialog, testLlm, updateSetting, downloadPlaylistTemplate, exportData, resetAllData } from '../services/settings'
import { StorageUnavailableError } from '../utils/secureStorage'
import { resetPlaybackState } from '../services/playback'
import { rescheduleCarePings, rescheduleYinyi } from '../services/scheduler'
import { getImportTaskSnapshot } from '../services/importTasks'
import { broadcast, maskSettings } from './shared'

export function registerSettingsIpc(): void {
  ipcMain.handle('settings:get', () => maskSettings(getSettings()))
  ipcMain.handle('settings:update', (_event, path: string, value: unknown) => {
    if (path === 'llm.apiKey' && value === '••••••') return maskSettings(getSettings())
    try {
      const settings = updateSetting(path, value)
      if (path.startsWith('yinyi.')) rescheduleYinyi()
      if (path.startsWith('carePings.')) rescheduleCarePings()
      broadcast('settings:changed', { path, value })
      return maskSettings(settings)
    } catch (error) {
      if (error instanceof StorageUnavailableError) {
        throw new Error(error.message)
      }
      throw error
    }
  })
  ipcMain.handle('settings:testLlm', () => testLlm())
  ipcMain.handle('settings:importPlaylist', () => importPlaylistFromDialog())
  ipcMain.handle('import:getSnapshot', () => getImportTaskSnapshot())
  ipcMain.handle('settings:downloadPlaylistTemplate', () => downloadPlaylistTemplate())
  ipcMain.handle('settings:exportData', () => exportData())
  ipcMain.handle('settings:resetData', () => {
    const result = resetAllData()
    resetPlaybackState()
    rescheduleYinyi()
    rescheduleCarePings()
    broadcast('settings:changed', { path: '*', value: null })
    return result
  })
}
