import type { RuntimeErrorKind, RuntimeEvent, RuntimeTaskSnapshot, RuntimeTaskStatus } from '../../types/ipc'

export type { RuntimeErrorKind, RuntimeEvent, RuntimeTaskSnapshot, RuntimeTaskStatus }

export type RuntimeTaskKind =
  | 'chat-send'
  | 'playlist-import'
  | 'netease-playlist-import'
  | 'semantic-analysis'
  | 'recommendation'
  | 'scene-playback'
  | 'voice-line'
  | 'listening-segment'
  | 'yinyi-generate'
  | 'care-ping'
  | 'taste-refresh'
  | 'scheduler-catchup'

export interface RuntimeTaskStartOptions {
  kind: RuntimeTaskKind | string
  parentTaskId?: string
  phase?: string
  current?: number
  total?: number
  sourceName?: string
  message?: string
  cancellable?: boolean
  uniqueKey?: string
}

export interface RuntimeTaskRecord {
  snapshot: RuntimeTaskSnapshot
  controller: AbortController
  uniqueKey?: string
}
