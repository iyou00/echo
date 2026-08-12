import { ipcRenderer, contextBridge } from 'electron'
import type { EchoApi } from '../src/types/ipc'

const rawInvoke = ipcRenderer.invoke.bind(ipcRenderer)
const DEFAULT_IPC_TIMEOUT_MS = 30_000
const RUNTIME_MANAGED_CHANNELS = new Set([
  'chat:send',
  'settings:importPlaylist',
  'semantics:buildForImportedTracks',
  'recommendation:recommendFromNetease',
  'scene:play',
  'taste:regeneratePortrait',
  'yinyi:generate',
  'voice:generate',
  'listening:generateSegment',
  'netease:importPlaylist',
  'scheduler:runCatchup',
  'carePings:test',
])
const LONG_IPC_TIMEOUTS: Record<string, number> = {
  'settings:exportData': 2 * 60_000,
  'settings:resetData': 2 * 60_000,
}

function invoke<T>(channel: string, ...args: unknown[]): Promise<T> {
  if (RUNTIME_MANAGED_CHANNELS.has(channel)) {
    return rawInvoke(channel, ...args) as Promise<T>
  }
  const timeoutMs = LONG_IPC_TIMEOUTS[channel] ?? DEFAULT_IPC_TIMEOUT_MS
  let timer: ReturnType<typeof setTimeout> | undefined
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`IPC request timed out: ${channel}`)), timeoutMs)
  })
  return Promise.race([rawInvoke(channel, ...args) as Promise<T>, timeout]).finally(() => {
    if (timer) clearTimeout(timer)
  })
}

const echoApi: EchoApi = {
  runtime: {
    getTask: (id) => invoke('runtime:getTask', id),
    getRecentTasks: () => invoke('runtime:getRecentTasks'),
    cancelTask: (id) => invoke('runtime:cancelTask', id),
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
    get: () => invoke('settings:get'),
    update: (path, value) => invoke('settings:update', path, value),
    updateBatch: (updates) => invoke('settings:updateBatch', updates),
    testLlm: () => invoke('settings:testLlm'),
    importPlaylist: () => invoke('settings:importPlaylist'),
    downloadPlaylistTemplate: () => invoke('settings:downloadPlaylistTemplate'),
    exportData: () => invoke('settings:exportData'),
    resetData: () => invoke('settings:resetData'),
    onChanged: (listener) => {
      const wrapped = (_event: Electron.IpcRendererEvent, payload: { path: string; value: unknown }) => listener(payload)
      ipcRenderer.on('settings:changed', wrapped)
      return () => ipcRenderer.off('settings:changed', wrapped)
    },
  },
  health: {
    get: () => invoke('health:get'),
    check: () => invoke('health:check'),
  },
  scheduler: {
    runCatchup: () => invoke('scheduler:runCatchup'),
  },
  chat: {
    send: (text) => invoke('chat:send', text),
    loadRecent: (limit) => invoke('chat:loadRecent', limit),
    cancel: () => invoke('chat:cancel'),
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
    getProfile: () => invoke('taste:getProfile'),
    getMemoryAudit: () => invoke('taste:getMemoryAudit'),
    getProfileVersions: () => invoke('taste:getProfileVersions'),
    refreshStructuredProfile: () => invoke('taste:refreshStructuredProfile'),
    regeneratePortrait: () => invoke('taste:regeneratePortrait'),
    applySignal: (kind, payload) => invoke('taste:applySignal', kind, payload),
    respondToInsight: (insight, action) => invoke('taste:respondToInsight', insight, action),
    restoreProfileVersion: (id) => invoke('taste:restoreProfileVersion', id),
    correctMemory: (note) => invoke('taste:correctMemory', note),
    answerQuestion: (id, answer) => invoke('taste:answerQuestion', id, answer),
  },
  yinyi: {
    generate: (date) => invoke('yinyi:generate', date),
    getByDate: (date) => invoke('yinyi:getByDate', date),
    getRange: (limit) => invoke('yinyi:getRange', limit),
    getRandom: () => invoke('yinyi:getRandom'),
    onGenerated: (listener) => {
      const wrapped = (_event: Electron.IpcRendererEvent, payload: Parameters<typeof listener>[0]) => listener(payload)
      ipcRenderer.on('yinyi:generated', wrapped)
      return () => ipcRenderer.off('yinyi:generated', wrapped)
    },
  },
  queue: {
    get: () => invoke('queue:get'),
    history: (limitDays) => invoke('queue:history', limitDays),
    clearHistoryDates: (dates) => invoke('queue:clearHistoryDates', dates),
    markStatus: (track, status) => invoke('queue:markStatus', track, status),
  },
  favorites: {
    list: (options) => invoke('favorites:list', options),
    count: (query) => invoke('favorites:count', query),
    listKeys: () => invoke('favorites:listKeys'),
    toggle: (track) => invoke('favorites:toggle', track),
    isFavorite: (track) => invoke('favorites:isFavorite', track),
    onChanged: (listener) => {
      const wrapped = (_event: Electron.IpcRendererEvent, payload: Parameters<typeof listener>[0]) => listener(payload)
      ipcRenderer.on('favorites:changed', wrapped)
      return () => ipcRenderer.off('favorites:changed', wrapped)
    },
  },
  feedback: {
    record: (track, action, context) => invoke('feedback:record', track, action, context),
  },
  scene: {
    definitions: () => invoke('scene:definitions'),
    getCurrent: () => invoke('scene:getCurrent'),
    start: (key) => invoke('scene:start', key),
    play: (key, options) => invoke('scene:play', key, options),
    end: () => invoke('scene:end'),
    today: () => invoke('scene:today'),
    onChanged: (listener) => {
      const wrapped = (_event: Electron.IpcRendererEvent, scene: Parameters<typeof listener>[0]) => listener(scene)
      ipcRenderer.on('scene:changed', wrapped)
      return () => ipcRenderer.off('scene:changed', wrapped)
    },
  },
  semantics: {
    buildForImportedTracks: () => invoke('semantics:buildForImportedTracks'),
    getSummary: () => invoke('semantics:getSummary'),
  },
  import: {
    getSnapshot: () => invoke('import:getSnapshot'),
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
    recommendFromNetease: (text) => invoke('recommendation:recommendFromNetease', text),
  },
  playback: {
    play: (track, options) => invoke('playback:play', track, options),
    enqueue: (track) => invoke('playback:enqueue', track),
    next: () => invoke('playback:next'),
    finishCurrent: () => invoke('playback:finishCurrent'),
    prev: () => invoke('playback:prev'),
    pause: () => invoke('playback:pause'),
    resume: () => invoke('playback:resume'),
    setVolume: (percent) => invoke('playback:setVolume', percent),
    getVolume: () => invoke('playback:getVolume'),
    seek: (positionMs) => invoke('playback:seek', positionMs),
    removeFromQueue: (index) => invoke('playback:removeFromQueue', index),
    removeTrackFromQueue: (track) => invoke('playback:removeTrackFromQueue', track),
    clearQueue: () => invoke('playback:clearQueue'),
    reorderQueue: (fromIndex, toIndex) => invoke('playback:reorderQueue', fromIndex, toIndex),
    heartbeat: (state) => invoke('playback:heartbeat', state),
    refreshUrl: (trackId) => invoke('playback:refreshUrl', trackId),
    getState: () => invoke('playback:getState'),
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
    openFeedback: () => invoke('app:openFeedback'),
    minimizeToTray: () => invoke('app:minimizeToTray'),
    quit: () => invoke('app:quit'),
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
    minimize: () => invoke('window:minimize'),
    toggleMaximize: () => invoke('window:toggleMaximize'),
    close: () => invoke('window:close'),
  },
  voice: {
    generate: () => invoke('voice:generate'),
  },
  tts: {
    synthesize: (text) => invoke('tts:synthesize', text),
    test: () => invoke('tts:test'),
  },
  weather: {
    get: (city) => invoke('weather:get', city),
  },
  listening: {
    generateSegment: (options?: { continuation?: boolean; automatic?: boolean }) => invoke('listening:generateSegment', options),
    endSession: (sessionId?: number) => invoke('listening:endSession', sessionId),
  },
  carePings: {
    test: (type) => invoke('carePings:test', type),
    muteToday: () => invoke('carePings:muteToday'),
    schedule: () => invoke('carePings:schedule'),
  },
  netease: {
    getLoginState: () => invoke('netease:getLoginState'),
    createQrLogin: () => invoke('netease:createQrLogin'),
    checkQrLogin: (key) => invoke('netease:checkQrLogin', key),
    sendCaptcha: (phone) => invoke('netease:sendCaptcha', phone),
    loginWithCaptcha: (phone, captcha) => invoke('netease:loginWithCaptcha', phone, captcha),
    importCookie: (cookie) => invoke('netease:importCookie', cookie),
    logout: () => invoke('netease:logout'),
    listPlaylists: () => invoke('netease:listPlaylists'),
    importPlaylist: (id) => invoke('netease:importPlaylist', id),
  },
}

contextBridge.exposeInMainWorld('echo', echoApi)
