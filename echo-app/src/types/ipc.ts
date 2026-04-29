export type Role = 'user' | 'assistant'

export interface Track {
  id?: string
  neteaseId?: string
  title: string
  artist: string
  album?: string
  year?: number
  reason?: string
  source?: string
  playUrl?: string
  urlExpiresAt?: string
  durationMs?: number
  recommendedAt?: string
  queueStatus?: 'pending' | 'playing' | 'completed' | 'skipped'
  echoNote?: string
  favorited?: boolean
  semantic?: TrackSemantic
  recommendSource?: RecommendationSource
  profileEvidence?: TrackProfileEvidence
}

export type PlaybackStatus = 'idle' | 'loading' | 'playing' | 'paused' | 'error'
export type RecommendationSource = 'daily' | 'fm' | 'similar' | 'style' | 'search' | 'new_song' | 'artist' | 'playlist'
export type PingType = 'recommend_track' | 'casual_check' | 'voice_invite'
export type CareFrequency = 'gentle' | 'normal' | 'frequent'
export type AppPageKey = 'chat' | 'profile' | 'yinyi' | 'voice' | 'queue' | 'settings'
export type ServiceHealthKind = 'llm' | 'netease' | 'tts' | 'weather' | 'scheduler' | 'storage'
export type ServiceHealthStatus = 'ok' | 'degraded' | 'error' | 'unknown'

export interface ServiceHealth {
  service: ServiceHealthKind
  status: ServiceHealthStatus
  message: string
  checkedAt?: string
  technical?: string
}

export interface CarePingScheduleItem {
  id: number
  label: string
  plannedAt: string
  status: 'planned' | 'completed' | 'failed' | 'skipped'
  message?: string | null
}

export interface TrackSemantic {
  language: string
  genres: string[]
  moods: string[]
  scenes: string[]
  energy: number
  tempo: 'slow' | 'medium' | 'fast'
  familiarity: 'safe' | 'explore'
  confidence: number
}

export interface TrackProfileEvidence {
  moods?: string[]
  scenes?: string[]
  source?: string
  score?: number
}

export interface SemanticSummary {
  moods: TasteProfile['moods']
  total: number
}

export interface ImportProgressPayload {
  phase: 'semantics' | 'profile' | 'done'
  current: number
  total: number
  startedAt: string
}

export interface SchedulerCatchupResult {
  ok: boolean
  job: 'yinyi_daily'
  date?: string
  status: 'completed' | 'failed' | 'skipped'
  message: string
}

export interface AppNavigatePayload {
  page: AppPageKey
  action?: 'start_listening'
  carePingId?: number
  canMuteToday?: boolean
}

export interface PlaybackState {
  current: Track | null
  position: number
  duration: number
  status: PlaybackStatus
  volume: number
  queue: Track[]
  history: Track[]
  error?: string
}

export interface PlaybackPlayOptions {
  initialVolume?: number
}

export interface PlaybackHeartbeat {
  position: number
  duration?: number
  status: PlaybackStatus
}

export interface QueueHistoryDay {
  date: string
  tracks: Track[]
}

export interface ChatMessage {
  id: number
  role: Role
  content: string
  createdAt: string
  tracks?: Track[]
}

export interface TasteProfile {
  genres: Array<{ name: string; weight: number; trend: 'up' | 'down' | 'steady'; note?: string }>
  artists: Array<{ name: string; affinity: number; last_played?: string; notes?: string }>
  moods: Array<{ tag: string; frequency: number; signature_artists?: string[] }>
  era_preference?: Record<string, number>
  discovery_appetite: number
  anti_patterns: string[]
  signature_tracks: Track[]
  echo_portrait: string
  profile_meta?: {
    updatedAt?: string
    structuredUpdatedAt?: string
    refreshReason?: string
    signalCount?: number
  }
}

export interface TasteQuestion {
  id: number
  kind: string
  content: string
  status: 'pending' | 'answered' | 'skipped' | 'expired'
  answered_content?: string
}

export interface Settings {
  llm: {
    baseUrl: string
    apiKey: string
    model: string
    lastTestedAt?: string
    lastTestedOk?: boolean
  }
  yinyi: {
    generateAt: string
    openWithRandom: boolean
  }
  carePings: {
    enabled: boolean
    frequency: CareFrequency
    detectFullscreen: boolean
  }
  chat: {
    restoreOnStart: boolean
  }
  ui: {
    theme?: 'light' | 'dark' | 'system'
    closeBehavior?: 'ask' | 'minimize'
  }
  window: {
    closeHintShown: boolean
  }
  user: {
    city: string
  }
  tts: {
    baseUrl: string
    voice: string
    speed: number
    pitch: string
  }
  meta: {
    schemaVersion: number
    firstUsedAt: string
    lastViewedYinyiAt?: string
  }
}

export interface YinyiEntry {
  id?: number
  date: string
  content: string
  style: string
  meta?: {
    tracks?: Track[]
    status?: 'ok' | 'absent' | 'failed'
    error?: string
  }
  createdAt?: string
}

export interface ImportPlaylistResult {
  imported: boolean
  count: number
  name?: string
  message?: string
  profile?: TasteProfile
}

export interface LlmTestResult {
  ok: boolean
  latencyMs?: number
  message: string
}

export interface NeteaseLoginState {
  loggedIn: boolean
  nickname?: string
  userId?: number
  avatarUrl?: string
  message: string
}

export interface NeteaseQrLogin {
  key: string
  qrUrl: string
  qrImage: string
  message: string
}

export interface NeteaseQrCheckResult {
  code: number
  status: 'waiting' | 'scanned' | 'authorized' | 'expired' | 'failed'
  message: string
  state?: NeteaseLoginState
}

export interface NeteasePlaylistSummary {
  id: string
  name: string
  trackCount: number
  creator?: string
  coverImgUrl?: string
  subscribed?: boolean
}

export interface ChatHints {
  neteaseAuthRequired?: boolean
}

export interface SendChatResult {
  message: ChatMessage
  tracks: Track[]
  hints?: ChatHints
}

export interface VoiceLine {
  content: string
  status: 'thinking' | 'speaking' | 'done'
}

export interface EchoApi {
  settings: {
    get(): Promise<Settings>
    update(path: string, value: unknown): Promise<Settings>
    testLlm(): Promise<LlmTestResult>
    importPlaylist(): Promise<ImportPlaylistResult>
    exportData(): Promise<{ ok: boolean; path?: string; message: string }>
    resetData(): Promise<{ ok: boolean }>
  }
  health: {
    get(): Promise<ServiceHealth[]>
    check(): Promise<ServiceHealth[]>
  }
  scheduler: {
    runCatchup(): Promise<SchedulerCatchupResult>
  }
  chat: {
    send(text: string): Promise<SendChatResult>
    loadRecent(limit?: number): Promise<ChatMessage[]>
    cancel(): Promise<{ ok: boolean }>
    onChunk(listener: (chunk: string) => void): () => void
    onMessageInjected(listener: (message: ChatMessage) => void): () => void
  }
  taste: {
    getProfile(): Promise<{ profile: TasteProfile | null; questions: TasteQuestion[] }>
    regeneratePortrait(): Promise<TasteProfile | null>
    applySignal(kind: string, payload: Record<string, unknown>): Promise<TasteProfile | null>
    answerQuestion(id: number, answer: string): Promise<{ ok: boolean }>
  }
  yinyi: {
    generate(date?: string): Promise<YinyiEntry>
    getByDate(date: string): Promise<YinyiEntry | null>
    getRange(limit?: number): Promise<YinyiEntry[]>
    getRandom(): Promise<YinyiEntry | null>
    onGenerated(listener: (payload: { date: string; status: string }) => void): () => void
  }
  queue: {
    get(): Promise<Track[]>
    history(limitDays?: number): Promise<QueueHistoryDay[]>
    clearHistoryDates(dates: string[]): Promise<QueueHistoryDay[]>
    markStatus(track: Track, status: Track['queueStatus']): Promise<Track[]>
  }
  favorites: {
    list(): Promise<Track[]>
    toggle(track: Track): Promise<{ favorited: boolean; favorites: Track[] }>
    isFavorite(track: Track): Promise<boolean>
  }
  semantics: {
    buildForImportedTracks(): Promise<{ tagged: number; skipped: number }>
    getSummary(): Promise<SemanticSummary>
  }
  import: {
    onProgress(listener: (payload: ImportProgressPayload) => void): () => void
  }
  recommendation: {
    recommendFromNetease(text: string): Promise<Track[]>
  }
  playback: {
    play(track: Track, options?: PlaybackPlayOptions): Promise<PlaybackState>
    enqueue(track: Track): Promise<PlaybackState>
    next(): Promise<PlaybackState>
    prev(): Promise<PlaybackState>
    pause(): Promise<PlaybackState>
    resume(): Promise<PlaybackState>
    setVolume(percent: number): Promise<PlaybackState>
    getVolume(): Promise<number>
    seek(positionMs: number): Promise<PlaybackState>
    removeFromQueue(index: number): Promise<PlaybackState>
    clearQueue(): Promise<PlaybackState>
    reorderQueue(fromIndex: number, toIndex: number): Promise<PlaybackState>
    heartbeat(state: PlaybackHeartbeat): Promise<PlaybackState>
    refreshUrl(trackId: string): Promise<{ track: Track; state: PlaybackState }>
    getState(): Promise<PlaybackState>
    onStateChanged(listener: (state: PlaybackState) => void): () => void
    onUrlRefreshed(listener: (payload: { trackId: string; url: string; expiresAt: string }) => void): () => void
    onCookieExpired(listener: (message: string) => void): () => void
  }
  app: {
    minimizeToTray(): Promise<{ ok: boolean }>
    quit(): Promise<{ ok: boolean }>
    onCloseRequested(listener: () => void): () => void
    onNavigate(listener: (payload: AppNavigatePayload) => void): () => void
  }
  window: {
    minimize(): Promise<{ ok: boolean }>
    toggleMaximize(): Promise<{ ok: boolean; maximized?: boolean }>
    close(): Promise<{ ok: boolean }>
  }
  tts: {
    synthesize(text: string): Promise<{ ok: true; audioUrl: string } | { ok: false; error: { kind: string; message: string } }>
    test(): Promise<{ ok: boolean; latencyMs?: number; message: string }>
  }
  weather: {
    get(city?: string): Promise<{ city: string; condition: string; tempC: number; humidity: number; summary: string } | null>
  }
  listening: {
    generateSegment(): Promise<{ text: string; track: Track | null; audioUrl?: string; error?: string; generatedAt: string }>
  }
  carePings: {
    test(type?: PingType): Promise<{ ok: boolean; message: string }>
    muteToday(): Promise<{ ok: boolean; message: string }>
    schedule(): Promise<CarePingScheduleItem[]>
  }
  voice: {
    generate(): Promise<VoiceLine>
  }
  netease: {
    getLoginState(): Promise<NeteaseLoginState>
    createQrLogin(): Promise<NeteaseQrLogin>
    checkQrLogin(key: string): Promise<NeteaseQrCheckResult>
    logout(): Promise<NeteaseLoginState>
    listPlaylists(): Promise<NeteasePlaylistSummary[]>
    importPlaylist(id: string): Promise<ImportPlaylistResult>
  }
}
