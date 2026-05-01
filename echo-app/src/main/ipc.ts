import { app, BrowserWindow, ipcMain } from 'electron'
import type { Settings } from '../types/ipc'
import { getSettings, importPlaylistFromDialog, testLlm, updateSetting, downloadPlaylistTemplate, exportData, resetAllData } from './services/settings'
import { StorageUnavailableError } from './utils/secureStorage'
import { cancel, loadRecent, send } from './services/chat'
import { answerQuestion, applySignal, getProfileWithQuestions, regeneratePortrait } from './services/taste'
import { generateYinyi, getByDate, getRandom, getRange } from './services/yinyi'
import { clearQueueHistoryDates, getQueue, getQueueHistory, markQueueStatus } from './services/queue'
import { isFavorite, listFavorites, toggleFavorite } from './services/favorites'
import { recordFeedback } from './services/feedback'
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
  resetPlaybackState,
  resume,
  seek,
  setVolume,
} from './services/playback'
import { listTodayCarePingPlans, rescheduleCarePings, rescheduleYinyi, runStartupCatchup } from './services/scheduler'
import { checkNeteaseQrLogin, createNeteaseQrLogin, getNeteaseLoginState, logoutNetease } from './netease/auth'
import { importNeteasePlaylist, listNeteasePlaylists } from './netease/music'
import { generateVoiceLine } from './services/voice'
import { synthesize, testTts } from './tts/client'
import { getWeather } from './weather/client'
import { generateListeningSegment } from './services/listening'
import { muteToday, testCarePing } from './services/carePings'
import type { PingType } from '../types/ipc'
import { checkServiceHealth, getServiceHealth } from './services/health'
import { buildForImportedTracks, getSummary as getSemanticSummary } from './services/semantics'
import { recommendFromNetease } from './services/recommendation'
import { endCurrentScene, getCurrentScene, listSceneDefinitions, listTodaySceneSessions, startScene } from './services/scene'

function broadcast(channel: string, payload: unknown): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(channel, payload)
  }
}

function maskSettings(settings: Settings): Settings {
  return {
    ...settings,
    llm: {
      ...settings.llm,
      apiKey: settings.llm.apiKey ? '••••••' : '',
    },
  }
}

export function registerIpc(): void {
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
  ipcMain.handle('health:get', () => getServiceHealth())
  ipcMain.handle('health:check', () => checkServiceHealth())
  ipcMain.handle('scheduler:runCatchup', () => runStartupCatchup())

  ipcMain.handle('chat:send', (event, text: string) => send(text, event.sender))
  ipcMain.handle('chat:loadRecent', (_event, limit?: number) => loadRecent(limit))
  ipcMain.handle('chat:cancel', () => cancel())

  ipcMain.handle('taste:getProfile', () => getProfileWithQuestions())
  ipcMain.handle('taste:regeneratePortrait', () => regeneratePortrait())
  ipcMain.handle('taste:applySignal', (_event, kind: string, payload: Record<string, unknown>) => applySignal(kind, payload))
  ipcMain.handle('taste:answerQuestion', (_event, id: number, answer: string) => answerQuestion(id, answer))

  ipcMain.handle('yinyi:generate', (_event, date?: string) => generateYinyi(date))
  ipcMain.handle('yinyi:getByDate', (_event, date: string) => getByDate(date))
  ipcMain.handle('yinyi:getRange', (_event, limit?: number) => getRange(limit))
  ipcMain.handle('yinyi:getRandom', () => getRandom())

  ipcMain.handle('queue:get', () => getQueue())
  ipcMain.handle('queue:history', (_event, limitDays?: number) => getQueueHistory(limitDays))
  ipcMain.handle('queue:clearHistoryDates', (_event, dates: string[]) => clearQueueHistoryDates(dates))
  ipcMain.handle('queue:markStatus', (_event, track, status) => markQueueStatus(track, status))
  ipcMain.handle('favorites:list', () => listFavorites())
  ipcMain.handle('favorites:toggle', (_event, track) => toggleFavorite(track))
  ipcMain.handle('favorites:isFavorite', (_event, track) => isFavorite(track))
  ipcMain.handle('feedback:record', (_event, track, action, context) => recordFeedback(track, action, context))
  ipcMain.handle('scene:definitions', () => listSceneDefinitions())
  ipcMain.handle('scene:getCurrent', () => getCurrentScene())
  ipcMain.handle('scene:start', (_event, key) => startScene(key))
  ipcMain.handle('scene:end', () => endCurrentScene())
  ipcMain.handle('scene:today', () => listTodaySceneSessions())
  ipcMain.handle('semantics:buildForImportedTracks', () => buildForImportedTracks())
  ipcMain.handle('semantics:getSummary', () => getSemanticSummary())
  ipcMain.handle('recommendation:recommendFromNetease', (_event, text: string) => recommendFromNetease(text))

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

  ipcMain.handle('app:minimizeToTray', () => {
    BrowserWindow.getFocusedWindow()?.hide()
    return { ok: true }
  })
  ipcMain.handle('app:quit', () => {
    app.quit()
    return { ok: true }
  })
  ipcMain.handle('window:minimize', () => {
    BrowserWindow.getFocusedWindow()?.minimize()
    return { ok: true }
  })
  ipcMain.handle('window:toggleMaximize', () => {
    const target = BrowserWindow.getFocusedWindow()
    if (!target) return { ok: false }
    if (target.isMaximized()) target.unmaximize()
    else target.maximize()
    return { ok: true, maximized: target.isMaximized() }
  })
  ipcMain.handle('window:close', () => {
    BrowserWindow.getFocusedWindow()?.hide()
    return { ok: true }
  })

  ipcMain.handle('voice:generate', () => generateVoiceLine())
  ipcMain.handle('tts:synthesize', (_event, text: string) => synthesize(text))
  ipcMain.handle('tts:test', () => testTts())
  ipcMain.handle('weather:get', (_event, city?: string) => getWeather(city || getSettings().user.city))
  ipcMain.handle('listening:generateSegment', () => generateListeningSegment())
  ipcMain.handle('carePings:test', (_event, type?: PingType) => testCarePing(type))
  ipcMain.handle('carePings:muteToday', () => muteToday())
  ipcMain.handle('carePings:schedule', () => listTodayCarePingPlans())

  ipcMain.handle('netease:getLoginState', () => getNeteaseLoginState())
  ipcMain.handle('netease:createQrLogin', () => createNeteaseQrLogin())
  ipcMain.handle('netease:checkQrLogin', (_event, key: string) => checkNeteaseQrLogin(key))
  ipcMain.handle('netease:logout', () => logoutNetease())
  ipcMain.handle('netease:listPlaylists', () => listNeteasePlaylists())
  ipcMain.handle('netease:importPlaylist', (_event, id: string) => importNeteasePlaylist(id))
}
