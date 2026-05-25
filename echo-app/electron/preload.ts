import { ipcRenderer, contextBridge } from 'electron'
import type { EchoApi } from '../src/types/ipc'

const echoApi: EchoApi = {
  runtime: {
    getTask: (id) => ipcRenderer.invoke('runtime:getTask', id),
    getRecentTasks: () => ipcRenderer.invoke('runtime:getRecentTasks'),
    cancelTask: (id) => ipcRenderer.invoke('runtime:cancelTask', id),
    onTaskChanged: (listener) => {
      const wrapped = (_event: Electron.IpcRendererEvent, payload: Parameters<typeof listener>[0]) => listener(payload)
      ipcRenderer.on('runtime:task-changed', wrapped)
      return () => ipcRenderer.off('runtime:task-changed', wrapped)
    },
    onEvent: (listener) => {
      const wrapped = (_event: Electron.IpcRendererEvent, payload: Parameters<typeof listener>[0]) => listener(payload)
      ipcRenderer.on('runtime:event', wrapped)
      return () => ipcRenderer.off('runtime:event', wrapped)
    },
  },
  settings: {
    get: () => ipcRenderer.invoke('settings:get'),
    update: (path, value) => ipcRenderer.invoke('settings:update', path, value),
    testLlm: () => ipcRenderer.invoke('settings:testLlm'),
    importPlaylist: () => ipcRenderer.invoke('settings:importPlaylist'),
    downloadPlaylistTemplate: () => ipcRenderer.invoke('settings:downloadPlaylistTemplate'),
    exportData: () => ipcRenderer.invoke('settings:exportData'),
    resetData: () => ipcRenderer.invoke('settings:resetData'),
    onChanged: (listener) => {
      const wrapped = (_event: Electron.IpcRendererEvent, payload: { path: string; value: unknown }) => listener(payload)
      ipcRenderer.on('settings:changed', wrapped)
      return () => ipcRenderer.off('settings:changed', wrapped)
    },
  },
  health: {
    get: () => ipcRenderer.invoke('health:get'),
    check: () => ipcRenderer.invoke('health:check'),
  },
  scheduler: {
    runCatchup: () => ipcRenderer.invoke('scheduler:runCatchup'),
  },
  chat: {
    send: (text) => ipcRenderer.invoke('chat:send', text),
    loadRecent: (limit) => ipcRenderer.invoke('chat:loadRecent', limit),
    cancel: () => ipcRenderer.invoke('chat:cancel'),
    onChunk: (listener) => {
      const wrapped = (_event: Electron.IpcRendererEvent, chunk: string) => listener(chunk)
      ipcRenderer.on('chat:stream:chunk', wrapped)
      return () => ipcRenderer.off('chat:stream:chunk', wrapped)
    },
    onMessageInjected: (listener) => {
      const wrapped = (_event: Electron.IpcRendererEvent, message: Parameters<typeof listener>[0]) => listener(message)
      ipcRenderer.on('chat:message-injected', wrapped)
      return () => ipcRenderer.off('chat:message-injected', wrapped)
    },
  },
  taste: {
    getProfile: () => ipcRenderer.invoke('taste:getProfile'),
    getMemoryAudit: () => ipcRenderer.invoke('taste:getMemoryAudit'),
    regeneratePortrait: () => ipcRenderer.invoke('taste:regeneratePortrait'),
    applySignal: (kind, payload) => ipcRenderer.invoke('taste:applySignal', kind, payload),
    correctMemory: (note) => ipcRenderer.invoke('taste:correctMemory', note),
    answerQuestion: (id, answer) => ipcRenderer.invoke('taste:answerQuestion', id, answer),
  },
  yinyi: {
    generate: (date) => ipcRenderer.invoke('yinyi:generate', date),
    getByDate: (date) => ipcRenderer.invoke('yinyi:getByDate', date),
    getRange: (limit) => ipcRenderer.invoke('yinyi:getRange', limit),
    getRandom: () => ipcRenderer.invoke('yinyi:getRandom'),
    onGenerated: (listener) => {
      const wrapped = (_event: Electron.IpcRendererEvent, payload: Parameters<typeof listener>[0]) => listener(payload)
      ipcRenderer.on('yinyi:generated', wrapped)
      return () => ipcRenderer.off('yinyi:generated', wrapped)
    },
  },
  queue: {
    get: () => ipcRenderer.invoke('queue:get'),
    history: (limitDays) => ipcRenderer.invoke('queue:history', limitDays),
    clearHistoryDates: (dates) => ipcRenderer.invoke('queue:clearHistoryDates', dates),
    markStatus: (track, status) => ipcRenderer.invoke('queue:markStatus', track, status),
  },
  favorites: {
    list: (options) => ipcRenderer.invoke('favorites:list', options),
    count: (query) => ipcRenderer.invoke('favorites:count', query),
    listKeys: () => ipcRenderer.invoke('favorites:listKeys'),
    toggle: (track) => ipcRenderer.invoke('favorites:toggle', track),
    isFavorite: (track) => ipcRenderer.invoke('favorites:isFavorite', track),
    onChanged: (listener) => {
      const wrapped = (_event: Electron.IpcRendererEvent, payload: Parameters<typeof listener>[0]) => listener(payload)
      ipcRenderer.on('favorites:changed', wrapped)
      return () => ipcRenderer.off('favorites:changed', wrapped)
    },
  },
  feedback: {
    record: (track, action, context) => ipcRenderer.invoke('feedback:record', track, action, context),
  },
  scene: {
    definitions: () => ipcRenderer.invoke('scene:definitions'),
    getCurrent: () => ipcRenderer.invoke('scene:getCurrent'),
    start: (key) => ipcRenderer.invoke('scene:start', key),
    play: (key, options) => ipcRenderer.invoke('scene:play', key, options),
    end: () => ipcRenderer.invoke('scene:end'),
    today: () => ipcRenderer.invoke('scene:today'),
    onChanged: (listener) => {
      const wrapped = (_event: Electron.IpcRendererEvent, scene: Parameters<typeof listener>[0]) => listener(scene)
      ipcRenderer.on('scene:changed', wrapped)
      return () => ipcRenderer.off('scene:changed', wrapped)
    },
  },
  semantics: {
    buildForImportedTracks: () => ipcRenderer.invoke('semantics:buildForImportedTracks'),
    getSummary: () => ipcRenderer.invoke('semantics:getSummary'),
  },
  import: {
    getSnapshot: () => ipcRenderer.invoke('import:getSnapshot'),
    onChanged: (listener) => {
      const wrapped = (_event: Electron.IpcRendererEvent, payload: Parameters<typeof listener>[0]) => listener(payload)
      ipcRenderer.on('import:changed', wrapped)
      return () => ipcRenderer.off('import:changed', wrapped)
    },
    onProgress: (listener) => {
      const wrapped = (_event: Electron.IpcRendererEvent, payload: Parameters<typeof listener>[0]) => listener(payload)
      ipcRenderer.on('import:progress', wrapped)
      return () => ipcRenderer.off('import:progress', wrapped)
    },
  },
  recommendation: {
    recommendFromNetease: (text) => ipcRenderer.invoke('recommendation:recommendFromNetease', text),
  },
  playback: {
    play: (track, options) => ipcRenderer.invoke('playback:play', track, options),
    enqueue: (track) => ipcRenderer.invoke('playback:enqueue', track),
    next: () => ipcRenderer.invoke('playback:next'),
    finishCurrent: () => ipcRenderer.invoke('playback:finishCurrent'),
    prev: () => ipcRenderer.invoke('playback:prev'),
    pause: () => ipcRenderer.invoke('playback:pause'),
    resume: () => ipcRenderer.invoke('playback:resume'),
    setVolume: (percent) => ipcRenderer.invoke('playback:setVolume', percent),
    getVolume: () => ipcRenderer.invoke('playback:getVolume'),
    seek: (positionMs) => ipcRenderer.invoke('playback:seek', positionMs),
    removeFromQueue: (index) => ipcRenderer.invoke('playback:removeFromQueue', index),
    removeTrackFromQueue: (track) => ipcRenderer.invoke('playback:removeTrackFromQueue', track),
    clearQueue: () => ipcRenderer.invoke('playback:clearQueue'),
    reorderQueue: (fromIndex, toIndex) => ipcRenderer.invoke('playback:reorderQueue', fromIndex, toIndex),
    heartbeat: (state) => ipcRenderer.invoke('playback:heartbeat', state),
    refreshUrl: (trackId) => ipcRenderer.invoke('playback:refreshUrl', trackId),
    getState: () => ipcRenderer.invoke('playback:getState'),
    onStateChanged: (listener) => {
      const wrapped = (_event: Electron.IpcRendererEvent, state: Parameters<typeof listener>[0]) => listener(state)
      ipcRenderer.on('playback:state-changed', wrapped)
      return () => ipcRenderer.off('playback:state-changed', wrapped)
    },
    onUrlRefreshed: (listener) => {
      const wrapped = (_event: Electron.IpcRendererEvent, payload: Parameters<typeof listener>[0]) => listener(payload)
      ipcRenderer.on('playback:url-refreshed', wrapped)
      return () => ipcRenderer.off('playback:url-refreshed', wrapped)
    },
    onCookieExpired: (listener) => {
      const wrapped = (_event: Electron.IpcRendererEvent, message: string) => listener(message)
      ipcRenderer.on('netease:cookie-expired', wrapped)
      return () => ipcRenderer.off('netease:cookie-expired', wrapped)
    },
  },
  app: {
    minimizeToTray: () => ipcRenderer.invoke('app:minimizeToTray'),
    quit: () => ipcRenderer.invoke('app:quit'),
    onCloseRequested: (listener) => {
      const wrapped = () => listener()
      ipcRenderer.on('app:close-requested', wrapped)
      return () => ipcRenderer.off('app:close-requested', wrapped)
    },
    onNavigate: (listener) => {
      const wrapped = (_event: Electron.IpcRendererEvent, payload: Parameters<typeof listener>[0]) => listener(payload)
      ipcRenderer.on('app:navigate', wrapped)
      return () => ipcRenderer.off('app:navigate', wrapped)
    },
  },
  window: {
    minimize: () => ipcRenderer.invoke('window:minimize'),
    toggleMaximize: () => ipcRenderer.invoke('window:toggleMaximize'),
    close: () => ipcRenderer.invoke('window:close'),
  },
  voice: {
    generate: () => ipcRenderer.invoke('voice:generate'),
  },
  tts: {
    synthesize: (text) => ipcRenderer.invoke('tts:synthesize', text),
    test: () => ipcRenderer.invoke('tts:test'),
  },
  weather: {
    get: (city) => ipcRenderer.invoke('weather:get', city),
  },
  listening: {
    generateSegment: (options?: { continuation?: boolean }) => ipcRenderer.invoke('listening:generateSegment', options),
  },
  carePings: {
    test: (type) => ipcRenderer.invoke('carePings:test', type),
    muteToday: () => ipcRenderer.invoke('carePings:muteToday'),
    schedule: () => ipcRenderer.invoke('carePings:schedule'),
  },
  netease: {
    getLoginState: () => ipcRenderer.invoke('netease:getLoginState'),
    createQrLogin: () => ipcRenderer.invoke('netease:createQrLogin'),
    checkQrLogin: (key) => ipcRenderer.invoke('netease:checkQrLogin', key),
    logout: () => ipcRenderer.invoke('netease:logout'),
    listPlaylists: () => ipcRenderer.invoke('netease:listPlaylists'),
    importPlaylist: (id) => ipcRenderer.invoke('netease:importPlaylist', id),
  },
}

contextBridge.exposeInMainWorld('echo', echoApi)
