import type { PageKey } from './appState'
import type { WindowFieldMode } from './shell/WindowField'

export type ChatStageMode = 'idle' | 'chat' | 'streaming' | 'searching' | 'error'

const SEARCH_PHASES = new Set(['weather', 'recommendation', 'music', 'playable', 'search'])

export function deriveChatStageMode({
  hasDialogue,
  sending,
  taskPhase,
  hasError,
}: {
  hasDialogue: boolean
  sending: boolean
  taskPhase?: string
  hasError: boolean
}): ChatStageMode {
  if (hasError) return 'error'
  const phase = taskPhase?.toLowerCase() ?? ''
  if (sending && (SEARCH_PHASES.has(phase) || [...SEARCH_PHASES].some((item) => phase.includes(item)))) return 'searching'
  if (sending) return 'streaming'
  return hasDialogue ? 'chat' : 'idle'
}

export function deriveWindowFieldMode({
  page,
  voiceContinuous,
  currentScene,
  playbackStatus,
  localPlaybackActive,
  chatStageMode,
  listeningDismissed = false,
}: {
  page: PageKey
  voiceContinuous: boolean
  currentScene: boolean
  playbackStatus: string
  localPlaybackActive: boolean
  chatStageMode: ChatStageMode
  listeningDismissed?: boolean
}): WindowFieldMode {
  if (page === 'settings' || page === 'about') return 'quiet'
  if (page === 'voice' || voiceContinuous) return 'voice'
  const listeningNow = localPlaybackActive || playbackStatus === 'playing' || playbackStatus === 'loading'
  if (listeningNow && !listeningDismissed) return 'listening'
  if (currentScene) return 'scene'
  if (page === 'chat') return chatStageMode
  return 'idle'
}
