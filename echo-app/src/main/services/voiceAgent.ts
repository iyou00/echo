import type { VoiceLine } from '../../types/ipc'
import type { EchoAgent } from '../runtime/agent'
import { generateVoiceLine } from './voice'

export const voiceLineAgent: EchoAgent<undefined, VoiceLine> = {
  kind: 'voice-line',
  async run(_input, context) {
    context.report({ phase: 'generate', current: 0, total: 1, message: '生成口播文案' })
    const line = await generateVoiceLine({ signal: context.signal })
    context.report({ phase: 'done', current: 1, total: 1, message: '口播文案已生成。' })
    return line
  },
}
