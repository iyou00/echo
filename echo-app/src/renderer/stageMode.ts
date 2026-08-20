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
  currentScene,
  hasCurrentTrack,
  listeningViewOpen,
  chatStageMode,
}: {
  page: PageKey
  currentScene: boolean
  hasCurrentTrack: boolean
  listeningViewOpen: boolean
  chatStageMode: ChatStageMode
}): WindowFieldMode {
  if (page === 'settings' || page === 'about') return 'quiet'
  // 一起听覆盖层只存在于絮语/回声两页：其他页面（队列、设置、品味……）
  // 各有自己的整页形态，不能被一起听盖住。
  const listeningHere = listeningViewOpen && hasCurrentTrack && (page === 'chat' || page === 'voice')
  if (page === 'voice') {
    // 回声页里用户点音乐书签/迷你封面显式打开一起听时，一起听优先；回声连续不停。
    // 连续回声只是回声页内部的行为开关——离开回声页后 field 跟随页面。
    if (listeningHere) return 'listening'
    return 'voice'
  }
  // 一起听视图由用户意图（listeningViewOpen）驱动，与播放/暂停状态解耦：
  // 暂停不收起，只有「回到此刻」或队列结束才收起。
  if (listeningHere) return 'listening'
  if (currentScene) return 'scene'
  if (page === 'chat') return chatStageMode
  return 'idle'
}
