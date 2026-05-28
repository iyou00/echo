import { ipcMain } from 'electron'
import { getSettings, importPlaylistFromDialog, testLlm, updateSetting, updateSettingsBatch, downloadPlaylistTemplate, exportData, resetAllData, type SettingUpdatePatch } from '../services/settings'
import { StorageUnavailableError } from '../utils/secureStorage'
import { resetPlaybackState } from '../services/playback'
import { rescheduleCarePings, rescheduleYinyi } from '../services/scheduler'
import { getImportTaskSnapshot } from '../services/importTasks'
import { broadcast, maskSettings } from './shared'

function applySettingsSideEffects(paths: string[]): void {
  if (paths.some((path) => path.startsWith('yinyi.'))) rescheduleYinyi()
  if (paths.some((path) => path.startsWith('carePings.'))) rescheduleCarePings()
}

export function registerSettingsIpc(): void {
  ipcMain.handle('settings:get', () => maskSettings(getSettings()))
  ipcMain.handle('settings:update', (_event, path: string, value: unknown) => {
    if (path === 'llm.apiKey' && value === '••••••') return maskSettings(getSettings())
    try {
      const settings = updateSetting(path, value)
      applySettingsSideEffects([path])
      broadcast('settings:changed', { path, value })
      return maskSettings(settings)
    } catch (error) {
      if (error instanceof StorageUnavailableError) {
        throw new Error(error.message)
      }
      throw error
    }
  })
  ipcMain.handle('settings:updateBatch', (_event, updates: SettingUpdatePatch[]) => {
    try {
      const items = Array.isArray(updates) ? updates : []
      const settings = updateSettingsBatch(items)
      const paths = items.map((item) => item.path)
      applySettingsSideEffects(paths)
      broadcast('settings:changed', { path: 'settings.batch', value: { paths } })
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
