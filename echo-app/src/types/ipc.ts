export type Role = 'user' | 'assistant'

export interface Track {
  id?: string
  neteaseId?: string
  title: string
  artist: string
  album?: string
  year?: number
  publishedAt?: string
  reason?: string
  source?: string
  playUrl?: string
  urlExpiresAt?: string
  durationMs?: number
  recommendedAt?: string
  queueStatusAt?: string
  queueStatus?: 'pending' | 'playing' | 'completed' | 'skipped'
  queueStatusReason?: 'playback_started' | 'playback_completed' | 'playback_skipped' | 'explicit_feedback' | 'queue_removed' | 'scene_replaced' | 'playback_failed'
  echoNote?: string
  favorited?: boolean
  semantic?: TrackSemantic
  recommendSource?: RecommendationSource
  profileEvidence?: TrackProfileEvidence
  sceneKey?: SceneKey
  sceneLabel?: string
  sceneLine?: string
  sceneSessionId?: number
  sceneJourneyRole?: 'transition' | 'lift' | 'hold' | 'settle' | 'explore' | 'reset'
  sceneJourneyIndex?: number
  sceneAdjustmentBatchId?: string
  sourceContext?: 'chat' | 'voice' | 'scene' | 'queue' | 'favorite' | 'history' | 'care'
  agentActionId?: string
  agentActionItemId?: string
  stageContextId?: string
  playbackInstanceId?: string
}

export type StageContextKind = 'work' | 'rest' | 'commute' | 'sleep' | 'exercise' | 'emotional_support' | 'other'
export type StageContextGoal = 'focus' | 'recover' | 'settle' | 'energize' | 'companionship' | 'sleep' | 'none'
export type StageContextStatus = 'active' | 'paused' | 'ended' | 'expired'
export type StageContextEndReason = 'user_ended' | 'user_corrected' | 'replaced' | 'expired' | 'deleted'
export type StageContextEvidenceStrength = 'proposed' | 'executed' | 'engaged' | 'accepted' | 'explicit'

export interface StageState {
  emotion: 'neutral' | 'tired' | 'irritated' | 'low' | 'anxious' | 'calm' | 'positive' | 'unknown'
  energy: 'low' | 'medium' | 'high' | 'unknown'
  interactionPreference: 'talk' | 'music' | 'quiet' | 'unknown'
  safety: 'normal' | 'caution'
}

export interface StageContext {
  id: string
  kind: StageContextKind
  status: StageContextStatus
  summary: string
  state: StageState
  goal: StageContextGoal
  confidence: number
  revision: number
  startedAt: string
  lastActiveAt: string
  expiresAt: string
  endedAt?: string
  endReason?: StageContextEndReason
}

export interface StageContextProposal {
  operation: 'none' | 'create' | 'update' | 'end'
  kind?: StageContextKind
  summary?: string
  statePatch?: Partial<StageState>
  goal?: StageContextGoal
  confidence: number
  ttlClass?: 'short' | 'day' | 'multi_day'
  evidenceConversationIds: number[]
}

export interface StageContextCorrection {
  kind?: StageContextKind
  summary?: string
  statePatch?: Partial<StageState>
  goal?: StageContextGoal
}

export type AgentActionOrigin = 'chat' | 'listening' | 'scene' | 'care' | 'playback'
export type AgentActionType = 'reply' | 'clarify' | 'play' | 'adjust_music' | 'speak_then_play' | 'silent_play' | 'stay_silent' | 'safety_guidance'
export type AgentActionStatus = 'planned' | 'started' | 'succeeded' | 'failed' | 'canceled'
export type AgentActionReason = 'user_request' | 'context_focus' | 'context_recover' | 'context_settle' | 'context_energize' | 'context_companionship' | 'recommendation_followup' | 'explicit_correction' | 'proactive_check' | 'safety_risk' | 'low_intervention_value' | 'muted_or_blocked'
export type AgentActionOutcomeType = 'playback_started' | 'quick_skip' | 'effective_listen' | 'completed' | 'favorite' | 'explicit_like' | 'explicit_miss' | 'replay' | 'opened' | 'system_failure' | 'user_stop' | 'app_closed' | 'dismissed' | 'ignored'
export type AgentActionOutcomeStrength = 'weak' | 'medium' | 'strong'
export type AgentActionOutcomePolarity = 'positive' | 'negative' | 'neutral' | 'system'
export type AgentUserAgency = 'passive' | 'reactive' | 'active'

export interface AgentActionSummary {
  id: string
  origin: AgentActionOrigin
  actionType: AgentActionType
  reasonCode: AgentActionReason
  goalCode: StageContextGoal
  status: AgentActionStatus
  stageContextId?: string
  stageContextRevision?: number
  plannedAt: string
  finishedAt?: string
  decisionCode?: string
  eligibleAt?: string
  outcomes: Array<{ type: AgentActionOutcomeType; polarity: AgentActionOutcomePolarity; strength: AgentActionOutcomeStrength; occurredAt: string }>
}

export type PlaybackStatus = 'idle' | 'loading' | 'playing' | 'paused' | 'error'
export type RecommendationSource = 'daily' | 'fm' | 'similar' | 'style' | 'search' | 'new_song' | 'artist' | 'playlist'
export type ExplicitTrackFeedbackAction = 'more_like_this' | 'not_right'
export type SceneKey = 'focus' | 'sleepy' | 'relax' | 'irritated' | 'random'
export type PingType = 'recommend_track' | 'casual_check' | 'voice_invite'
export type CareFrequency = 'gentle' | 'normal' | 'frequent'
export type OnboardingStep = 'api' | 'playlist' | 'done'
export type AppPageKey = 'chat' | 'review' | 'profile' | 'yinyi' | 'voice' | 'queue' | 'settings' | 'about'
export type ServiceHealthKind =
  | 'llm'
  | 'netease'
  | 'tts'
  | 'weather'
  | 'scheduler'
  | 'scheduler-catchup'
  | 'scheduler-yinyi'
  | 'scheduler-taste-structured'
  | 'scheduler-taste-portrait'
  | 'scheduler-care-ping'
  | 'storage'
export type ServiceHealthStatus = 'ok' | 'degraded' | 'error' | 'unknown'
export type RuntimeTaskStatus = 'running' | 'succeeded' | 'failed' | 'canceled'
export type RuntimeTaskVisibility = 'user' | 'internal'
export type RuntimeErrorKind = 'config' | 'network' | 'auth' | 'rate_limit' | 'server' | 'timeout' | 'canceled' | 'unknown'
export const RUNTIME_TASK_RECENT_LIMIT = 50

export interface RuntimeTaskSnapshot {
  id: string
  parentTaskId?: string
  kind: string
  status: RuntimeTaskStatus
  phase: string
  current: number
  total: number
  startedAt: string
  updatedAt: string
  finishedAt?: string
  sourceName?: string
  message?: string
  error?: string
  errorKind?: RuntimeErrorKind
  cancellable: boolean
  visibility: RuntimeTaskVisibility
}

export interface RuntimeEvent {
  id: string
  taskId?: string
  kind: string
  channel: string
  payload: unknown
  createdAt: string
  visibility: RuntimeTaskVisibility
}

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

export type ProfileEvidenceLevel = 'strong' | 'medium' | 'weak'
export type ProfileEvidenceSource = 'favorite' | 'loop' | 'played' | 'scene' | 'imported' | 'semantic' | 'explicit_like' | 'explicit_miss' | 'fallback'

export interface ProfileDisplayModel {
  signatureItems: Array<{ track: Track; note?: string; count?: number; evidenceLevel: ProfileEvidenceLevel; source: ProfileEvidenceSource }>
  genreItems: Array<{ name: string; weight: number; trend: 'up' | 'down' | 'steady'; representativeArtists: string[]; note?: string; evidenceLevel: ProfileEvidenceLevel; source: ProfileEvidenceSource }>
  artistItems: Array<{ name: string; affinity: number; note?: string; evidenceLevel: ProfileEvidenceLevel; source: ProfileEvidenceSource }>
  moodItems: Array<{ tag: string; frequency: number; evidenceLevel: ProfileEvidenceLevel; source: ProfileEvidenceSource }>
}

export type ProfileInsightKind = 'genre' | 'mood' | 'energy' | 'scene'

export interface ProfileInsight {
  id: string
  kind: ProfileInsightKind
  subject: string
  statement: string
  direction: 'up' | 'down'
  confidence: 'medium' | 'strong'
  evidenceLabel: string
}

export type ProfileInsightFeedbackAction = 'confirm' | 'temporary' | 'reject'

export interface ProfileInsights {
  recentChanges: ProfileInsight[]
  generatedAt: string
  eligibleEventCount: number
  activeDays: number
}

export interface TasteProfileVersion {
  id: number
  portrait: string
  summary?: string
  profile: TasteProfile
  evidenceRevision: number
  trigger?: string
  createdAt: string
}

export interface SceneDefinition {
  key: SceneKey
  label: string
  shortLabel: string
  line: string
  prompt: string
  targetCount: number
  moods: string[]
  scenes: string[]
  energy: 'low' | 'medium' | 'high'
  tempo: 'slow' | 'medium' | 'fast'
  familiarity: 'safe' | 'explore' | 'balanced'
}

export interface ActiveScene extends SceneDefinition {
  id: number
  stageContextId?: string
  startedAt: string
  expiresAt: string
  endedAt?: string
  status: 'active' | 'ended' | 'expired'
}

export interface SceneSessionSummary {
  id: number
  key: SceneKey
  label: string
  startedAt: string
  endedAt?: string
  expiresAt: string
  status: 'active' | 'ended' | 'expired'
  durationMinutes: number
  playedTrackCount?: number
  completedTrackCount?: number
  skippedTrackCount?: number
}

export interface ScenePlaybackResult {
  scene: ActiveScene
  tracks: Track[]
  state: PlaybackState
  message?: ChatMessage
}

export interface ScenePlaybackOptions {
  appendChatMessage?: boolean
  continueSession?: boolean
  targetCount?: number
  enqueueOnly?: boolean
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

export interface ImportTaskSnapshot {
  id: string
  kind: 'playlist-file' | 'netease-playlist' | 'semantic-analysis'
  status: 'running' | 'succeeded' | 'failed' | 'interrupted'
  phase: ImportProgressPayload['phase'] | 'preparing'
  current: number
  total: number
  startedAt: string
  updatedAt: string
  finishedAt?: string
  sourceName?: string
  message?: string
  error?: string
}

export interface SchedulerCatchupResult {
  ok: boolean
  job: 'yinyi_daily' | 'taste_profile_structured' | 'taste_profile_portrait'
  date?: string
  status: 'completed' | 'failed' | 'skipped'
  message: string
}

export interface SchedulerCatchupReport {
  ok: boolean
  results: SchedulerCatchupResult[]
  primary: SchedulerCatchupResult
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
  playbackInstanceId?: string
  position: number
  duration?: number
  status: PlaybackStatus
}

export interface QueueHistoryDay {
  date: string
  tracks: Track[]
}

export interface FavoriteListOptions {
  limit?: number
  offset?: number
  query?: string
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
  artists: Array<{ name: string; affinity: number; notes?: string }>
  moods: Array<{ tag: string; frequency: number; signature_artists?: string[] }>
  era_preference?: Record<string, number>
  discovery_appetite: number
  anti_patterns: string[]
  anti_pattern_meta?: Record<string, string>
  signature_tracks: Track[]
  echo_portrait: string
  work_summary?: string
  energy_preference?: number
  tempo_preference?: { slow: number; medium: number; fast: number }
  scenes?: Array<{ tag: string; frequency: number }>
  display?: ProfileDisplayModel
  insights?: ProfileInsights
  profile_meta?: {
    updatedAt?: string
    structuredUpdatedAt?: string
    portraitUpdatedAt?: string
    refreshReason?: string
    signalCount?: number
    portraitSignalCount?: number
    signalUpdatedAt?: string
    signalRevision?: number
    structuredSignalRevision?: number
    portraitSignalRevision?: number
    portraitRefreshOutcome?: 'published' | 'retained'
    portraitRefreshReason?: string
    statsEvidence?: {
      importedTrackCount: number
      semanticTrackCount: number
      feedbackTrackCount: number
      positiveEventCount: number
      eraImportedCount: number
      eraBehaviorCount: number
      energyImportedCount: number
      energyBehaviorCount: number
      tempoImportedCount: number
      tempoBehaviorCount: number
      sceneEventCount: number
    }
    incrementalSignals?: Array<{
      kind: 'like_artist' | 'like_genre' | 'soften_genre' | 'reinforce_vibe' | 'soften_vibe' | 'raise_energy' | 'lower_energy' | 'reinforce_scene' | 'soften_scene' | 'like_track'
      target: string
      artist?: string
      title?: string
      strength?: number
      updatedAt: string
    }>
  }
}

export interface TasteQuestion {
  id: number
  kind: string
  content: string
  status: 'pending' | 'answered' | 'skipped' | 'expired'
  answered_content?: string
  context?: Record<string, unknown>
}

export type MemoryAuditKind =
  | 'correction'
  | 'favorite'
  | 'loop'
  | 'played'
  | 'skip'
  | 'explicit_like'
  | 'explicit_miss'

export interface MemoryAuditItem {
  id: string
  kind: MemoryAuditKind
  label: string
  title: string
  detail?: string
  createdAt?: string
  track?: Track
  weight?: number
}

export interface MemoryAuditSummary {
  updatedAt: string
  counts: {
    corrections: number
    favorites: number
    explicitLikes: number
    explicitMisses: number
    loops: number
    repeatedSkips: number
  }
  items: MemoryAuditItem[]
}

export type WindowSizePreset = 'compact' | 'standard' | 'large'

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
    quietHours: {
      enabled: boolean
      start: string
      end: string
    }
    pausedUntil?: string
  }
  chat: {
    restoreOnStart: boolean
  }
  playback: {
    autoPlayNext: boolean
  }
  ui: {
    theme?: 'light' | 'dark' | 'system'
    closeBehavior?: 'ask' | 'minimize' | 'quit'
    windowSize?: WindowSizePreset
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
    firstRunWelcomeCompletedAt?: string
    onboardingCompletedAt?: string
    onboardingStep?: OnboardingStep
    lastPrunedAt?: string
  }
}

export interface SettingPathValueMap {
  'llm.baseUrl': string
  'llm.apiKey': string
  'llm.model': string
  'llm.lastTestedAt': string
  'llm.lastTestedOk': boolean
  'yinyi.generateAt': string
  'yinyi.openWithRandom': boolean
  'carePings.enabled': boolean
  'carePings.frequency': CareFrequency
  'carePings.detectFullscreen': boolean
  'carePings.quietHours.enabled': boolean
  'carePings.quietHours.start': string
  'carePings.quietHours.end': string
  'carePings.pausedUntil': string
  'chat.restoreOnStart': boolean
  'playback.autoPlayNext': boolean
  'ui.theme': NonNullable<Settings['ui']['theme']>
  'ui.closeBehavior': NonNullable<Settings['ui']['closeBehavior']>
  'ui.windowSize': NonNullable<Settings['ui']['windowSize']>
  'window.closeHintShown': boolean
  'user.city': string
  'tts.baseUrl': string
  'tts.voice': string
  'tts.speed': number
  'tts.pitch': string
  'meta.schemaVersion': number
  'meta.firstUsedAt': string
  'meta.lastViewedYinyiAt': string | undefined
  'meta.firstRunWelcomeCompletedAt': string | undefined
  'meta.onboardingCompletedAt': string | undefined
  'meta.onboardingStep': OnboardingStep
  'meta.lastPrunedAt': string | undefined
}

export type SettingPath = keyof SettingPathValueMap

export type SettingUpdatePatch<P extends SettingPath = SettingPath> = {
  [K in P]: { path: K; value: SettingPathValueMap[K] }
}[P]

export interface YinyiEntry {
  id?: number
  date: string
  content: string
  style: string
  meta?: {
    tracks?: Track[]
    dismissed_tracks?: Track[]
    status?: 'ok' | 'absent' | 'failed'
    error?: string
    word_count?: number
    conversations_count?: number
    duration_ms?: number
    model?: string
    fallback?: boolean
    fallback_error?: string
    style_signature?: {
      narrativeShape: 'sentence_echo' | 'object_thread' | 'contrast' | 'single_scene' | 'unfinished_question' | 'casual_letter'
      echoStance: 'curious' | 'warm' | 'playful' | 'regretful' | 'bright' | 'quiet'
      openingMode: string
      endingMode: string
      imageryFamily?: string
    }
    evidence_ids?: string[]
    verified_time_relations?: Array<{
      fromEvidenceId: string
      toEvidenceId: string
      minutes: number
      wording: string
    }>
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
  playbackAlreadyApplied?: boolean
  runtimeFailure?: boolean
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
  runtime: {
    getTask(id: string): Promise<RuntimeTaskSnapshot | null>
    getRecentTasks(): Promise<RuntimeTaskSnapshot[]>
    cancelTask(id: string): Promise<{ ok: boolean }>
    onTaskChanged(listener: (snapshot: RuntimeTaskSnapshot) => void): () => void
    onEvent(listener: (event: RuntimeEvent) => void): () => void
  }
  settings: {
    get(): Promise<Settings>
    update<P extends SettingPath>(path: P, value: SettingPathValueMap[P]): Promise<Settings>
    updateBatch(updates: SettingUpdatePatch[]): Promise<Settings>
    testLlm(): Promise<LlmTestResult>
    importPlaylist(): Promise<ImportPlaylistResult>
    downloadPlaylistTemplate(): Promise<{ ok: boolean; path?: string; message: string }>
    exportData(): Promise<{ ok: boolean; path?: string; message: string }>
    resetData(): Promise<{ ok: boolean }>
    onChanged(listener: (payload: { path: string; value: unknown }) => void): () => void
  }
  health: {
    get(): Promise<ServiceHealth[]>
    check(): Promise<ServiceHealth[]>
  }
  scheduler: {
    runCatchup(): Promise<SchedulerCatchupReport>
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
    getMemoryAudit(): Promise<MemoryAuditSummary>
    getProfileVersions(): Promise<TasteProfileVersion[]>
    refreshStructuredProfile(): Promise<TasteProfile | null>
    regeneratePortrait(): Promise<TasteProfile | null>
    applySignal(kind: string, payload: Record<string, unknown>): Promise<TasteProfile | null>
    respondToInsight(insight: ProfileInsight, action: ProfileInsightFeedbackAction): Promise<TasteProfile | null>
    restoreProfileVersion(id: number): Promise<TasteProfile>
    correctMemory(note: string): Promise<{ ok: boolean; message: string }>
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
    list(options?: FavoriteListOptions): Promise<Track[]>
    count(query?: string): Promise<number>
    listKeys(): Promise<string[]>
    toggle(track: Track): Promise<{ favorited: boolean; favorites: Track[] }>
    isFavorite(track: Track): Promise<boolean>
    onChanged(listener: (payload: { track: Track; favorited: boolean; total: number }) => void): () => void
  }
  feedback: {
    record(track: Track, action: ExplicitTrackFeedbackAction, context?: string): Promise<{ ok: boolean; message: string }>
  }
  scene: {
    definitions(): Promise<SceneDefinition[]>
    getCurrent(): Promise<ActiveScene | null>
    start(key: SceneKey): Promise<ActiveScene>
    play(key: SceneKey, options?: ScenePlaybackOptions): Promise<ScenePlaybackResult>
    end(): Promise<ActiveScene | null>
    today(): Promise<SceneSessionSummary[]>
    onChanged(listener: (scene: ActiveScene | null) => void): () => void
  }
  stageContext: {
    getActive(): Promise<StageContext | null>
    end(): Promise<StageContext | null>
    correct(input: StageContextCorrection): Promise<StageContext | null>
    delete(id: string): Promise<{ ok: boolean }>
    recentActions(limit?: number, origin?: AgentActionOrigin): Promise<AgentActionSummary[]>
  }
  semantics: {
    buildForImportedTracks(): Promise<{ tagged: number; skipped: number }>
    getSummary(): Promise<SemanticSummary>
  }
  import: {
    getSnapshot(): Promise<ImportTaskSnapshot | null>
    onChanged(listener: (snapshot: ImportTaskSnapshot | null) => void): () => void
    onProgress(listener: (payload: ImportProgressPayload) => void): () => void
  }
  recommendation: {
    recommendFromNetease(text: string): Promise<Track[]>
  }
  playback: {
    play(track: Track, options?: PlaybackPlayOptions): Promise<PlaybackState>
    enqueue(track: Track): Promise<PlaybackState>
    next(playbackInstanceId?: string): Promise<PlaybackState>
    finishCurrent(playbackInstanceId?: string): Promise<PlaybackState>
    prev(): Promise<PlaybackState>
    pause(): Promise<PlaybackState>
    resume(): Promise<PlaybackState>
    setVolume(percent: number): Promise<PlaybackState>
    getVolume(): Promise<number>
    seek(positionMs: number): Promise<PlaybackState>
    removeFromQueue(index: number): Promise<PlaybackState>
    removeTrackFromQueue(track: Track): Promise<PlaybackState>
    clearQueue(): Promise<PlaybackState>
    reorderQueue(fromIndex: number, toIndex: number): Promise<PlaybackState>
    heartbeat(state: PlaybackHeartbeat): Promise<PlaybackState>
    reportError(playbackInstanceId: string, failureKind?: string): Promise<PlaybackState>
    refreshUrl(trackId: string): Promise<{ track: Track; state: PlaybackState }>
    getState(): Promise<PlaybackState>
    onStateChanged(listener: (state: PlaybackState) => void): () => void
    onUrlRefreshed(listener: (payload: { trackId: string; url: string; expiresAt: string }) => void): () => void
    onCookieExpired(listener: (message: string) => void): () => void
  }
  app: {
    openFeedback(): Promise<{ ok: boolean }>
    minimizeToTray(): Promise<{ ok: boolean }>
    quit(): Promise<{ ok: boolean }>
    onCloseRequested(listener: () => void): () => void
    onNavigate(listener: (payload: AppNavigatePayload) => void): () => void
  }
  window: {
    minimize(): Promise<{ ok: boolean }>
    setSizePreset(preset: WindowSizePreset): Promise<{ ok: boolean; preset: WindowSizePreset; width: number; height: number }>
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
    generateSegment(options?: { continuation?: boolean; automatic?: boolean }): Promise<{
      text: string
      track: Track | null
      delivery: 'spoken' | 'silent'
      density: 'silent' | 'micro' | 'brief' | 'full'
      sessionId: number
      audioUrl?: string
      error?: string
      generatedAt: string
    }>
    endSession(sessionId?: number): Promise<{ ok: boolean }>
  }
  carePings: {
    test(type?: PingType): Promise<{ ok: boolean; message: string }>
    muteToday(carePingId?: number): Promise<{ ok: boolean; message: string }>
    pause(mode: 'today' | 'week' | 'resume'): Promise<{ ok: boolean; message: string; settings: Settings }>
    schedule(): Promise<CarePingScheduleItem[]>
  }
  voice: {
    generate(): Promise<VoiceLine>
  }
  netease: {
    getLoginState(): Promise<NeteaseLoginState>
    createQrLogin(): Promise<NeteaseQrLogin>
    checkQrLogin(key: string): Promise<NeteaseQrCheckResult>
    sendCaptcha(phone: string): Promise<{ ok: boolean; message: string }>
    loginWithCaptcha(phone: string, captcha: string): Promise<NeteaseLoginState>
    importCookie(cookie: string): Promise<NeteaseLoginState>
    logout(): Promise<NeteaseLoginState>
    listPlaylists(): Promise<NeteasePlaylistSummary[]>
    importPlaylist(id: string): Promise<ImportPlaylistResult>
  }
}
