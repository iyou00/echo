import type { ActiveScene, Track } from '../../types/ipc'

export type PlaybackCompletionAction = 'voice_continue' | 'scene_next' | 'scene_continue' | 'auto_next' | 'finish'

export function decidePlaybackCompletionAction(input: {
  voiceContinuous: boolean
  currentScene?: ActiveScene | null
  current?: Track | null
  queue?: Track[]
  autoPlayNext: boolean
}): PlaybackCompletionAction {
  if (input.voiceContinuous) return 'voice_continue'
  if (input.current?.sourceContext === 'voice') return 'finish'
  const scene = input.currentScene
  const current = input.current
  if (scene && current && (
    current.sceneSessionId === scene.id || (!current.sceneSessionId && current.sceneKey === scene.key)
  )) {
    if (input.queue?.[0]?.sceneSessionId === scene.id) return 'scene_next'
    return 'scene_continue'
  }
  return input.autoPlayNext ? 'auto_next' : 'finish'
}
