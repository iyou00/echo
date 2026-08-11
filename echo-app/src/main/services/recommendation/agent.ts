import type { Track } from '../../../types/ipc'
import type { EchoAgent } from '../../runtime/agent'
import { recommendFromNetease, type IntentOverride, type RecommendationOptions } from '../recommendation'

export interface RecommendationAgentInput {
  text: string
  override?: IntentOverride
  options?: Omit<RecommendationOptions, 'signal' | 'onProgress'>
}

export const recommendationAgent: EchoAgent<RecommendationAgentInput, Track[]> = {
  kind: 'recommendation',
  run(input, context) {
    return recommendFromNetease(input.text, input.override, {
      ...input.options,
      signal: context.signal,
      onProgress: context.report,
    })
  },
}
