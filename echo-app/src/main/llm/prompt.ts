import type { LlmMessage } from './client'
import type { TasteQuestion, Track } from '../../types/ipc'
import { loadTodayConversations } from '../db/conversations'
import { loadActiveEvents } from '../db/events'
import { getTasteProfile } from '../db/taste'
import { loadTodayTrackEvents } from '../db/tracks'
import { getYinyiRange } from '../db/yinyi'
import { getSettings } from '../db/settings'
import { readRootFile } from '../utils/paths'
import { getMostRecentSeal } from '../services/daySeal'

export interface ChatContextOptions {
  recommendationCandidates?: Track[]
  neteaseAuthRequired?: boolean
  followUpQuestion?: TasteQuestion | null
}

function formatCandidates(tracks: Track[]): string {
  return tracks
    .map((track, index) => {
      const meta = [track.recommendSource, track.reason].filter(Boolean).join(' · ')
      const album = track.album ? ` / ${track.album}` : ''
      return `${index + 1}. 《${track.title}》 - ${track.artist}${album}${meta ? ` · ${meta}` : ''}`
    })
    .join('\n')
}

export function buildChatContext(userText: string, options: ChatContextOptions = {}): LlmMessage[] {
  const system = readRootFile('prompts/system.md')
  const profile = getTasteProfile()
  const history = loadTodayConversations(12)
  const recentSeal = getMostRecentSeal()
  const candidates = options.recommendationCandidates ?? []
  const followUpQuestion = options.followUpQuestion
  const candidatesBlock = candidates.length > 0
    ? `

<recommendation_candidates>
${formatCandidates(candidates)}
</recommendation_candidates>`
    : ''
  const authBlock = options.neteaseAuthRequired
    ? `

<netease_status>
未登录或登录已过期。在没有登录之前，你拿不到任何可播放的歌。请用 Echo 的语气告诉 Ta：现在还没接上网易云，去设置页扫一下码就能开始挑歌。不要硬编候选歌名。
</netease_status>`
    : ''
  const followUpBlock = followUpQuestion
    ? `

<taste_followup_question>
这轮可以自然追问一次，问题是：${followUpQuestion.content}
要求：先完整回应用户当前需求；问题只能放在末尾，像朋友顺手问一句；不要说“系统/画像/pending/问题池”；不要连续追问多个问题。
</taste_followup_question>`
    : ''

  const messages: LlmMessage[] = [
    {
      role: 'system',
      content: `${system}

<taste_profile_summary>
${profile?.echo_portrait ?? '用户还没有导入歌单，Echo 对 Ta 的品味只有很少线索。'}
</taste_profile_summary>

<current_context>
- 当前时间:${new Date().toLocaleString('zh-CN', { hour12: false })}
</current_context>${candidatesBlock}${authBlock}${followUpBlock}
${recentSeal ? `
<recent_day_seal>
${recentSeal}
</recent_day_seal>` : ''}`,
    },
  ]

  for (const item of history) {
    messages.push({ role: item.role, content: item.content })
  }
  messages.push({ role: 'user', content: userText })
  return messages
}

export function buildYinyiContext(date: string): LlmMessage[] {
  const prompt = extractYinyiSystemPrompt(readRootFile('prompts/yinyi-writer-v4.md') || readRootFile('prompts/yinyi-writer.md'))
  const profile = getTasteProfile()
  const history = loadTodayConversations(20)
  const tracks = loadTodayTrackEvents(60)
  const recommendations = tracks.filter((track) => track.source === 'recommended_by_echo')
  const activeEvents = loadActiveEvents(8)
  const recentYinyi = getYinyiRange(7).filter((entry) => entry.date !== date)
  const settings = getSettings()
  const firstUsedAt = new Date(settings.meta.firstUsedAt)
  const daysSinceFirstUse = Number.isNaN(firstUsedAt.getTime())
    ? 1
    : Math.max(1, Math.ceil((Date.now() - firstUsedAt.getTime()) / 86400000))

  return [
    { role: 'system', content: prompt },
    {
      role: 'user',
      content: `<date>${date}</date>
<weather>未知</weather>

<today_listening>
${tracks.length > 0 ? tracks.map((track) => {
  const time = new Date(track.listenedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
  const status = track.queueStatus ? ` · ${track.queueStatus}` : ''
  const note = track.echoNote ? ` · ${track.echoNote}` : ''
  return `- ${time} ${track.artist} / ${track.title}${track.album ? ` · ${track.album}` : ''}${track.source ? ` · ${track.source}` : ''}${status}${note}`
}).join('\n') : '(暂无)'}
</today_listening>

<today_conversations>
${history.length > 0 ? history.map((item) => {
  const time = item.createdAt ? new Date(item.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }) : ''
  return `${item.role}${time ? ` (${time})` : ''}: ${item.content}`
}).join('\n') : '(暂无)'}
</today_conversations>

<today_recommendations>
${recommendations.length > 0 ? recommendations.map((track) => `- ${track.artist} / ${track.title}${track.queueStatus ? ` — ${track.queueStatus}` : ''}${track.echoNote ? ` — ${track.echoNote}` : ''}`).join('\n') : '(暂无)'}
</today_recommendations>

<active_events>
${activeEvents.length > 0 ? activeEvents.map((event) => `- ${event.content} (kind:${event.kind}, weight:${event.weight ?? '-'}, started:${event.startedAt ?? '-'})`).join('\n') : '(暂无)'}
</active_events>

<taste_profile_summary>
${profile?.echo_portrait ?? '还没有完整画像。'}
</taste_profile_summary>

<recent_yinyi>
${recentYinyi.length > 0 ? recentYinyi.map((entry) => `${entry.date}: ${entry.content.slice(0, 260).replace(/\s+/g, ' ')}`).join('\n') : '(暂无)'}
</recent_yinyi>

<meta>
- 你已经陪 Ta ${daysSinceFirstUse} 天了
- 这是第 ${getYinyiRange(500).length + 1} 篇风信
</meta>

<output_contract>
只输出风信正文。2-4 段,自然分段即可。
可以使用“· · ·”做留白,但不要强制每段都用它分隔。
不要标题,不要 bullet,不要 Markdown,不要解释。
每篇至少有一句“我看到 / 我听到 / 我注意到 / 我看你...”。
每篇至少有一处“我不知道 / 我说不准 / 我猜不到 / 我没问”。
每篇至少有一处“我想到 / 我意识到 / 我才发现 / 这让我想到”。
如果今日素材很少,写短一点。
</output_contract>`,
    },
  ]
}

function extractYinyiSystemPrompt(content: string): string {
  if (!content.trim()) return content
  const userSectionIndex = content.search(/\n## User[（(]/)
  return userSectionIndex > 0 ? content.slice(0, userSectionIndex).trim() : content
}
