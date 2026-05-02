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
} from '../types/ipc'

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
  { key: 'work', label: '工作', shortLabel: '工 作', line: '让节奏慢慢提起来,先别太炸。', prompt: '我想进入工作状态,帮我推荐 5 首歌曲。', targetCount: 5, moods: ['清醒', '陪伴'], scenes: ['下午工作'], energy: 'medium', tempo: 'medium', familiarity: 'balanced' },
  { key: 'focus', label: '专注', shortLabel: '专 注', line: '少一点存在感,让节奏稳定铺着。', prompt: '我想专注一会儿,帮我推荐 5 首不抢注意力的歌曲。', targetCount: 5, moods: ['松弛', '陪伴'], scenes: ['独处', '下午工作'], energy: 'low', tempo: 'slow', familiarity: 'safe' },
  { key: 'sleepy', label: '犯困', shortLabel: '犯 困', line: '把精神提一下,别一下子太猛。', prompt: '我有点犯困,帮我推荐 5 首提神但别太炸的歌曲。', targetCount: 5, moods: ['清醒', '轻快'], scenes: ['下午工作'], energy: 'high', tempo: 'medium', familiarity: 'balanced' },
  { key: 'relax', label: '放松', shortLabel: '放 松', line: '工作间隙缓一下,别把情绪拽太深。', prompt: '我想放松一下,帮我推荐 5 首轻一点的歌曲。', targetCount: 5, moods: ['松弛', '治愈'], scenes: ['独处'], energy: 'low', tempo: 'slow', familiarity: 'safe' },
  { key: 'rain', label: '雨天', shortLabel: '雨 天', line: '窗外慢一点,歌也慢一点。', prompt: '雨天这个气氛,帮我推荐 5 首歌曲。', targetCount: 5, moods: ['怀旧', '发呆'], scenes: ['雨天'], energy: 'low', tempo: 'slow', familiarity: 'balanced' },
  { key: 'irritated', label: '烦躁', shortLabel: '烦 躁', line: '先降噪,让脑子别继续被推着走。', prompt: '我有点烦躁,帮我推荐 5 首别太吵的歌曲。', targetCount: 5, moods: ['松弛', '治愈'], scenes: ['独处'], energy: 'low', tempo: 'slow', familiarity: 'safe' },
  { key: 'random', label: '随便听', shortLabel: '随 便', line: '交给 Echo 发散,从你的口味里随手捞。', prompt: '随便听点什么吗?不改的话,就给你自动连播 5 首哦。', targetCount: 5, moods: ['陪伴'], scenes: ['下午工作'], energy: 'medium', tempo: 'medium', familiarity: 'explore' },
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
  anti_patterns: ['太满的电子音墙', '廉价苦情副歌', '开场过硬的金属质感'],
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
  { service: 'netease', status: 'degraded', message: '网易云登录可能过期了。重新扫码后我再拿播放链接。', checkedAt: now },
  { service: 'tts', status: 'degraded', message: '浏览器预览不合成语音。', checkedAt: now },
  { service: 'weather', status: 'degraded', message: '还没设置城市。我会跳过天气开场。', checkedAt: now },
  { service: 'scheduler', status: 'ok', message: '定时任务已恢复。', checkedAt: now },
]
let profileState: TasteProfile | null = structuredClone(mockProfile)
let questionState: TasteQuestion[] = structuredClone(mockQuestions)
let queueState: Track[] = structuredClone(mockTracks)
let favoriteState: Track[] = []
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
    content: '好，林俊杰和 Charlie Puth 给你接上。一首华语一首欧美，情绪连得上。',
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

function wait(ms: number) {
  return new Promise((resolve) => window.setTimeout(resolve, ms))
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
  if (!track) return ''
  if (track.neteaseId) return `netease:${track.neteaseId}`
  if (track.id) return `id:${track.id}`
  return `name:${track.title.trim().toLowerCase()}::${track.artist.trim().toLowerCase()}`
}

function mockIsFavorite(track: Track) {
  return favoriteState.some((item) => mockTrackKey(item) === mockTrackKey(track))
}

function mockSceneDefinition(key: SceneKey) {
  const scene = mockScenes.find((item) => item.key === key)
  if (!scene) throw new Error('未知场景')
  return scene
}

function emitPlayback() {
  const next = structuredClone(playbackState)
  playbackListeners.forEach((listener) => listener(next))
  return next
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
  settings: {
    async get() {
      return structuredClone(settingsState)
    },
    async update(path, value) {
      return setNestedSetting(path, value)
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
      ]
      emitPlayback()
      return { ok: true }
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
          message: neteaseState.loggedIn ? `网易云已登录：${neteaseState.nickname ?? '网易云用户'}` : '网易云登录可能过期了。重新扫码后我再拿播放链接。',
          checkedAt,
        },
        { service: 'tts', status: 'degraded', message: '浏览器预览不合成语音。', checkedAt },
        {
          service: 'weather',
          status: settingsState.user.city ? 'ok' : 'degraded',
          message: settingsState.user.city ? '天气可用：晴 · 25°C' : '还没设置城市。我会跳过天气开场。',
          checkedAt,
        },
        { service: 'scheduler', status: 'ok', message: '定时任务已恢复。', checkedAt },
      ]
      return structuredClone(healthState)
    },
  },
  scheduler: {
    async runCatchup() {
      const primary = { ok: true, job: 'yinyi_daily' as const, date: todayIso(), status: 'skipped' as const, message: '这一天已经有音忆了。' }
      return { ok: true, primary, results: [primary] }
    },
  },
  chat: {
    async send(text: string): Promise<SendChatResult> {
      const user: ChatMessage = { id: ++messageId, role: 'user', content: text, createdAt: new Date().toISOString() }
      messages.push(user)
      const picked = mockTracks.slice(0, text.includes('慢') || text.includes('类似') ? 3 : 1)
      const content = picked.length > 1 ? '给你接三首慢一点的。第一首先降速，后两首把情绪铺开。' : '我先给你放这首。它的入口轻，适合现在。'
      for (const chunk of content.match(/.{1,8}/g) ?? [content]) {
        await wait(80)
        chunkListeners.forEach((listener) => listener(chunk))
      }
      const assistant: ChatMessage = {
        id: ++messageId,
        role: 'assistant',
        content,
        createdAt: new Date().toISOString(),
        tracks: picked,
      }
      messages.push(assistant)
      queueState = picked.concat(queueState.filter((track) => !picked.some((item) => item.title === track.title)))
      return { message: assistant, tracks: picked }
    },
    async loadRecent(limit = 30) {
      return structuredClone(messages.slice(-limit))
    },
    async cancel() {
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
    async regeneratePortrait() {
      profileState = structuredClone(mockProfile)
      return structuredClone(profileState)
    },
    async applySignal() {
      return structuredClone(profileState)
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
      return structuredClone(entry)
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
    async list() {
      return structuredClone(favoriteState.map((track) => ({ ...track, favorited: true })))
    },
    async toggle(track) {
      const key = mockTrackKey(track)
      const exists = favoriteState.some((item) => mockTrackKey(item) === key)
      favoriteState = exists
        ? favoriteState.filter((item) => mockTrackKey(item) !== key)
        : [{ ...track, favorited: true }, ...favoriteState]
      return { favorited: !exists, favorites: structuredClone(favoriteState) }
    },
    async isFavorite(track) {
      return mockIsFavorite(track)
    },
  },
  feedback: {
    async record() {
      return { ok: true, message: '我记住了。' }
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
      return structuredClone(scene)
    },
    async play(key, options) {
      const scene = await this.start(key)
      const tracks = structuredClone(mockTracks.slice(0, scene.targetCount).map((track) => ({
        ...track,
        playUrl: track.playUrl ?? 'mock://audio',
        sceneKey: scene.key,
        sceneLabel: scene.label,
        sceneLine: scene.line,
        sceneSessionId: scene.id,
        queueStatus: 'pending' as const,
      })))
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
      const message = options?.appendChatMessage
        ? {
          id: ++messageId,
          role: 'assistant' as const,
          content: tracks[0] ? `我切到${scene.label}了。先放《${tracks[0].title}》，后面几首我也排好了。` : `我切到${scene.label}了，先帮你把歌排起来。`,
          createdAt: new Date().toISOString(),
          tracks,
        }
        : undefined
      if (message) messages.push(message)
      return { scene, tracks, state: structuredClone(playbackState), message }
    },
    async end() {
      if (!activeSceneState || activeSceneState.status !== 'active') return null
      activeSceneState = { ...activeSceneState, status: 'ended', endedAt: new Date().toISOString() }
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
      playbackState.queue = playbackState.queue.filter((_, itemIndex) => itemIndex !== index)
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
      return {
        content: '刚才那几首歌先放着。你不用急着切换，让情绪慢一点落下来。',
        status: 'done',
      }
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
    async generateSegment() {
      const track = { ...mockTracks[0], playUrl: 'mock://audio', durationMs: 180000, sourceContext: 'voice' as const }
      return {
        text: `下午好。这个时间适合把节奏放轻一点,我给你放${track.artist}的《${track.title}》。先让它垫在后面,你不用急着切走。`,
        track,
        generatedAt: new Date().toISOString(),
        error: '浏览器预览不合成语音',
      }
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
      return { ok: true, message: '浏览器预览会模拟跳转，系统通知请在 Echo 客户端窗口测试' }
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
    async logout() {
      neteaseState = { loggedIn: false, message: '浏览器预览已退出' }
      return structuredClone(neteaseState)
    },
    async listPlaylists() {
      return structuredClone(neteasePlaylists)
    },
    async importPlaylist(id: string): Promise<ImportPlaylistResult> {
      const playlist = neteasePlaylists.find((item) => item.id === id)
      profileState = structuredClone(mockProfile)
      queueState = structuredClone(mockTracks)
      return {
        imported: true,
        count: mockTracks.length,
        name: playlist?.name ?? '网易云预览歌单',
        profile: structuredClone(mockProfile),
        message: `已从网易云导入 ${mockTracks.length} 首`,
      }
    },
  },
}

export function getEchoApi(): EchoApi {
  return window.echo ?? mockEcho
}
