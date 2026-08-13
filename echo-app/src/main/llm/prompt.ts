import type { LlmMessage } from './client'
import { escapePromptData, safePromptJson } from './promptData'
import type { TasteQuestion, Track } from '../../types/ipc'
import { loadConversationsForDate, loadTodayConversations } from '../db/conversations'
import { loadActiveEvents } from '../db/events'
import { getTasteProfile } from '../db/taste'
import { isExternalListeningSource, isMeaningfulSkippedReason, isMeaningfulTrackEvent, loadMeaningfulTrackEventsForDate } from '../db/tracks'
import { getYinyiRange } from '../db/yinyi'
import { getSettings } from '../db/settings'
import { readRootFile } from '../utils/paths'
import { getMostRecentSeal } from '../services/daySeal'
import { buildTodayMusicSessionSummary } from '../services/musicSession'
import { buildCurrentSceneContext, buildTodaySceneContext } from '../services/scene'
import { buildMemoryEvidencePrompt, buildOperationalTasteSummary } from '../services/memoryEvidence'
import { buildSoulPolicyPrompt } from '../skills/soul/policy'
import { memoryPolicySummary } from '../skills/memory/policy'
import type { TodayTrackEvent } from '../db/tracks'
import type { CompanionResponseBrief } from '../services/chat/companionResponse'
import { listAgentActionFactsForDate, listQualifiedActionItemIdsForDate } from '../db/agentActions'
import { compactCompanionProfile } from '../services/chat/companionStrategy'
import { createDefaultCompanionProfile, type CompanionProfile, type CompanionResponseStrategy } from '../services/chat/companionTypes'
import type { RecommendationWeatherContext } from '../services/chat/weatherRecommendation'

export interface ChatContextOptions {
  recommendationCandidates?: Track[]
  neteaseAuthRequired?: boolean
  followUpQuestion?: TasteQuestion | null
  companionResponseBrief?: CompanionResponseBrief | null
  responseStrategy?: CompanionResponseStrategy
  companionProfile?: CompanionProfile
  weatherContext?: RecommendationWeatherContext
}

function formatCandidates(tracks: Track[]): string {
  return safePromptJson(tracks.map((track, index) => ({
    index: index + 1,
    title: track.title,
    artist: track.artist,
    album: track.album,
    recommendSource: track.recommendSource,
    reason: track.reason,
  })))
}

function tasteProfileSummary(profile: ReturnType<typeof getTasteProfile>): string {
  return buildOperationalTasteSummary(profile)
}

export function yinyiRecommendationEvidence(events: TodayTrackEvent[]): TodayTrackEvent[] {
  return yinyiPositiveListeningEvidence(events).filter((track) => track.source === 'recommended_by_echo' && isMeaningfulTrackEvent(track))
}

function isPositiveYinyiPromptTrackEvent(track: Pick<TodayTrackEvent, 'source' | 'queueStatus'>): boolean {
  if (track.queueStatus === 'skipped' || track.queueStatus === 'pending') return false
  if (track.queueStatus === 'playing' || track.queueStatus === 'completed') return true
  return isExternalListeningSource(track.source)
}

export function yinyiPositiveListeningEvidence(events: TodayTrackEvent[]): TodayTrackEvent[] {
  return events.filter(isPositiveYinyiPromptTrackEvent)
}

export function yinyiDismissedTrackEvidence(events: TodayTrackEvent[]): TodayTrackEvent[] {
  return events.filter((track) => track.queueStatus === 'skipped' && isMeaningfulSkippedReason(track.queueStatusReason))
}

export function buildChatContext(userText: string, options: ChatContextOptions = {}): LlmMessage[] {
  const system = readRootFile('prompts/system.md')
  const profile = getTasteProfile()
  const history = loadTodayConversations(12)
  const contextHistory = history.slice()
  const currentText = userText.trim()
  const latest = contextHistory[contextHistory.length - 1]
  if (latest?.role === 'user' && latest.content.trim() === currentText) {
    contextHistory.pop()
  }
  const recentSeal = getMostRecentSeal()
  const candidates = options.recommendationCandidates ?? []
  const musicSession = buildTodayMusicSessionSummary()
  const sceneContext = buildCurrentSceneContext()
  const activeEvents = loadActiveEvents(8)
  const companionResponseBrief = options.companionResponseBrief ?? null
  const companionProfile = options.companionProfile ?? createDefaultCompanionProfile()
  const responseStrategy = options.responseStrategy ?? null
  const weatherContext = options.weatherContext
  const candidatesBlock = candidates.length > 0
    ? `

<recommendation_candidates>
${formatCandidates(candidates)}
</recommendation_candidates>`
    : ''
  const candidateContractBlock = candidates.length > 0
    ? `

<music_candidate_contract>
本轮有 recommendation_candidates。涉及具体推荐、点歌、开始播放、换歌时，只能点名候选里的歌名和艺人。
如果你想描述一首歌为什么适合，只能描述最终候选卡片里的歌曲。
</music_candidate_contract>`
    : `

<music_candidate_contract>
本轮没有 recommendation_candidates。可以回应用户状态、聊音乐方向、询问是否让 Echo 找歌。
涉及具体推荐、点歌、开始播放、换歌时，先不要点名具体歌名或艺人+歌名组合。
</music_candidate_contract>`
  const authBlock = options.neteaseAuthRequired
    ? `

<netease_status>
未登录或登录已过期。在没有登录之前，你拿不到任何可播放的歌。请用 Echo 的语气告诉 Ta：现在还没接上网易云，去设置页扫一下码就能开始挑歌。不要硬编候选歌名。
</netease_status>`
    : ''
  const curiosityBlock = options.followUpQuestion
    ? `

<taste_curiosity>
${safePromptJson({ question: options.followUpQuestion.content })}
</taste_curiosity>`
    : ''
  const weatherBlock = weatherContext
    ? `

<weather_context>
${safePromptJson(weatherContext)}
</weather_context>
<weather_context_contract>
weather_context 是本轮已经执行过的真实天气查询。available=true 时可以自然提到 city、condition、summary、tempC、humidity，并说明歌曲为什么适合；必须忠实保留这些事实。available=false 时只说明天气暂时不可用，继续根据用户其余条件选歌。不要自行补充天气、城市或温度。
</weather_context_contract>`
    : ''

  const messages: LlmMessage[] = [
    {
      role: 'system',
      content: `${buildSoulPolicyPrompt('chat')}

${system}

<taste_profile_summary>
${escapePromptData(tasteProfileSummary(profile) || '暂无可直接执行的口味摘要。按 memory_evidence 里的结构化证据和纠正记录判断。')}
</taste_profile_summary>

<memory_policy>
${memoryPolicySummary()}
</memory_policy>

${buildMemoryEvidencePrompt(profile)}

<companion_profile>
${safePromptJson(compactCompanionProfile(companionProfile))}
</companion_profile>
<companion_profile_contract>
这是用户对相处方式的长期倾向。置信度低时保持 Echo 默认人格；当前原话和明确纠正优先。
</companion_profile_contract>

${responseStrategy ? `<response_strategy>
${safePromptJson(responseStrategy)}
</response_strategy>
<response_strategy_contract>
这是首轮 LLM 为本轮选择的表达策略。先落实 mode 和 vulnerability，再用 warmth、playfulness、directness、initiative、verbosity 调整分寸。不要展示字段名、分数、理由码或内部机制。
playful_tease 只允许一句善意调侃，随后落到具体关心；serious_care 禁止调侃；quiet_company 少建议、少追问；practical 给一个轻量可执行动作。
</response_strategy_contract>` : ''}

<current_context>
- 当前时间:${(() => { const n = new Date(); const w = ['周日','周一','周二','周三','周四','周五','周六']; return `${n.getFullYear()}-${String(n.getMonth()+1).padStart(2,'0')}-${String(n.getDate()).padStart(2,'0')} ${String(n.getHours()).padStart(2,'0')}:${String(n.getMinutes()).padStart(2,'0')} ${w[n.getDay()]}` })()}
</current_context>${weatherBlock}${candidatesBlock}${candidateContractBlock}${authBlock}${curiosityBlock}
<active_events>
${safePromptJson(activeEvents.map((event) => ({
  content: event.content,
  kind: event.kind,
  scope: event.kind === 'context' ? 'today_context' : 'active_event',
  weight: event.weight ?? null,
  confidence: event.confidence ?? null,
  startedAt: event.startedAt ?? null,
  createdAt: event.createdAt ?? null,
})))}
</active_events>
<active_events_contract>
kind=context 表示今天仍在持续的短期状态,只能写成“今天/这会儿/刚才”的轻量观察,不能写成稳定人格、长期偏好或反复模式。
</active_events_contract>
<today_music_session>
${escapePromptData(musicSession)}
</today_music_session>
${sceneContext}
${companionResponseBrief ? `<companion_response_brief>
${safePromptJson(companionResponseBrief)}
</companion_response_brief>
<companion_response_contract>
companion_response_brief 是本轮语气建议。结合用户原话、当前场景和关系感自然表达，不要复述 tone、pattern、次数、规则或内部判断。
playful_concern 允许一句熟人式调侃，随后落到真实关心或可执行动作；serious_care 全程认真、平静。
存在 response_strategy 时，以经过用户偏好和安全校准的 response_strategy 为最终语气依据。
</companion_response_contract>` : ''}
${recentSeal ? `
<recent_day_seal>
${escapePromptData(recentSeal)}
</recent_day_seal>
<recent_day_seal_contract>
recent_day_seal 是历史日记材料,只用于理解当天余味和避免重复表达; 与 user_corrections 冲突时,以 user_corrections 为准。
</recent_day_seal_contract>` : ''}`,
    },
  ]

  for (const item of contextHistory) {
    messages.push({ role: item.role, content: item.content })
  }
  messages.push({ role: 'user', content: userText })
  return messages
}

export function buildYinyiContext(date: string, weatherSummary?: string): LlmMessage[] {
  const prompt = extractYinyiSystemPrompt(readRootFile('prompts/yinyi-writer-v5.md') || readRootFile('prompts/yinyi-writer-v4.md'))
  const profile = getTasteProfile()
  const isToday = date === new Date().toLocaleDateString('sv-SE')
  const history = loadConversationsForDate(date, 20)
  const tracks = loadMeaningfulTrackEventsForDate(date, 60)
  const qualifiedActionItemIds = listQualifiedActionItemIdsForDate(date)
  const actionFacts = listAgentActionFactsForDate(date)
  const positiveTracks = yinyiPositiveListeningEvidence(tracks).filter((track) => (
    !track.agentActionItemId || qualifiedActionItemIds.has(track.agentActionItemId)
  ))
  const dismissedTracks = yinyiDismissedTrackEvidence(tracks)
  const recommendations = positiveTracks.filter((track) => track.source === 'recommended_by_echo' && isMeaningfulTrackEvent(track))
  const activeEvents = isToday ? loadActiveEvents(8) : []
  const todaySceneContext = isToday ? buildTodaySceneContext() : ''
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
      content: `<date>${escapePromptData(date)}</date>
<weather>${escapePromptData(weatherSummary ?? '未知')}</weather>

<today_listening>
${safePromptJson(positiveTracks.map((track) => {
  const time = new Date(track.listenedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
  return {
    time,
    artist: track.artist,
    title: track.title,
    album: track.album,
    source: track.source,
    queueStatus: track.queueStatus,
    echoNote: track.echoNote,
  }
}))}
</today_listening>

<agent_action_facts>
${safePromptJson(actionFacts.map((fact) => ({
  time: fact.occurredAt ?? fact.plannedAt,
  origin: fact.origin,
  actionType: fact.actionType,
  reasonCode: fact.reasonCode,
  goalCode: fact.goalCode,
  itemType: fact.itemType,
  item: fact.itemPayload,
  outcomeType: fact.outcomeType,
  polarity: fact.polarity,
  strength: fact.strength,
})))}
这些是已执行行动与真实结果。没有 outcome 的 track item 只能说明 Echo 做过推荐，不能写成用户听过或喜欢。
</agent_action_facts>

<dismissed_tracks>
${safePromptJson(dismissedTracks.map((track) => {
  const time = new Date(track.listenedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
  return {
    time,
    artist: track.artist,
    title: track.title,
    queueStatusReason: track.queueStatusReason,
  }
}))}
</dismissed_tracks>

<today_conversations>
${safePromptJson(history.map((item) => {
  const time = item.createdAt ? new Date(item.createdAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }) : ''
  return {
    role: item.role,
    time,
    content: item.content,
  }
}))}
</today_conversations>

<today_recommendations>
${safePromptJson(recommendations.map((track) => ({
  artist: track.artist,
  title: track.title,
  recommendSource: track.recommendSource,
  reason: track.reason,
  queueStatus: track.queueStatus,
})))}
</today_recommendations>

<active_events>
${safePromptJson(activeEvents.map((event) => ({
  content: event.content,
  kind: event.kind,
  scope: event.kind === 'context' ? 'today_context' : 'active_event',
  weight: event.weight ?? null,
  confidence: event.confidence ?? null,
  startedAt: event.startedAt ?? null,
  createdAt: event.createdAt ?? null,
})))}
</active_events>
<active_events_contract>
kind=context 表示今天仍在持续的短期状态,只能写成“今天/这会儿/刚才”的轻量观察,不能写成稳定人格、长期偏好或反复模式。
</active_events_contract>

${todaySceneContext}

<taste_profile_summary>
${escapePromptData(tasteProfileSummary(profile) || '暂无可直接写入风信的口味摘要。按 memory_evidence 里的结构化证据和纠正记录判断。')}
</taste_profile_summary>

<memory_policy>
${memoryPolicySummary()}
</memory_policy>

${buildMemoryEvidencePrompt(profile)}

<recent_yinyi>
${safePromptJson(recentYinyi.map((entry) => {
  const raw = entry.content.split(/[。！？\n]/).filter(Boolean).slice(0, 2).join('。')
  const firstSentences = raw.length > 200 ? raw.slice(0, 200) : raw
  const wc = entry.content.replace(/\s+/g, '').length
  return {
    date: entry.date,
    wordCount: wc,
    preview: firstSentences,
  }
}))}
</recent_yinyi>
<recent_yinyi_contract>
recent_yinyi 是历史风信预览,只用于保持连续感和避免重复表达; 与 user_corrections 冲突时,以 user_corrections 为准。
</recent_yinyi_contract>

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
active_events 里的 context 只当作今日短期状态,不要扩写成“你一直/你总是/你其实”。
</output_contract>`,
    },
  ]
}

function extractYinyiSystemPrompt(content: string): string {
  if (!content.trim()) return content
  const userSectionIndex = content.search(/\n## User[（(]/)
  return userSectionIndex > 0 ? content.slice(0, userSectionIndex).trim() : content
}
