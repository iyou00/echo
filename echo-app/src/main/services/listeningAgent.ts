import type { EchoAgent } from '../runtime/agent'
import { generateListeningSegment, type ListeningSegmentOptions, type ListeningSegmentResult } from './listening'

export type ListeningSegmentAgentInput = Omit<ListeningSegmentOptions, 'signal' | 'onProgress'>

export const listeningSegmentAgent: EchoAgent<ListeningSegmentAgentInput | undefined, ListeningSegmentResult> = {
  kind: 'listening-segment',
  run(input, context) {
    return generateListeningSegment({
      ...(input ?? {}),
      signal: context.signal,
      onProgress: context.report,
    })
  },
}
