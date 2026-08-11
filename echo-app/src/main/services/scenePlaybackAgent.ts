import type { SceneKey, ScenePlaybackOptions } from '../../types/ipc'
import type { EchoAgent } from '../runtime/agent'
import { startScenePlayback, type ScenePlaybackResult } from './scenePlayback'

export interface ScenePlaybackAgentInput {
  key: SceneKey
  options?: ScenePlaybackOptions
}

export const scenePlaybackAgent: EchoAgent<ScenePlaybackAgentInput, ScenePlaybackResult> = {
  kind: 'scene-playback',
  run(input, context) {
    return startScenePlayback(input.key, input.options, {
      signal: context.signal,
      report: context.report,
    })
  },
}
