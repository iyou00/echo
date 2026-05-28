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
import { buildTodayMusicSessionSummary } from '../services/musicSession'
import { buildCurrentSceneContext, buildTodaySceneContext } from '../services/scene'
import { buildMemoryEvidencePrompt } from '../services/memoryEvidence'
import { buildSoulPolicyPrompt } from '../skills/soul/policy'
import { memoryPolicySummary } from '../skills/memory/policy'

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
  const musicSession = buildTodayMusicSessionSummary()
  const sceneContext = buildCurrentSceneContext()
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
  const curiosityBlock = options.followUpQuestion
    ? `

<taste_curiosity>
你最近在想：${options.followUpQuestion.content}
</taste_curiosity>`
    : ''

  const messages: LlmMessage[] = [
    {
      role: 'system',
      content: `${buildSoulPolicyPrompt('chat')}

${system}

<taste_profile_summary>
${profile?.echo_portrait ?? '用户还没有导入歌单，Echo 对 Ta 的品味只有很少线索。'}
</taste_profile_summary>

<memory_policy>
${memoryPolicySummary()}
</memory_policy>

${buildMemoryEvidencePrompt(profile)}

<current_context>
- 当前时间:${(() => { const n = new Date(); const w = ['周日','周一','周二','周三','周四','周五','周六']; return `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}-${String(n.getDate()).padStart(2,'0')} ${String(n.getHours()).padStart(2,'0')}:${String(n.getMinutes()).padStart(2,'0')} ${w[n.getDay()]}` })()}
</current_context>${candidatesBlock}${authBlock}${curiosityBlock}
<today_music_session>
${musicSession}
</today_music_session>
${sceneContext}
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

export function buildYinyiContext(date: string, weatherSummary?: string): LlmMessage[] {
  const prompt = extractYinyiSystemPrompt(readRootFile('prompts/yinyi-writer-v5.md') || readRootFile('prompts/yinyi-writer-v4.md'))
  const profile = getTasteProfile()
  const history = loadTodayConversations(20)
  const tracks = loadTodayTrackEvents(60)
  const recommendations = tracks.filter((track) => track.source === 'recommended_by_echo')
  const activeEvents = loadActiveEvents(8)
  const todaySceneContext = buildTodaySceneContext()
  const recentYinyi = getYinyiRange(7).filter((entry) => entry.date !== date)
  const settings = getSettings()
  const firstUsedAt = new Date(settings.meta.firstUsedAt)
  const daysSinceFirstUse = Number.isNaN(firstUsedAt.getTime())
    ? 1
    : Math.max(1, Math.ceil((Date.now() - firstUsedAt.getTime()) / 86400000))

  return [
    { role: 'system', content: `${buildSoulPolicyPrompt('yinyi')}\n\n${prompt}` },
    {
      role: 'user',
      content: `<date>${date}</date>
<weather>${weatherSummary ?? '未知'}</weather>

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
${recommendations.length > 0 ? recommendations.map((track) => {
  const source = track.recommendSource ? ` · ${track.recommendSource}` : ''
  const reason = track.reason ? ` · ${track.reason}` : ''
  const status = track.queueStatus ? ` · ${track.queueStatus}` : ''
  return `- ${track.artist} / ${track.title}${source}${reason}${status}`
}).join('\n') : '(暂无)'}
</today_recommendations>

<active_events>
${activeEvents.length > 0 ? activeEvents.map((event) => `- ${event.content} (kind:${event.kind}, weight:${event.weight ?? '-'}, started:${event.startedAt ?? '-'})`).join('\n') : '(暂无)'}
</active_events>

${todaySceneContext}

<taste_profile_summary>
${profile?.echo_portrait ?? '还没有完整画像。'}
</taste_profile_summary>

<memory_policy>
${memoryPolicySummary()}
</memory_policy>

${buildMemoryEvidencePrompt(profile)}

<recent_yinyi>
${recentYinyi.length > 0 ? recentYinyi.map((entry) => {
  const raw = entry.content.split(/[。！？\n]/).filter(Boolean).slice(0, 2).join('。')
  const firstSentences = raw.length > 200 ? raw.slice(0, 200) : raw
  const wc = entry.content.replace(/\s+/g, '').length
  return `${entry.date}: (${wc}字) ${firstSentences}...`
}).join('\n') : '(暂无)'}
</recent_yinyi>

<meta>
- 你已经陪 Ta ${daysSinceFirstUse} 天了
- 这是第 ${getYinyiRange(500).length + 1} 篇风信
</meta>

<output_contract>
只输出风信正文。2-4 段,自然分段即可。
不要标题,不要 bullet,不要 Markdown,不要解释。
如果今日素材很少,写短一点。
记忆只用于校准判断边界,不要复述“我记得你纠正过我”。
把单日行为写成今天的状态,把多日重复和明确反馈写成稳定倾向。
</output_contract>`,
    },
  ]
}

function extractYinyiSystemPrompt(content: string): string {
  if (!content.trim()) return content
  const userSectionIndex = content.search(/\n## User[（(]/)
  return userSectionIndex > 0 ? content.slice(0, userSectionIndex).trim() : content
}
