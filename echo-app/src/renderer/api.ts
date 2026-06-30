import { RUNTIME_TASK_RECENT_LIMIT } from '../types/ipc'
import type {
  ChatMessage,
  EchoApi,
  ImportPlaylistResult,
  LlmTestResult,
  NeteaseLoginState,
  PlaybackHeartbeat,
  PlaybackState,
  QueueHistoryDay,
  NeteasePlaylistSummary,
  NeteaseQrCheckResult,
  NeteaseQrLogin,
  ActiveScene,
  SceneDefinition,
  SceneKey,
  SendChatResult,
  ServiceHealth,
  Settings,
  TasteProfile,
  TasteQuestion,
  Track,
  YinyiEntry,
  ImportTaskSnapshot,
  MemoryAuditSummary,
  RuntimeEvent,
  RuntimeTaskSnapshot,
} from '../types/ipc'
import { chineseDayPeriodLabel } from '../shared/dayPeriod'
import { trackIdentity } from '../shared/trackIdentity'
import { assertEchoApiContract, assertEchoApiReadContract } from './mockContract'

const now = new Date().toISOString()

const mockTracks: Track[] = [
  { id: 'mock-1', title: '向云端', artist: '海洋Bo', album: '向云端', year: 2023, reason: '让眼皮轻一点' },
  { id: 'mock-2', title: '不为谁而作的歌', artist: '林俊杰', album: '和自己对话', year: 2015, reason: '回家路上的第一首' },
  { id: 'mock-3', title: 'How Long', artist: 'Charlie Puth', album: 'Voicenotes', year: 2017, reason: '晚上工作时的节奏底' },
  { id: 'mock-4', title: '普通人生', artist: '海洋Bo', album: '普通人生', year: 2023, reason: '续上治愈说唱的气口' },
  { id: 'mock-5', title: 'Ghost', artist: 'Justin Bieber', album: 'Justice', year: 2021, reason: '你最近悄悄接受的那种软' },
  { id: 'mock-6', title: '我怀念的', artist: '孙燕姿', album: '逆光', year: 2007, reason: '慢一点，让你别紧绷' },
  { id: 'mock-7', title: '骄傲的少年', artist: '南征北战NZBZ', album: '骄傲的少年', year: 2018, reason: '需要一点电的时候总在' },
]

const mockScenes: SceneDefinition[] = [
  { key: 'focus', label: '静下来', shortLabel: '静下来', line: '少一点存在感,让节奏稳定铺着。', prompt: '想静一会儿,帮我找几首不抢注意力的歌。', targetCount: 5, moods: ['松弛', '陪伴'], scenes: ['独处', '下午工作'], energy: 'low', tempo: 'slow', familiarity: 'safe' },
  { key: 'sleepy', label: '有点困', shortLabel: '有点困', line: '把精神提一下，节奏别太冲。', prompt: '有点犯困,帮我找几首提神但别太炸的歌。', targetCount: 5, moods: ['清醒', '轻快'], scenes: ['下午工作'], energy: 'high', tempo: 'medium', familiarity: 'balanced' },
  { key: 'relax', label: '松口气', shortLabel: '松口气', line: '工作间隙缓一下,别把情绪拽太深。', prompt: '想松口气,帮我找几首轻一点的歌。', targetCount: 5, moods: ['松弛', '治愈'], scenes: ['独处'], energy: 'low', tempo: 'slow', familiarity: 'safe' },
  { key: 'irritated', label: '有点烦', shortLabel: '有点烦', line: '先降噪,让脑子别继续被推着走。', prompt: '有点烦,帮我找几首能让脑子安静下来的歌。', targetCount: 5, moods: ['松弛', '治愈'], scenes: ['独处'], energy: 'low', tempo: 'slow', familiarity: 'safe' },
  { key: 'random', label: '随便吧', shortLabel: '随便吧', line: '交给 Echo 发散,从你的口味里随手捞。', prompt: '随便听点什么,从我的口味里捞几首就好。', targetCount: 5, moods: ['陪伴'], scenes: ['下午工作'], energy: 'medium', tempo: 'medium', familiarity: 'explore' },
]

const mockSettings: Settings = {
  llm: {
    baseUrl: '',
    apiKey: '',
    model: '',
  },
  yinyi: {
    generateAt: '22:00',
    openWithRandom: false,
  },
  carePings: {
    enabled: false,
    frequency: 'normal',
    detectFullscreen: true,
  },
  chat: {
    restoreOnStart: true,
  },
  playback: {
    autoPlayNext: true,
  },
  ui: {
    theme: 'system',
    closeBehavior: 'ask',
  },
  window: {
    closeHintShown: false,
  },
  user: {
    city: '',
  },
  tts: {
    baseUrl: 'https://tts.wangwangit.com',
    voice: 'zh-CN-XiaochenNeural',
    speed: 1.0,
    pitch: '0',
  },
  meta: {
    schemaVersion: 1,
    firstUsedAt: now,
    onboardingStep: 'api',
  },
}

const mockProfile: TasteProfile = {
  genres: [
    { name: '华语流行', weight: 78, trend: 'steady' },
    { name: '治愈说唱', weight: 65, trend: 'up' },
    { name: 'Pop / R&B', weight: 58, trend: 'up' },
    { name: 'K-pop', weight: 42, trend: 'steady' },
  ],
  artists: [
    { name: '林俊杰', affinity: 95, notes: '今年听了 87 次' },
    { name: '海洋Bo', affinity: 88, notes: '《向云端》几乎每周来一遍' },
    { name: 'Charlie Puth', affinity: 80, notes: '晚上工作时的默认' },
    { name: 'Justin Bieber', affinity: 72, notes: '最近接受度变高' },
    { name: '南征北战NZBZ', affinity: 58, notes: '低频但每次出现都对' },
  ],
  moods: [
    { tag: '回家路上', frequency: 88, signature_artists: ['林俊杰', '海洋Bo'] },
    { tag: '晚上工作', frequency: 74, signature_artists: ['Charlie Puth'] },
    { tag: '需要一点劲', frequency: 52, signature_artists: ['南征北战NZBZ'] },
    { tag: '放松发呆', frequency: 46, signature_artists: ['海洋Bo'] },
    { tag: '失眠', frequency: 39, signature_artists: ['林俊杰'] },
  ],
  discovery_appetite: 62,
  anti_patterns: ['编曲过密的电子音墙', '廉价苦情副歌', '开场过硬的金属质感'],
  signature_tracks: mockTracks,
  echo_portrait:
    '你喜欢旋律性强、情感直白的东西。林俊杰和海洋Bo 是你这周的两个轴心，他们完全不像，却都在你这里。最近 Charlie Puth 的接受度变高了，我看你晚上常放。',
}

const mockQuestions: TasteQuestion[] = [
  { id: 1, kind: 'genre', content: '你说喜欢 K-pop，具体是哪几个组合？BLACKPINK、TWICE，还是别的？', status: 'pending' },
  { id: 2, kind: 'artist', content: '陈默之和银河快递我还不太熟，你会怎么形容他们？', status: 'pending' },
  { id: 3, kind: 'change', content: 'Justin Bieber 你以前说软，最近却听了很多。这个变化从哪首开始？', status: 'pending' },
]

let settingsState: Settings = structuredClone(mockSettings)
let neteaseState: NeteaseLoginState = { loggedIn: false, message: '浏览器预览未登录' }
const neteasePlaylists: NeteasePlaylistSummary[] = [
  { id: 'mock-pl-1', name: '我喜欢的音乐', trackCount: 328, creator: 'Echo 预览用户' },
  { id: 'mock-pl-2', name: '夜里工作', trackCount: 86, creator: 'Echo 预览用户' },
]
let healthState: ServiceHealth[] = [
  { service: 'llm', status: 'unknown', message: '模型状态还没检查。' },
  { service: 'netease', status: 'degraded', message: '网易云登录可能过期了。重新登录后我再拿播放链接。', checkedAt: now },
  { service: 'tts', status: 'degraded', message: '浏览器预览不合成语音。', checkedAt: now },
  { service: 'weather', status: 'degraded', message: '还没设置城市。我会跳过天气开场。', checkedAt: now },
  { service: 'scheduler', status: 'ok', message: '定时任务运行正常。', checkedAt: now },
  { service: 'storage', status: 'ok', message: '本地存储正常。', checkedAt: now },
]
let profileState: TasteProfile | null = structuredClone(mockProfile)
let questionState: TasteQuestion[] = structuredClone(mockQuestions)
let correctionState: string[] = []
let queueState: Track[] = structuredClone(mockTracks)
let favoriteState: Track[] = []
const favoriteListeners = new Set<(payload: { track: Track; favorited: boolean; total: number }) => void>()
let activeSceneState: ActiveScene | null = null
let sceneSessions: ActiveScene[] = []
const playbackState: PlaybackState = {
  current: null,
  position: 0,
  duration: 0,
  status: 'idle',
  volume: 100,
  queue: structuredClone(mockTracks),
  history: [],
}
let messageId = 100
let messages: ChatMessage[] = [
  {
    id: 1,
    role: 'assistant',
    content: '14:22 了，你这个点该犯困了吧。给你挑一首慢慢飘起来的。',
    createdAt: now,
    tracks: [mockTracks[0]],
  },
  {
    id: 2,
    role: 'user',
    content: '嗯听过了，挺合适。再来两首类似的？',
    createdAt: now,
  },
  {
    id: 3,
    role: 'assistant',
    content: '好，先放林俊杰和 Charlie Puth。一首华语一首欧美，情绪连得上。',
    createdAt: now,
    tracks: [mockTracks[1], mockTracks[2]],
  },
]
let chunkListeners: Array<(chunk: string) => void> = []
let injectedMessageListeners: Array<(message: ChatMessage) => void> = []
let yinyiGeneratedListeners: Array<(payload: { date: string; status: string }) => void> = []
let playbackListeners: Array<(state: PlaybackState) => void> = []
let urlRefreshListeners: Array<(payload: { trackId: string; url: string; expiresAt: string }) => void> = []
let cookieExpiredListeners: Array<(message: string) => void> = []
let closeRequestListeners: Array<() => void> = []
let navigateListeners: Array<Parameters<EchoApi['app']['onNavigate']>[0]> = []
let importTaskState: ImportTaskSnapshot | null = null
const settingsChangedListeners = new Set<(payload: { path: string; value: unknown }) => void>()
let importTaskListeners: Array<(snapshot: ImportTaskSnapshot | null) => void> = []
let runtimeTaskListeners: Array<(snapshot: RuntimeTaskSnapshot) => void> = []
let runtimeEventListeners: Array<(event: RuntimeEvent) => void> = []
const runtimeTasks: RuntimeTaskSnapshot[] = []
let runtimeTaskSequence = 0

function wait(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
}

function emitMockRuntimeTask(task: RuntimeTaskSnapshot) {
  if (task.visibility !== 'user') return
  const next = structuredClone(task)
  runtimeTaskListeners.forEach((listener) => listener(next))
}

function rememberMockRuntimeTask(task: RuntimeTaskSnapshot) {
  const index = runtimeTasks.findIndex((item) => item.id === task.id)
  if (index >= 0) runtimeTasks.splice(index, 1)
  runtimeTasks.unshift(task)
  const sameVisibility = runtimeTasks
    .map((item, itemIndex) => ({ item, itemIndex }))
    .filter(({ item }) => item.visibility === task.visibility)
  for (const overflow of sameVisibility.slice(RUNTIME_TASK_RECENT_LIMIT).reverse()) {
    runtimeTasks.splice(overflow.itemIndex, 1)
  }
  emitMockRuntimeTask(task)
}

function startMockRuntimeTask(input: {
  kind: string
  parentTaskId?: string
  phase?: string
  total?: number
  message?: string
  sourceName?: string
  cancellable?: boolean
  visibility?: RuntimeTaskSnapshot['visibility']
}): RuntimeTaskSnapshot {
  const startedAt = new Date().toISOString()
  const task: RuntimeTaskSnapshot = {
    id: `mock-runtime-${Date.now()}-${++runtimeTaskSequence}`,
    parentTaskId: input.parentTaskId,
    kind: input.kind,
    status: 'running',
    phase: input.phase ?? 'preparing',
    current: 0,
    total: input.total ?? 1,
    startedAt,
    updatedAt: startedAt,
    sourceName: input.sourceName,
    message: input.message,
    cancellable: input.cancellable ?? true,
    visibility: input.visibility ?? 'user',
  }
  rememberMockRuntimeTask(task)
  return task
}

function updateMockRuntimeTask(task: RuntimeTaskSnapshot, patch: Partial<RuntimeTaskSnapshot>) {
  if (task.status !== 'running') return
  Object.assign(task, patch, {
    id: task.id,
    kind: task.kind,
    updatedAt: new Date().toISOString(),
  })
  rememberMockRuntimeTask(task)
}

function finishMockRuntimeTask(task: RuntimeTaskSnapshot, status: RuntimeTaskSnapshot['status'], patch: Partial<RuntimeTaskSnapshot> = {}) {
  if (task.status !== 'running') return
  Object.assign(task, patch, {
    id: task.id,
    kind: task.kind,
    status,
    updatedAt: new Date().toISOString(),
    finishedAt: new Date().toISOString(),
  })
  rememberMockRuntimeTask(task)
}

function assertMockRuntimeTaskActive(task: RuntimeTaskSnapshot) {
  if (task.status === 'canceled') throw new DOMException('任务已取消', 'AbortError')
}

async function runMockRuntimeTask<T>(
  input: Parameters<typeof startMockRuntimeTask>[0],
  runner: (task: RuntimeTaskSnapshot) => Promise<T>,
): Promise<T> {
  const task = startMockRuntimeTask(input)
  try {
    const result = await runner(task)
    assertMockRuntimeTaskActive(task)
    finishMockRuntimeTask(task, 'succeeded', {
      phase: 'done',
      current: task.total,
      message: task.message ?? '任务已完成。',
    })
    return result
  } catch (error) {
    if (task.status === 'canceled') throw error
    finishMockRuntimeTask(task, 'failed', {
      error: error instanceof Error ? error.message : '任务失败',
      errorKind: error instanceof DOMException && error.name === 'AbortError' ? 'canceled' : 'unknown',
    })
    throw error
  }
}

function setNestedSetting(path: string, value: unknown): Settings {
  const next = structuredClone(settingsState)
  const keys = path.split('.')
  let target: Record<string, unknown> = next as unknown as Record<string, unknown>
  keys.slice(0, -1).forEach((key) => {
    const child = target[key]
    if (typeof child !== 'object' || child === null) target[key] = {}
    target = target[key] as Record<string, unknown>
  })
  target[keys[keys.length - 1]] = value
  settingsState = next
  return structuredClone(settingsState)
}

function todayIso(offset = 0) {
  const d = new Date()
  d.setDate(d.getDate() + offset)
  const year = d.getFullYear()
  const month = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function mockTrackKey(track?: Track | null) {
  return trackIdentity(track)
}

function mockIsFavorite(track: Track) {
  return favoriteState.some((item) => mockTrackKey(item) === mockTrackKey(track))
}

function emitFavoriteChanged(track: Track, favorited: boolean) {
  const payload = { track: structuredClone(track), favorited, total: favoriteState.length }
  favoriteListeners.forEach((listener) => listener(structuredClone(payload)))
}

const sceneListeners = new Set<(scene: ActiveScene | null) => void>()

function emitScene() {
  const next = structuredClone(activeSceneState?.status === 'active' ? activeSceneState : null)
  sceneListeners.forEach((listener) => listener(next))
}

function mockSceneSuperseded(scene: ActiveScene) {
  return sceneSessions.some((item) => item.id > scene.id && new Date(item.startedAt).getTime() >= new Date(scene.startedAt).getTime())
}

function mockSceneDefinition(key: SceneKey) {
  const scene = mockScenes.find((item) => item.key === key)
  if (!scene) throw new Error('未知场景')
  return scene
}

const MOCK_SCENE_TEMPLATES: Record<string, (title: string) => string> = {
  focus: (t) => `好，我把声音放低一点。先听《${t}》，后面几首也排好了。`,
  sleepy: (t) => `给你提一点精神。先听《${t}》，节奏别太冲。`,
  relax: (t) => `松口气。先听《${t}》，慢慢来。`,
  irritated: (t) => `先把外面的声音降下来。先听《${t}》，让脑子缓一缓。`,
  random: (t) => `随便来一首？先听《${t}》，后面看心情。`,
}

function mockSceneMessage(key: string, title: string): string {
  return (MOCK_SCENE_TEMPLATES[key] ?? ((t) => `好，先听《${t}》，后面几首也排好了。`))(title)
}

function emitPlayback() {
  const next = structuredClone(playbackState)
  playbackListeners.forEach((listener) => listener(next))
  return next
}

function setMockImportTask(snapshot: ImportTaskSnapshot | null) {
  importTaskState = snapshot ? structuredClone(snapshot) : null
  if (snapshot) {
    const runtimeSnapshot: RuntimeTaskSnapshot = {
      ...snapshot,
      kind: snapshot.kind === 'playlist-file' ? 'playlist-import' : snapshot.kind === 'netease-playlist' ? 'netease-playlist-import' : snapshot.kind,
      status: snapshot.status === 'interrupted' ? 'canceled' : snapshot.status,
      cancellable: false,
      visibility: 'user',
    }
    rememberMockRuntimeTask(runtimeSnapshot)
  }
  const next = importTaskState ? structuredClone(importTaskState) : null
  importTaskListeners.forEach((listener) => listener(next))
}

const yinyiEntries: YinyiEntry[] = [
  {
    id: 1,
    date: todayIso(0),
    style: 'daily',
    content:
      '今天 19 点你回到家，第一件事是放林俊杰那首《不为谁而作的歌》。前奏一响，你就跟着哼。\n\n后来《向云端》接上来，房间明显慢了半拍。你今天需要的其实是一个缓冲区，让白天的速度从身上退下去。\n\n我把这天记下来，因为你的重复播放里，有一种很诚实的疲惫。',
    meta: { tracks: [mockTracks[1], mockTracks[0], mockTracks[2]], status: 'ok' },
    createdAt: now,
  },
  {
    id: 2,
    date: todayIso(-1),
    style: 'daily',
    content:
      '昨晚你没有急着找新歌，只是在几首旧歌之间来回。旧歌像熟悉的灯，不亮得夸张，但够你看清房间。\n\n《How Long》出现得刚好。它把工作时的机械感切成小块，让你能继续坐一会。',
    meta: { tracks: [mockTracks[2], mockTracks[4]], status: 'ok' },
    createdAt: now,
  },
]

const mockEcho: EchoApi = {
  runtime: {
    async getTask(id) {
      return structuredClone(runtimeTasks.find((task) => task.id === id && task.visibility === 'user') ?? null)
    },
    async getRecentTasks() {
      return structuredClone(runtimeTasks.filter((task) => task.visibility === 'user').slice(0, RUNTIME_TASK_RECENT_LIMIT))
    },
    async cancelTask(id) {
      const task = runtimeTasks.find((item) => item.id === id)
      if (!task || task.status !== 'running' || !task.cancellable) return { ok: false }
      finishMockRuntimeTask(task, 'canceled', { errorKind: 'canceled', message: '任务已取消' })
      return { ok: true }
    },
    onTaskChanged(listener) {
      runtimeTaskListeners.push(listener)
      return () => {
        runtimeTaskListeners = runtimeTaskListeners.filter((item) => item !== listener)
      }
    },
    onEvent(listener) {
      runtimeEventListeners.push(listener)
      return () => {
        runtimeEventListeners = runtimeEventListeners.filter((item) => item !== listener)
      }
    },
  },
  settings: {
    async get() {
      return structuredClone(settingsState)
    },
    async update(path, value) {
      const result = setNestedSetting(path, value)
      settingsChangedListeners.forEach((listener) => listener({ path, value }))
      return result
    },
    async updateBatch(updates) {
      for (const item of updates) {
        setNestedSetting(item.path, item.value)
      }
      const paths = updates.map((item) => item.path)
      settingsChangedListeners.forEach((listener) => listener({ path: 'settings.batch', value: { paths } }))
      return structuredClone(settingsState)
    },
    async testLlm(): Promise<LlmTestResult> {
      await wait(320)
      const ok = Boolean(settingsState.llm.baseUrl && settingsState.llm.apiKey && settingsState.llm.model)
      return {
        ok,
        latencyMs: ok ? 187 : undefined,
        message: ok ? '浏览器预览已模拟通过；真实 API 请在 Electron 窗口测试' : '先填写 endpoint、key 和 model',
      }
    },
    async importPlaylist(): Promise<ImportPlaylistResult> {
      const startedAt = new Date().toISOString()
      setMockImportTask({
        id: `mock-${Date.now()}`,
        kind: 'playlist-file',
        status: 'running',
        phase: 'semantics',
        current: 0,
        total: mockTracks.length,
        startedAt,
        updatedAt: startedAt,
        sourceName: 'Echo mock playlist',
      })
      await wait(240)
      setMockImportTask({
        id: importTaskState?.id ?? `mock-${Date.now()}`,
        kind: 'playlist-file',
        status: 'succeeded',
        phase: 'done',
        current: 1,
        total: 1,
        startedAt,
        updatedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        sourceName: 'Echo mock playlist',
        message: 'Echo mock playlist 导入完成',
      })
      profileState = structuredClone(mockProfile)
      queueState = structuredClone(mockTracks)
      return { imported: true, count: mockTracks.length, name: 'Echo mock playlist', profile: structuredClone(mockProfile), message: `已导入 ${mockTracks.length} 首` }
    },
    async downloadPlaylistTemplate() {
      return { ok: true, path: 'mock://echo-playlist-template.json', message: '模板已保存' }
    },
    async exportData() {
      return { ok: true, path: 'mock://echo-export.json', message: '已准备导出包' }
    },
    async resetData() {
      settingsState = structuredClone(mockSettings)
      profileState = null
      questionState = []
      queueState = []
      favoriteState = []
      activeSceneState = null
      sceneSessions = []
      messages = []
      runtimeTasks.length = 0
      playbackState.current = null
      playbackState.position = 0
      playbackState.duration = 0
      playbackState.status = 'idle'
      playbackState.volume = 100
      playbackState.queue = []
      playbackState.history = []
      playbackState.error = undefined
      healthState = [
        { service: 'llm', status: 'unknown', message: '模型状态还没检查。' },
        { service: 'netease', status: 'unknown', message: '网易云状态还没检查。' },
        { service: 'tts', status: 'unknown', message: '语音状态还没检查。' },
        { service: 'weather', status: 'unknown', message: '天气状态还没检查。' },
        { service: 'scheduler', status: 'unknown', message: '定时任务状态还没检查。' },
        { service: 'storage', status: 'ok', message: '本地存储正常。' },
      ]
      setMockImportTask(null)
      emitPlayback()
      settingsChangedListeners.forEach((listener) => listener({ path: '*', value: null }))
      return { ok: true }
    },
    onChanged(listener) {
      settingsChangedListeners.add(listener)
      return () => settingsChangedListeners.delete(listener)
    },
  },
  health: {
    async get() {
      return structuredClone(healthState)
    },
    async check() {
      const checkedAt = new Date().toISOString()
      healthState = [
        {
          service: 'llm',
          status: settingsState.llm.baseUrl && settingsState.llm.apiKey && settingsState.llm.model ? 'ok' : 'degraded',
          message: settingsState.llm.baseUrl && settingsState.llm.apiKey && settingsState.llm.model ? '模型连接正常。' : 'Echo 还没连上模型。去设置里填好 API key。',
          checkedAt,
        },
        {
          service: 'netease',
          status: neteaseState.loggedIn ? 'ok' : 'degraded',
          message: neteaseState.loggedIn ? `网易云已登录：${neteaseState.nickname ?? '网易云用户'}` : '网易云登录可能过期了。重新登录后我再拿播放链接。',
          checkedAt,
        },
        { service: 'tts', status: 'degraded', message: '浏览器预览不合成语音。', checkedAt },
        {
          service: 'weather',
          status: settingsState.user.city ? 'ok' : 'degraded',
          message: settingsState.user.city ? '天气可用：晴 · 25°C' : '还没设置城市。我会跳过天气开场。',
          checkedAt,
        },
        { service: 'scheduler', status: 'ok', message: '定时任务运行正常。', checkedAt },
        { service: 'storage', status: 'ok', message: '本地存储正常。', checkedAt },
      ]
      return structuredClone(healthState)
    },
  },
  scheduler: {
    async runCatchup() {
      return runMockRuntimeTask({ kind: 'scheduler-catchup', phase: 'catchup', total: 1, message: '执行启动补偿任务' }, async (task) => {
        await wait(180)
        assertMockRuntimeTaskActive(task)
        const primary = { ok: true, job: 'yinyi_daily' as const, date: todayIso(), status: 'skipped' as const, message: '这一天已经有音忆了。' }
        updateMockRuntimeTask(task, { phase: 'done', current: 1, message: primary.message })
        return { ok: true, primary, results: [primary] }
      })
    },
  },
  chat: {
    async send(text: string): Promise<SendChatResult> {
      return runMockRuntimeTask({ kind: 'chat-send', phase: 'input', total: 4, sourceName: text.slice(0, 64), message: '理解你的消息' }, async (task) => {
        const user: ChatMessage = { id: ++messageId, role: 'user', content: text, createdAt: new Date().toISOString() }
        messages.push(user)
        updateMockRuntimeTask(task, { phase: 'recommendation', current: 1, message: '挑选合适的歌曲' })
        await wait(160)
        assertMockRuntimeTaskActive(task)
        const picked = mockTracks.slice(0, text.includes('慢') || text.includes('类似') ? 3 : 1)
        const content = picked.length > 1 ? '给你接三首慢一点的。第一首先降速，后两首把情绪铺开。' : '我先给你放这首。它的入口轻，适合现在。'
        updateMockRuntimeTask(task, { phase: 'stream', current: 2, message: '生成回复' })
        for (const chunk of content.match(/.{1,8}/g) ?? [content]) {
          await wait(80)
          assertMockRuntimeTaskActive(task)
          chunkListeners.forEach((listener) => listener(chunk))
        }
        updateMockRuntimeTask(task, { phase: 'persist', current: 3, message: '保存对话' })
        const assistant: ChatMessage = {
          id: ++messageId,
          role: 'assistant',
          content,
          createdAt: new Date().toISOString(),
          tracks: picked,
        }
        messages.push(assistant)
        queueState = picked.concat(queueState.filter((track) => !picked.some((item) => item.title === track.title)))
        updateMockRuntimeTask(task, { phase: 'done', current: 4, message: '回复已生成。' })
        return { message: assistant, tracks: picked }
      })
    },
    async loadRecent(limit = 30) {
      return structuredClone(messages.slice(-limit))
    },
    async cancel() {
      const task = runtimeTasks.find((item) => item.kind === 'chat-send' && item.status === 'running' && item.cancellable)
      if (task) finishMockRuntimeTask(task, 'canceled', { errorKind: 'canceled', message: '任务已取消' })
      return { ok: true }
    },
    onChunk(listener) {
      chunkListeners.push(listener)
      return () => {
        chunkListeners = chunkListeners.filter((item) => item !== listener)
      }
    },
    onMessageInjected(listener) {
      injectedMessageListeners.push(listener)
      return () => {
        injectedMessageListeners = injectedMessageListeners.filter((item) => item !== listener)
      }
    },
  },
  taste: {
    async getProfile() {
      return { profile: structuredClone(profileState), questions: structuredClone(questionState) }
    },
    async getMemoryAudit() {
      const audit: MemoryAuditSummary = {
        updatedAt: new Date().toISOString(),
        counts: {
          corrections: correctionState.length,
          favorites: favoriteState.length,
          explicitLikes: 1,
          explicitMisses: 1,
          loops: 1,
          repeatedSkips: 1,
        },
        items: [
          ...correctionState.map((content, index) => ({
            id: `mock-correction-${index}`,
            kind: 'correction' as const,
            label: '纠正',
            title: content,
            createdAt: new Date(Date.now() - index * 60000).toISOString(),
          })),
          {
            id: 'mock-favorite-1',
            kind: 'favorite' as const,
            label: '收藏',
            title: `《${mockTracks[0].title}》`,
            detail: mockTracks[0].artist,
            createdAt: now,
            track: structuredClone(mockTracks[0]),
          },
          {
            id: 'mock-loop-1',
            kind: 'loop' as const,
            label: '循环',
            title: `《${mockTracks[2].title}》`,
            detail: `2 次 · ${mockTracks[2].artist}`,
            createdAt: now,
            track: structuredClone(mockTracks[2]),
          },
          {
            id: 'mock-miss-1',
            kind: 'explicit_miss' as const,
            label: '不合适',
            title: `《${mockTracks[3].title}》`,
            detail: '这次方向偏了',
            createdAt: now,
            track: structuredClone(mockTracks[3]),
          },
        ].slice(0, 8),
      }
      return structuredClone(audit)
    },
    async refreshStructuredProfile() {
      profileState = {
        ...(profileState ?? structuredClone(mockProfile)),
        profile_meta: {
          ...((profileState ?? mockProfile).profile_meta ?? {}),
          structuredUpdatedAt: new Date().toISOString(),
          refreshReason: 'semantic_update',
        },
      }
      return structuredClone(profileState)
    },
    async regeneratePortrait() {
      return runMockRuntimeTask({ kind: 'taste-refresh', phase: 'structured-profile', total: 2, message: '' }, async (task) => {
        await wait(220)
        assertMockRuntimeTaskActive(task)
        updateMockRuntimeTask(task, { phase: 'portrait', current: 1, message: '' })
        await wait(260)
        assertMockRuntimeTaskActive(task)
        profileState = structuredClone(mockProfile)
        updateMockRuntimeTask(task, { phase: 'done', current: 2, message: '已刷新。' })
        return structuredClone(profileState)
      })
    },
    async applySignal() {
      return structuredClone(profileState)
    },
    async correctMemory(note) {
      const content = note.trim()
      if (!content) return { ok: false, message: '先写一句你想纠正的地方。' }
      profileState = {
        ...(profileState ?? structuredClone(mockProfile)),
        echo_portrait: `${profileState?.echo_portrait ?? mockProfile.echo_portrait}\n修正:${content}`,
      }
      correctionState = [content, ...correctionState].slice(0, 6)
      return { ok: true, message: '我记下了，下次画像会按这个修正。' }
    },
    async answerQuestion(id, answer) {
      questionState = questionState.map((question) =>
        question.id === id ? { ...question, status: 'answered', answered_content: answer } : question,
      )
      return { ok: true }
    },
  },
  yinyi: {
    async generate(date = todayIso()) {
      return runMockRuntimeTask({ kind: 'yinyi-generate', phase: 'generate', total: 1, message: '生成风信' }, async (task) => {
        await wait(320)
        assertMockRuntimeTaskActive(task)
        const entry: YinyiEntry = {
          id: Date.now(),
          date,
          style: 'manual',
          content:
            '今天这篇是你手动叫我写的。\n\n我看见你在几首歌之间找一个合适的速度。歌单里没有大动作，只有你一点一点把注意力收回来。\n\n这也算今天的线索。',
          meta: { tracks: queueState.slice(0, 3), status: 'ok' },
          createdAt: new Date().toISOString(),
        }
        yinyiEntries.unshift(entry)
        yinyiGeneratedListeners.forEach((listener) => listener({ date: entry.date, status: entry.meta?.status ?? 'ok' }))
        updateMockRuntimeTask(task, { phase: 'done', current: 1, message: '风信已生成。' })
        return structuredClone(entry)
      })
    },
    async getByDate(date) {
      return structuredClone(yinyiEntries.find((entry) => entry.date === date) ?? null)
    },
    async getRange(limit = 30) {
      return structuredClone(yinyiEntries.slice(0, limit))
    },
    async getRandom() {
      return structuredClone(yinyiEntries[Math.floor(Math.random() * yinyiEntries.length)] ?? null)
    },
    onGenerated(listener) {
      yinyiGeneratedListeners.push(listener)
      return () => {
        yinyiGeneratedListeners = yinyiGeneratedListeners.filter((item) => item !== listener)
      }
    },
  },
  queue: {
    async get() {
      return structuredClone(queueState)
    },
    async history(): Promise<QueueHistoryDay[]> {
      return [
        { date: todayIso(0), tracks: structuredClone(queueState) },
        { date: todayIso(-1), tracks: structuredClone(mockTracks.slice(1, 4).map((track) => ({ ...track, queueStatus: 'completed' as const }))) },
      ]
    },
    async clearHistoryDates() {
      return []
    },
    async markStatus(track, status) {
      queueState = queueState.map((item) => (
        `${item.id ?? ''}:${item.title}:${item.artist}` === `${track.id ?? ''}:${track.title}:${track.artist}`
          ? { ...item, queueStatus: status }
          : item.queueStatus === 'playing' && status === 'playing'
            ? { ...item, queueStatus: 'skipped' }
            : item
      ))
      return structuredClone(queueState)
    },
  },
  favorites: {
    async list(options) {
      const query = options?.query?.trim().toLowerCase()
      const offset = Math.max(0, Math.floor(options?.offset ?? 0))
      const limit = Math.max(1, Math.min(200, Math.floor(options?.limit ?? 200)))
      const filtered = query
        ? favoriteState.filter((track) => `${track.title} ${track.artist} ${track.album ?? ''}`.toLowerCase().includes(query))
        : favoriteState
      return structuredClone(filtered.slice(offset, offset + limit).map((track) => ({ ...track, favorited: true })))
    },
    async count(query) {
      const normalized = query?.trim().toLowerCase()
      if (!normalized) return favoriteState.length
      return favoriteState.filter((track) => `${track.title} ${track.artist} ${track.album ?? ''}`.toLowerCase().includes(normalized)).length
    },
    async listKeys() {
      return structuredClone(favoriteState.map(mockTrackKey))
    },
    async toggle(track) {
      const key = mockTrackKey(track)
      const exists = favoriteState.some((item) => mockTrackKey(item) === key)
      favoriteState = exists
        ? favoriteState.filter((item) => mockTrackKey(item) !== key)
        : [{ ...track, favorited: true }, ...favoriteState]
      emitFavoriteChanged(track, !exists)
      return { favorited: !exists, favorites: structuredClone(favoriteState.slice(0, 200)) }
    },
    async isFavorite(track) {
      return mockIsFavorite(track)
    },
    onChanged(listener) {
      favoriteListeners.add(listener)
      return () => favoriteListeners.delete(listener)
    },
  },
  feedback: {
    async record(track, action, context) {
      correctionState = [`[${action}] ${track.title} - ${track.artist}${context ? ` (${context})` : ''}`, ...correctionState].slice(0, 20)
      return { ok: true, message: `已记录"${action}"对${track.title}的反馈。` }
    },
  },
  scene: {
    async definitions() {
      return structuredClone(mockScenes)
    },
    async getCurrent() {
      if (activeSceneState && new Date(activeSceneState.expiresAt).getTime() <= Date.now()) {
        activeSceneState = { ...activeSceneState, status: 'expired', endedAt: activeSceneState.expiresAt }
      }
      return structuredClone(activeSceneState?.status === 'active' ? activeSceneState : null)
    },
    async start(key) {
      if (activeSceneState?.status === 'active') {
        activeSceneState = { ...activeSceneState, status: 'ended', endedAt: new Date().toISOString() }
      }
      const definition = mockSceneDefinition(key)
      const nowAt = new Date().toISOString()
      const scene: ActiveScene = {
        ...definition,
        id: Date.now(),
        startedAt: nowAt,
        expiresAt: new Date(Date.now() + 2 * 60 * 60 * 1000).toISOString(),
        status: 'active',
      }
      activeSceneState = scene
      sceneSessions.unshift(scene)
      emitScene()
      return structuredClone(scene)
    },
    async play(key, options) {
      return runMockRuntimeTask({ kind: 'scene-playback', phase: 'recommend', total: 4, sourceName: key, message: '准备场景歌曲' }, async (task) => {
        const scene = options?.continueSession && activeSceneState?.status === 'active' && activeSceneState.key === key
          ? activeSceneState
          : await this.start(key)
        await wait(180)
        assertMockRuntimeTaskActive(task)
        const targetCount = Math.max(1, Math.min(scene.targetCount, options?.targetCount ?? scene.targetCount))
        const tracks = structuredClone(mockTracks.slice(0, targetCount).map((track) => ({
          ...track,
          playUrl: track.playUrl ?? 'mock://audio',
          sceneKey: scene.key,
          sceneLabel: scene.label,
          sceneLine: scene.line,
          sceneSessionId: scene.id,
          queueStatus: 'pending' as const,
        })))
        if (mockSceneSuperseded(scene)) return { scene, tracks: [], state: structuredClone(playbackState) }
        updateMockRuntimeTask(task, { phase: 'queue', current: 2, message: `准备 ${tracks.length} 首场景歌曲` })
        if (tracks.length > 0) {
          const [first, ...rest] = tracks
          playbackState.current = { ...first, queueStatus: 'playing' }
          playbackState.position = 0
          playbackState.duration = first.durationMs ?? 180000
          playbackState.status = 'loading'
          playbackState.queue = rest
          queueState = [{ ...first, queueStatus: 'playing' }, ...rest]
          emitPlayback()
        }
        await wait(120)
        assertMockRuntimeTaskActive(task)
        if (mockSceneSuperseded(scene)) return { scene, tracks: [], state: structuredClone(playbackState) }
        updateMockRuntimeTask(task, { phase: 'chat-line', current: 4, message: scene.label })
        const message = options?.appendChatMessage
          ? {
            id: ++messageId,
            role: 'assistant' as const,
            content: tracks[0] ? mockSceneMessage(scene.key, tracks[0].title) : `好，我先帮你找几首${scene.label}的。`,
            createdAt: new Date().toISOString(),
            tracks,
          }
          : undefined
        if (message) {
          messages.push(message)
          injectedMessageListeners.forEach((listener) => listener(structuredClone(message)))
        }
        return { scene, tracks, state: structuredClone(playbackState), message }
      })
    },
    async end() {
      if (!activeSceneState || activeSceneState.status !== 'active') return null
      activeSceneState = { ...activeSceneState, status: 'ended', endedAt: new Date().toISOString() }
      emitScene()
      return structuredClone(activeSceneState)
    },
    async today() {
      return sceneSessions.map((scene) => ({
        id: scene.id,
        key: scene.key,
        label: scene.label,
        startedAt: scene.startedAt,
        endedAt: scene.endedAt,
        expiresAt: scene.expiresAt,
        status: scene.status,
        durationMinutes: Math.max(0, Math.round((new Date(scene.endedAt ?? scene.expiresAt).getTime() - new Date(scene.startedAt).getTime()) / 60000)),
      }))
    },
    onChanged(listener) {
      sceneListeners.add(listener)
      return () => sceneListeners.delete(listener)
    },
  },
  semantics: {
    async buildForImportedTracks() {
      return { tagged: mockTracks.length, skipped: 0 }
    },
    async getSummary() {
      return { moods: structuredClone(mockProfile.moods), total: mockTracks.length }
    },
  },
  import: {
    async getSnapshot() {
      return importTaskState ? structuredClone(importTaskState) : null
    },
    onChanged(listener) {
      importTaskListeners.push(listener)
      return () => {
        importTaskListeners = importTaskListeners.filter((item) => item !== listener)
      }
    },
    onProgress() {
      return () => undefined
    },
  },
  recommendation: {
    async recommendFromNetease(text: string) {
      return structuredClone(mockTracks.slice(0, text.includes('慢') || text.includes('类似') ? 3 : 1).map((track) => ({ ...track, recommendSource: 'search' as const })))
    },
  },
  playback: {
    async play(track, options) {
      if (playbackState.current && mockTrackKey(playbackState.current) !== mockTrackKey(track)) {
        playbackState.history = [playbackState.current, ...playbackState.history].slice(0, 20)
      }
      playbackState.current = { ...track, playUrl: track.playUrl ?? 'mock://audio' }
      playbackState.position = 0
      playbackState.duration = playbackState.current.durationMs ?? 180000
      playbackState.status = 'loading'
      if (typeof options?.initialVolume === 'number') playbackState.volume = options.initialVolume
      playbackState.queue = queueState.filter((item) => mockTrackKey(item) !== mockTrackKey(track))
      queueState = queueState.map((item) => (
        mockTrackKey(item) === mockTrackKey(track)
          ? { ...item, queueStatus: 'playing' }
          : item.queueStatus === 'playing'
            ? { ...item, queueStatus: 'skipped' }
            : item
      ))
      return emitPlayback()
    },
    async enqueue(track) {
      playbackState.queue = [...playbackState.queue, track]
      return emitPlayback()
    },
    async next() {
      const target = playbackState.queue[0]
      if (!target) {
        playbackState.current = null
        playbackState.position = 0
        playbackState.duration = 0
        playbackState.status = 'idle'
        return emitPlayback()
      }
      return this.play(target)
    },
    async finishCurrent() {
      playbackState.current = null
      playbackState.position = 0
      playbackState.duration = 0
      playbackState.status = 'idle'
      return emitPlayback()
    },
    async prev() {
      const target = playbackState.history[0]
      if (!target) return structuredClone(playbackState)
      playbackState.history = playbackState.history.slice(1)
      playbackState.current = target
      playbackState.status = 'loading'
      return emitPlayback()
    },
    async pause() {
      playbackState.status = 'paused'
      return emitPlayback()
    },
    async resume() {
      playbackState.status = playbackState.current ? 'playing' : 'idle'
      return emitPlayback()
    },
    async setVolume(percent) {
      playbackState.volume = Math.max(0, Math.min(100, Math.floor(percent)))
      return emitPlayback()
    },
    async getVolume() {
      return playbackState.volume
    },
    async seek(positionMs) {
      playbackState.position = positionMs
      return emitPlayback()
    },
    async removeFromQueue(index) {
      const target = playbackState.queue[index]
      playbackState.queue = playbackState.queue.filter((_, itemIndex) => itemIndex !== index)
      if (target) {
        const key = mockTrackKey(target)
        queueState = queueState.map((item) => (
          mockTrackKey(item) === key ? { ...item, queueStatus: 'skipped' as const } : item
        ))
      }
      return emitPlayback()
    },
    async removeTrackFromQueue(track) {
      const key = mockTrackKey(track)
      playbackState.queue = playbackState.queue.filter((item) => mockTrackKey(item) !== key)
      queueState = queueState.map((item) => (
        mockTrackKey(item) === key ? { ...item, queueStatus: 'skipped' as const } : item
      ))
      return emitPlayback()
    },
    async clearQueue() {
      playbackState.queue = []
      return emitPlayback()
    },
    async reorderQueue(fromIndex, toIndex) {
      const next = [...playbackState.queue]
      const [moved] = next.splice(fromIndex, 1)
      if (moved) next.splice(Math.max(0, Math.min(next.length, toIndex)), 0, moved)
      playbackState.queue = next
      return emitPlayback()
    },
    async heartbeat(state: PlaybackHeartbeat) {
      playbackState.position = state.position
      playbackState.duration = state.duration ?? playbackState.duration
      playbackState.status = state.status
      return structuredClone(playbackState)
    },
    async refreshUrl(trackId) {
      const track = playbackState.current ? { ...playbackState.current, playUrl: 'mock://audio', urlExpiresAt: new Date(Date.now() + 25 * 60 * 1000).toISOString() } : mockTracks[0]
      playbackState.current = track
      const payload = { trackId, url: track.playUrl ?? '', expiresAt: track.urlExpiresAt ?? new Date().toISOString() }
      urlRefreshListeners.forEach((listener) => listener(payload))
      return { track, state: emitPlayback() }
    },
    async getState() {
      return structuredClone(playbackState)
    },
    onStateChanged(listener) {
      playbackListeners.push(listener)
      return () => {
        playbackListeners = playbackListeners.filter((item) => item !== listener)
      }
    },
    onUrlRefreshed(listener) {
      urlRefreshListeners.push(listener)
      return () => {
        urlRefreshListeners = urlRefreshListeners.filter((item) => item !== listener)
      }
    },
    onCookieExpired(listener) {
      cookieExpiredListeners.push(listener)
      return () => {
        cookieExpiredListeners = cookieExpiredListeners.filter((item) => item !== listener)
      }
    },
  },
  app: {
    async openFeedback() {
      window.open('https://wj.qq.com/s2/26976706/2fcf/', '_blank', 'noopener,noreferrer')
      return { ok: true }
    },
    async minimizeToTray() {
      return { ok: true }
    },
    async quit() {
      return { ok: true }
    },
    onCloseRequested(listener) {
      closeRequestListeners.push(listener)
      return () => {
        closeRequestListeners = closeRequestListeners.filter((item) => item !== listener)
      }
    },
    onNavigate(listener) {
      navigateListeners.push(listener)
      return () => {
        navigateListeners = navigateListeners.filter((item) => item !== listener)
      }
    },
  },
  window: {
    async minimize() {
      return { ok: true }
    },
    async toggleMaximize() {
      return { ok: true, maximized: false }
    },
    async close() {
      closeRequestListeners.forEach((listener) => listener())
      return { ok: true }
    },
  },
  voice: {
    async generate() {
      return runMockRuntimeTask({ kind: 'voice-line', phase: 'generate', total: 1, message: '生成口播文案' }, async (task) => {
        await wait(180)
        assertMockRuntimeTaskActive(task)
        updateMockRuntimeTask(task, { phase: 'done', current: 1, message: '口播文案已生成。' })
        return {
          content: '刚才那几首歌先放着。你不用急着切换，让情绪慢一点落下来。',
          status: 'done',
        }
      })
    },
  },
  tts: {
    async synthesize() {
      return { ok: false, error: { kind: 'MOCK', message: '浏览器预览不合成语音' } }
    },
    async test() {
      return { ok: false, message: '浏览器预览不能测试 TTS。' }
    },
  },
  weather: {
    async get(city) {
      const target = city || settingsState.user.city
      return target ? { city: target, condition: '晴', tempC: 25, humidity: 40, summary: '晴 · 25°C' } : null
    },
  },
  listening: {
    async generateSegment(options) {
      return runMockRuntimeTask({ kind: 'listening-segment', phase: 'context', total: 4, message: '整理回声上下文' }, async (task) => {
        await wait(160)
        assertMockRuntimeTaskActive(task)
        updateMockRuntimeTask(task, { phase: 'candidates', current: 2, message: '挑选回声歌曲' })
        await wait(180)
        assertMockRuntimeTaskActive(task)
        updateMockRuntimeTask(task, { phase: 'tts', current: 3, message: '合成回声音频' })
        const track = options?.continuation ? { ...mockTracks[1], playUrl: 'mock://audio', durationMs: 180000, sourceContext: 'voice' as const } : { ...mockTracks[0], playUrl: 'mock://audio', durationMs: 180000, sourceContext: 'voice' as const }
        await wait(120)
        assertMockRuntimeTaskActive(task)
        updateMockRuntimeTask(task, { phase: 'done', current: 4, message: '浏览器预览不合成语音' })
        const period = chineseDayPeriodLabel()
        return {
          text: options?.continuation ? `接着来。换一首风格接近的，${track.artist}的《${track.title}》。` : `${period}好。这个时间适合把节奏放轻一点,我给你放${track.artist}的《${track.title}》。先让它垫在后面,你不用急着切走。`,
          track,
          generatedAt: new Date().toISOString(),
          error: '浏览器预览不合成语音',
        }
      })
    },
  },
  carePings: {
    async schedule() {
      const today = new Date().toISOString().slice(0, 10)
      return [
        { id: 1, label: '上午提醒', plannedAt: `${today} 10:12`, status: 'planned' as const },
        { id: 2, label: '午后提醒', plannedAt: `${today} 14:36`, status: 'planned' as const },
        { id: 3, label: '夜间提醒', plannedAt: `${today} 20:28`, status: 'planned' as const },
      ]
    },
    async test(type = 'casual_check') {
      return runMockRuntimeTask({ kind: 'care-ping', phase: 'generate', total: 1, message: '生成主动关心' }, async (task) => {
        await wait(180)
        assertMockRuntimeTaskActive(task)
        const page = type === 'voice_invite' ? 'voice' : 'chat'
        if (type !== 'voice_invite') {
          const message: ChatMessage = {
            id: ++messageId,
            role: 'assistant',
            content: type === 'recommend_track' ? '来了。' : '周二下午,工作还顺吗?',
            createdAt: new Date().toISOString(),
            tracks: type === 'recommend_track' ? [mockTracks[0]] : [],
          }
          messages.push(message)
          injectedMessageListeners.forEach((listener) => listener(structuredClone(message)))
        }
        navigateListeners.forEach((listener) => listener({ page, action: type === 'voice_invite' ? 'start_listening' : undefined, canMuteToday: true }))
        updateMockRuntimeTask(task, { phase: 'done', current: 1, message: '测试通知已发出。' })
        return { ok: true, message: '浏览器预览会模拟跳转，系统通知请在 Echo 客户端窗口测试' }
      })
    },
    async muteToday() {
      return { ok: true, message: '今天先不提醒了' }
    },
  },
  netease: {
    async getLoginState() {
      return structuredClone(neteaseState)
    },
    async createQrLogin(): Promise<NeteaseQrLogin> {
      return {
        key: 'mock-qr-key',
        qrUrl: 'https://music.163.com/login?codekey=mock',
        qrImage:
          'data:image/svg+xml;utf8,' +
          encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="180" height="180"><rect width="180" height="180" fill="white"/><rect x="24" y="24" width="42" height="42" fill="%23639922"/><rect x="114" y="24" width="42" height="42" fill="%23639922"/><rect x="24" y="114" width="42" height="42" fill="%23639922"/><path d="M84 82h16v16H84zM104 82h14v14h-14zM82 108h18v18H82zM116 116h22v22h-22z" fill="%231a1a1a"/></svg>'),
        message: '浏览器预览二维码',
      }
    },
    async checkQrLogin(): Promise<NeteaseQrCheckResult> {
      neteaseState = { loggedIn: true, nickname: 'Echo 预览用户', userId: 10001, message: '浏览器预览已模拟登录' }
      return { code: 803, status: 'authorized', message: '浏览器预览已模拟登录', state: structuredClone(neteaseState) }
    },
    async sendCaptcha(phone: string) {
      return /^1\d{10}$/.test(phone.trim())
        ? { ok: true, message: '浏览器预览已模拟发送验证码' }
        : { ok: false, message: '手机号格式不对。' }
    },
    async loginWithCaptcha(phone: string, captcha: string) {
      if (!/^1\d{10}$/.test(phone.trim()) || !captcha.trim()) {
        neteaseState = { loggedIn: false, message: '手机号或验证码不对。' }
        return structuredClone(neteaseState)
      }
      neteaseState = { loggedIn: true, nickname: 'Echo 预览用户', userId: 10001, message: '浏览器预览已模拟登录' }
      return structuredClone(neteaseState)
    },
    async importCookie(cookie: string) {
      neteaseState = cookie.includes('MUSIC_U')
        ? { loggedIn: true, nickname: 'Echo 预览用户', userId: 10001, message: '浏览器预览已模拟导入 Cookie' }
        : { loggedIn: false, message: 'Cookie 里需要包含 MUSIC_U。' }
      return structuredClone(neteaseState)
    },
    async logout() {
      neteaseState = { loggedIn: false, message: '浏览器预览已退出' }
      return structuredClone(neteaseState)
    },
    async listPlaylists() {
      return structuredClone(neteasePlaylists)
    },
    async importPlaylist(id: string): Promise<ImportPlaylistResult> {
      const playlist = neteasePlaylists.find((item) => item.id === id)
      const name = playlist?.name ?? '网易云预览歌单'
      const startedAt = new Date().toISOString()
      setMockImportTask({
        id: `mock-${Date.now()}`,
        kind: 'netease-playlist',
        status: 'running',
        phase: 'semantics',
        current: 0,
        total: mockTracks.length,
        startedAt,
        updatedAt: startedAt,
        sourceName: name,
      })
      await wait(240)
      setMockImportTask({
        id: importTaskState?.id ?? `mock-${Date.now()}`,
        kind: 'netease-playlist',
        status: 'succeeded',
        phase: 'done',
        current: 1,
        total: 1,
        startedAt,
        updatedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        sourceName: name,
        message: `${name} 导入完成`,
      })
      profileState = structuredClone(mockProfile)
      queueState = structuredClone(mockTracks)
      return {
        imported: true,
        count: mockTracks.length,
        name,
        profile: structuredClone(mockProfile),
        message: `已从网易云导入 ${mockTracks.length} 首`,
      }
    },
  },
}

if (import.meta.env.DEV) {
  assertEchoApiContract(mockEcho, 'mockEcho')
  void assertEchoApiReadContract(mockEcho, 'mockEcho').catch((error) => {
    setTimeout(() => {
      throw error
    }, 0)
  })
}

let windowEchoReadContractStarted = false

export function getEchoApi(): EchoApi {
  if (window.echo) {
    if (import.meta.env.DEV) assertEchoApiContract(window.echo, 'window.echo')
    if (import.meta.env.DEV && !windowEchoReadContractStarted) {
      windowEchoReadContractStarted = true
      void assertEchoApiReadContract(window.echo, 'window.echo').catch((error) => {
        console.error('[EchoApi] read contract failed', error)
      })
    }
    return window.echo
  }
  return mockEcho
}
