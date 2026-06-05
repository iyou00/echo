import type { VoiceLine } from '../../types/ipc'
import { getSettings } from '../db/settings'
import { loadRecentConversations } from '../db/conversations'
import { loadRecentTracks } from '../db/tracks'
import { completeChat, LlmError } from '../llm/client'
import { stripKnownSystemBlocks } from '../llm/outputSanitize'
import { getTasteProfile } from '../db/taste'
import { buildMemoryEvidencePrompt } from './memoryEvidence'
import { buildSoulPolicyPrompt } from '../skills/soul/policy'
import { recordHealth } from './health'

export interface GenerateVoiceLineOptions {
  signal?: AbortSignal
}

function assertVoiceActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('任务已取消', 'AbortError')
}

export async function generateVoiceLine(options: GenerateVoiceLineOptions = {}): Promise<VoiceLine> {
  assertVoiceActive(options.signal)
  const conversations = loadRecentConversations(8)
  const tracks = loadRecentTracks(6)
  const settings = getSettings()
  const profile = getTasteProfile()

  const fallback = tracks[0]
    ? `刚才那首《${tracks[0].title}》还在这里。你可以先别急着换，听到副歌再决定。`
    : '我在。你今天可以不用急着解释什么，先给自己留一点安静。'

  try {
    const content = await completeChat(settings, [
      {
        role: 'system',
        content: `${buildSoulPolicyPrompt('voice')}

生成一段 60 字以内的中文口播，像说给用户听。直接输出正文，温和、克制、具体。
记忆只用于校准语气边界,不要提画像、轨迹、数据、纠正或策略。`,
      },
      {
        role: 'user',
        content: `${buildMemoryEvidencePrompt(profile)}

最近对话:
${conversations.map((item) => `${item.role}: ${item.content}`).join('\n')}

今日推荐:
${tracks.map((track) => `${track.title} - ${track.artist}`).join('\n')}

请说一段。`,
      },
    ], { signal: options.signal, maxTokens: 200 })
    assertVoiceActive(options.signal)
    return { content: stripKnownSystemBlocks(content).trim() || fallback, status: 'done' }
  } catch (error) {
    assertVoiceActive(options.signal)
    if (error instanceof LlmError) {
      recordHealth('llm', error.kind === 'auth' || error.kind === 'config' ? 'error' : 'degraded', '回声文案生成失败，已使用兜底文案。', error.message)
    }
    return { content: fallback, status: 'done' }
  }
}
