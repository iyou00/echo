import agentSoul from '../../../../prompts/agent-soul.md?raw'
import carePingCasual from '../../../../prompts/care-ping-casual.md?raw'
import carePingRecommend from '../../../../prompts/care-ping-recommend.md?raw'
import carePingVoiceInvite from '../../../../prompts/care-ping-voice-invite.md?raw'
import portraitWriterV2 from '../../../../prompts/portrait-writer-v2.md?raw'
import portraitWriter from '../../../../prompts/portrait-writer.md?raw'
import scenario100 from '../../../../prompts/scenario-100.md?raw'
import sealWriter from '../../../../prompts/seal-writer.md?raw'
import systemPrompt from '../../../../prompts/system.md?raw'
import yinyiWriterV4 from '../../../../prompts/yinyi-writer-v4.md?raw'
import yinyiWriterV5 from '../../../../prompts/yinyi-writer-v5.md?raw'

const EMBEDDED_PROMPTS: Record<string, string> = {
  'prompts/agent-soul.md': agentSoul,
  'prompts/care-ping-casual.md': carePingCasual,
  'prompts/care-ping-recommend.md': carePingRecommend,
  'prompts/care-ping-voice-invite.md': carePingVoiceInvite,
  'prompts/portrait-writer-v2.md': portraitWriterV2,
  'prompts/portrait-writer.md': portraitWriter,
  'prompts/scenario-100.md': scenario100,
  'prompts/seal-writer.md': sealWriter,
  'prompts/system.md': systemPrompt,
  'prompts/yinyi-writer-v4.md': yinyiWriterV4,
  'prompts/yinyi-writer-v5.md': yinyiWriterV5,
}

export const embeddedPromptPaths = Object.freeze(Object.keys(EMBEDDED_PROMPTS))

function normalizePromptPath(relativePath: string): string {
  return relativePath.replace(/\\/g, '/')
}

export function readEmbeddedPrompt(relativePath: string): string | undefined {
  return EMBEDDED_PROMPTS[normalizePromptPath(relativePath)]
}

export function hasEmbeddedPrompt(relativePath: string): boolean {
  return Object.prototype.hasOwnProperty.call(EMBEDDED_PROMPTS, normalizePromptPath(relativePath))
}
