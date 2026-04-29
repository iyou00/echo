import type { VoiceLine } from '../../types/ipc'
import { getSettings } from '../db/settings'
import { loadRecentConversations } from '../db/conversations'
import { loadRecentTracks } from '../db/tracks'
import { completeChat } from '../llm/client'

export async function generateVoiceLine(): Promise<VoiceLine> {
  const conversations = loadRecentConversations(8)
  const tracks = loadRecentTracks(6)
  const settings = getSettings()

  const fallback = tracks[0]
    ? `刚才那首《${tracks[0].title}》还在这里。你可以先别急着换，让它把这段情绪走完。`
    : '我在。你今天可以不用急着解释什么，先给自己留一点安静。'

  try {
    const content = await completeChat(settings, [
      {
        role: 'system',
        content: '你是 Echo。生成一段 60 字以内的中文口播，像说给用户听。直接输出正文，温和、克制、具体。',
      },
      {
        role: 'user',
        content: `最近对话:
${conversations.map((item) => `${item.role}: ${item.content}`).join('\n')}

今日推荐:
${tracks.map((track) => `${track.title} - ${track.artist}`).join('\n')}

请说一段。`,
      },
    ])
    return { content: content.trim() || fallback, status: 'done' }
  } catch {
    return { content: fallback, status: 'done' }
  }
}
