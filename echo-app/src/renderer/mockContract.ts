import type { ChatMessage, EchoApi, PlaybackState, RuntimeTaskSnapshot, SceneDefinition, ServiceHealth, Settings, TasteProfile, TasteQuestion, Track } from '../types/ipc'

type ContractShape = {
  [K in keyof EchoApi]: readonly (keyof EchoApi[K])[]
}

export const ECHO_API_CONTRACT: ContractShape = {
  runtime: ['getTask', 'getRecentTasks', 'cancelTask', 'onTaskChanged', 'onEvent'],
  settings: ['get', 'update', 'updateBatch', 'testLlm', 'importPlaylist', 'downloadPlaylistTemplate', 'exportData', 'resetData', 'onChanged'],
  health: ['get', 'check'],
  scheduler: ['runCatchup'],
  chat: ['send', 'loadRecent', 'cancel', 'onChunk', 'onMessageInjected'],
  taste: ['getProfile', 'getMemoryAudit', 'getProfileVersions', 'refreshStructuredProfile', 'regeneratePortrait', 'applySignal', 'respondToInsight', 'restoreProfileVersion', 'correctMemory', 'answerQuestion'],
  yinyi: ['generate', 'getByDate', 'getRange', 'getRandom', 'onGenerated'],
  queue: ['get', 'history', 'clearHistoryDates', 'markStatus'],
  favorites: ['list', 'count', 'listKeys', 'toggle', 'isFavorite', 'onChanged'],
  feedback: ['record'],
  scene: ['definitions', 'getCurrent', 'start', 'play', 'end', 'today', 'onChanged'],
  semantics: ['buildForImportedTracks', 'getSummary'],
  import: ['getSnapshot', 'onChanged', 'onProgress'],
  recommendation: ['recommendFromNetease'],
  playback: ['play', 'enqueue', 'next', 'finishCurrent', 'prev', 'pause', 'resume', 'setVolume', 'getVolume', 'seek', 'removeFromQueue', 'removeTrackFromQueue', 'clearQueue', 'reorderQueue', 'heartbeat', 'refreshUrl', 'getState', 'onStateChanged', 'onUrlRefreshed', 'onCookieExpired'],
  app: ['minimizeToTray', 'quit', 'onCloseRequested', 'onNavigate'],
  window: ['minimize', 'toggleMaximize', 'close'],
  voice: ['generate'],
  tts: ['synthesize', 'test'],
  weather: ['get'],
  listening: ['generateSegment', 'endSession'],
  carePings: ['test', 'muteToday', 'schedule'],
  netease: ['getLoginState', 'createQrLogin', 'checkQrLogin', 'sendCaptcha', 'loginWithCaptcha', 'importCookie', 'logout', 'listPlaylists', 'importPlaylist'],
}

export function assertEchoApiContract(api: EchoApi, label = 'EchoApi'): void {
  const missing: string[] = []
  for (const [sectionName, methods] of Object.entries(ECHO_API_CONTRACT) as Array<[keyof EchoApi, readonly string[]]>) {
    const section = api[sectionName] as Record<string, unknown> | undefined
    if (!section || typeof section !== 'object') {
      missing.push(`${String(sectionName)}.*`)
      continue
    }
    for (const method of methods) {
      if (typeof section[method] !== 'function') missing.push(`${String(sectionName)}.${method}`)
    }
  }
  if (missing.length > 0) {
    throw new Error(`${label} contract mismatch: ${missing.join(', ')}`)
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object'
}

function assertArray(value: unknown, label: string): asserts value is unknown[] {
  if (!Array.isArray(value)) throw new Error(`${label} must be an array`)
}

function assertTrack(value: unknown, label: string): asserts value is Track {
  if (!isRecord(value) || typeof value.title !== 'string' || typeof value.artist !== 'string') {
    throw new Error(`${label} must include title and artist`)
  }
}

function assertMessage(value: unknown, label: string): asserts value is ChatMessage {
  if (!isRecord(value) || typeof value.id !== 'number' || (value.role !== 'user' && value.role !== 'assistant') || typeof value.content !== 'string') {
    throw new Error(`${label} must include id, role and content`)
  }
}

function assertSettings(value: unknown): asserts value is Settings {
  if (!isRecord(value) || !isRecord(value.llm) || typeof value.llm.baseUrl !== 'string' || !isRecord(value.user) || typeof value.user.city !== 'string') {
    throw new Error('settings.get shape mismatch')
  }
}

function assertPlaybackState(value: unknown): asserts value is PlaybackState {
  if (!isRecord(value) || typeof value.status !== 'string' || !Array.isArray(value.queue) || !Array.isArray(value.history)) {
    throw new Error('playback.getState shape mismatch')
  }
  value.queue.forEach((track, index) => assertTrack(track, `playback.queue[${index}]`))
}

function assertRuntimeTask(value: unknown, label: string): asserts value is RuntimeTaskSnapshot {
  if (!isRecord(value) || typeof value.id !== 'string' || typeof value.kind !== 'string' || typeof value.status !== 'string') {
    throw new Error(`${label} must include id, kind and status`)
  }
}

function assertSceneDefinition(value: unknown, label: string): asserts value is SceneDefinition {
  if (!isRecord(value) || typeof value.key !== 'string' || typeof value.label !== 'string' || typeof value.prompt !== 'string') {
    throw new Error(`${label} must include key, label and prompt`)
  }
}

function assertServiceHealth(value: unknown, label: string): asserts value is ServiceHealth {
  if (!isRecord(value) || typeof value.service !== 'string' || typeof value.status !== 'string' || typeof value.message !== 'string') {
    throw new Error(`${label} must include service, status and message`)
  }
}

function assertTasteProfileEnvelope(value: unknown): asserts value is { profile: TasteProfile | null; questions: TasteQuestion[] } {
  if (!isRecord(value) || !(isRecord(value.profile) || value.profile === null) || !Array.isArray(value.questions)) {
    throw new Error('taste.getProfile shape mismatch')
  }
}

function assertTasteProfileValue(value: unknown, label: string): asserts value is TasteProfile | null {
  if (value === null) return
  if (!isRecord(value) || !Array.isArray(value.genres) || !Array.isArray(value.artists) || !Array.isArray(value.moods) || !Array.isArray(value.signature_tracks)) {
    throw new Error(`${label} shape mismatch`)
  }
}

type ReadContractCheck = {
  label: string
  read(api: EchoApi): Promise<unknown>
  validate(value: unknown): void
}

const READ_CONTRACT_CHECKS: ReadContractCheck[] = [
  { label: 'settings.get', read: (api) => api.settings.get(), validate: assertSettings },
  { label: 'playback.getState', read: (api) => api.playback.getState(), validate: assertPlaybackState },
  {
    label: 'queue.get',
    read: (api) => api.queue.get(),
    validate: (value) => {
      assertArray(value, 'queue.get')
      value.forEach((track, index) => assertTrack(track, `queue[${index}]`))
    },
  },
  {
    label: 'chat.loadRecent',
    read: (api) => api.chat.loadRecent(3),
    validate: (value) => {
      assertArray(value, 'chat.loadRecent')
      value.forEach((message, index) => assertMessage(message, `messages[${index}]`))
    },
  },
  { label: 'taste.getProfile', read: (api) => api.taste.getProfile(), validate: assertTasteProfileEnvelope },
  {
    label: 'taste.refreshStructuredProfile',
    read: (api) => api.taste.refreshStructuredProfile(),
    validate: (value) => assertTasteProfileValue(value, 'taste.refreshStructuredProfile'),
  },
  {
    label: 'runtime.getRecentTasks',
    read: (api) => api.runtime.getRecentTasks(),
    validate: (value) => {
      assertArray(value, 'runtime.getRecentTasks')
      value.forEach((task, index) => assertRuntimeTask(task, `runtimeTasks[${index}]`))
    },
  },
  {
    label: 'scene.definitions',
    read: (api) => api.scene.definitions(),
    validate: (value) => {
      assertArray(value, 'scene.definitions')
      value.forEach((scene, index) => assertSceneDefinition(scene, `scenes[${index}]`))
    },
  },
  {
    label: 'health.get',
    read: (api) => api.health.get(),
    validate: (value) => {
      assertArray(value, 'health.get')
      value.forEach((item, index) => assertServiceHealth(item, `health[${index}]`))
    },
  },
  {
    label: 'favorites.count',
    read: (api) => api.favorites.count(),
    validate: (value) => {
      if (typeof value !== 'number') throw new Error('favorites.count must return a number')
    },
  },
  {
    label: 'import.getSnapshot',
    read: (api) => api.import.getSnapshot(),
    validate: (value) => {
      if (value !== null) assertRuntimeTask(value, 'import snapshot')
    },
  },
]

export async function assertEchoApiReadContract(api: EchoApi, label = 'EchoApi'): Promise<void> {
  for (const check of READ_CONTRACT_CHECKS) {
    const value = await check.read(api)
    try {
      check.validate(value)
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      throw new Error(`${label}.${check.label} contract mismatch: ${message}`)
    }
  }
}
