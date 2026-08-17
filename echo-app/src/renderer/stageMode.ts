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
  hasCurrentTrack,
  listeningViewOpen,
  chatStageMode,
}: {
  page: PageKey
  voiceContinuous: boolean
  currentScene: boolean
  hasCurrentTrack: boolean
  listeningViewOpen: boolean
  chatStageMode: ChatStageMode
}): WindowFieldMode {
  if (page === 'settings' || page === 'about') return 'quiet'
  if (page === 'voice' || voiceContinuous) {
    // 回声页里用户点音乐书签/迷你封面显式打开一起听时，一起听优先；回声连续不停。
    if (listeningViewOpen && hasCurrentTrack) return 'listening'
    return 'voice'
  }
  // 一起听视图由用户意图（listeningViewOpen）驱动，与播放/暂停状态解耦：
  // 暂停不收起，只有「回到此刻」或队列结束才收起。
  if (listeningViewOpen && hasCurrentTrack) return 'listening'
  if (currentScene) return 'scene'
  if (page === 'chat') return chatStageMode
  return 'idle'
}
