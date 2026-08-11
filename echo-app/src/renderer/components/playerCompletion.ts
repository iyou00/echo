import type { ActiveScene, Track } from '../../types/ipc'

export type PlaybackCompletionAction = 'voice_continue' | 'scene_continue' | 'auto_next' | 'finish'

export function decidePlaybackCompletionAction(input: {
  voiceContinuous: boolean
  currentScene?: ActiveScene | null
  current?: Track | null
  autoPlayNext: boolean
}): PlaybackCompletionAction {
  if (input.voiceContinuous) return 'voice_continue'
  if (input.current?.sourceContext === 'voice') return 'finish'
  const scene = input.currentScene
  const current = input.current
  if (scene && current && (
    current.sceneSessionId === scene.id || (!current.sceneSessionId && current.sceneKey === scene.key)
  )) {
    return 'scene_continue'
  }
  return input.autoPlayNext ? 'auto_next' : 'finish'
}
