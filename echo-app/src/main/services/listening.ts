import type { Track } from '../../types/ipc'
import { loadRecentConversations } from '../db/conversations'
import { appendRecommendedTracks } from '../db/tracks'
import { getAllImportedTracks } from '../db/playlists'
import { getTasteProfile } from '../db/taste'
import { getSettings } from '../db/settings'
import { completeChat, LlmError } from '../llm/client'
import { filterPlayableTracks } from '../netease/music'
import { synthesize } from '../tts/client'
import { readRootFile } from '../utils/paths'
import { getMostRecentSeal } from './daySeal'
import { getWeather } from '../weather/client'
import { recordHealth } from './health'
import { recommendFromNetease } from './recommendation'

interface ListeningText {
  text?: string
  selectedIndex?: number
}

const recentScenarios: string[] = []
const recentTrackKeys: string[] = []

function trackKey(track: Track): string {
  return String(track.neteaseId ?? track.id ?? `${track.title}::${track.artist}`).toLowerCase()
}

function rememberScenario(text: string, track: Track | null) {
  recentScenarios.unshift(text)
  recentScenarios.splice(8)
  if (track) {
    recentTrackKeys.unshift(trackKey(track))
    recentTrackKeys.splice(12)
  }
}

function shuffled<T>(items: T[]): T[] {
  const copy = [...items]
  for (let index = copy.length - 1; index > 0; index -= 1) {
    const swap = Math.floor(Math.random() * (index + 1))
    ;[copy[index], copy[swap]] = [copy[swap], copy[index]]
  }
  return copy
}

function parseJsonObject(content: string): ListeningText | null {
  const match = content.match(/\{[\s\S]*\}/)
  if (!match) return null
  try {
    return JSON.parse(match[0]) as ListeningText
  } catch {
    return null
  }
}

function normalizeText(content: string): string {
  return content
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```[a-z]*|```/gi, ''))
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^>\s*/, ''))
    .filter(Boolean)
    .join('')
    .replace(/^["“”'‘’]+|["“”'‘’]+$/g, '')
    .replace(/\s+/g, ' ')
    .trim()
}

function limitText(text: string): string {
  const trimmed = normalizeText(text)
  if (trimmed.length <= 220) return trimmed
  const sliced = trimmed.slice(0, 220)
  const lastStop = Math.max(sliced.lastIndexOf('。'), sliced.lastIndexOf('，'), sliced.lastIndexOf('、'), sliced.lastIndexOf('——'))
  return sliced.slice(0, lastStop > 120 ? lastStop + 1 : 220).trim()
}

function compactText(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[《》"'“”‘’·.,，。!！?？()（）\-_:：]/g, '')
}

function quotedTitles(text: string): string[] {
  return Array.from(text.matchAll(/《([^》]+)》/g))
    .map((match) => match[1]?.trim())
    .filter((title): title is string => Boolean(title))
}

function textMentionsTrack(text: string, track: Track | null): boolean {
  if (!track) return false
  const compactBody = compactText(text)
  const compactTitle = compactText(track.title)
  if (!compactTitle) return false
  return compactBody.includes(compactTitle)
}

function pickTrackFromText(text: string, candidates: Track[], selectedIndex?: number): Track | null {
  const quoted = quotedTitles(text).map(compactText)
  for (const title of quoted) {
    const matched = candidates.find((track) => compactText(track.title) === title)
    if (matched) return matched
  }

  const index = Number(selectedIndex ?? 0)
  if (Number.isFinite(index) && index >= 1) {
    return candidates[Math.max(0, Math.min(candidates.length - 1, index - 1))] ?? null
  }

  const compactBody = compactText(text)
  return candidates.find((track) => compactBody.includes(compactText(track.title))) ?? candidates[0] ?? null
}

function alignTextToTrack(text: string, track: Track | null): string {
  if (!track || textMentionsTrack(text, track)) return text
  const quoted = quotedTitles(text)
  if (quoted.length > 0) return fallbackText(track)
  return `${text}我给你接上${track.artist}的《${track.title}》。`
}

function formatConversationTime(createdAt?: string) {
  if (!createdAt) return ''
  const date = new Date(createdAt)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
}

function fallbackText(track: Track | null): string {
  const hour = new Date().getHours()
  const time = hour < 11 ? '早上' : hour < 18 ? '下午' : '晚上'
  if (!track) return `${time}这个点,我先陪你安静一会儿。我现在还没摸清你的歌单,所以先不硬推歌。等你导入更多歌以后,我会把这一刻接到一首真的合适的歌上。`
  const variants = [
    `${time}这个点,我猜你可能只是想让旁边有点声音。我也没打算讲大道理,就给你接一首${track.artist}的《${track.title}》。它不会太抢,先垫着,你手上的事可以慢慢做。`,
    `我刚刚在想,你这会儿点回声,大概不是想听我分析什么,就是想有个人先开个头。那我给你放${track.artist}的《${track.title}》,旋律先进来,你跟着缓一会儿。`,
    `现在这个点挺适合换一口气。你不用马上进入什么状态,先听${track.artist}的《${track.title}》。这首入口轻,能把刚才那点绷着的感觉慢慢放下来。`,
  ]
  return variants[Math.floor(Math.random() * variants.length)]
}

async function getFallbackCandidates(): Promise<Track[]> {
  const imported = getAllImportedTracks()
  const fresh = imported.filter((track) => !recentTrackKeys.includes(trackKey(track)))
  const pool = fresh.length >= 8 ? fresh : imported
  const candidates = shuffled(pool).slice(0, 24)
  return filterPlayableTracks(candidates, 5)
}

async function getCandidates(): Promise<Track[]> {
  const fromNetease = await recommendFromNetease('回声里随机给我一首适合现在听的歌', undefined, { ignoreScene: true }).catch(() => [])
  if (fromNetease.length > 0) return fromNetease.filter((track) => !recentTrackKeys.includes(trackKey(track))).slice(0, 5)
  return getFallbackCandidates()
}

function buildContext(input: {
  generatedAt: string
  weatherSummary?: string
  conversations: ReturnType<typeof loadRecentConversations>
  seal: string
  profile: ReturnType<typeof getTasteProfile>
  candidates: Track[]
}) {
  const currentTime = new Date(input.generatedAt).toLocaleString('zh-CN', {
    hour12: false,
    weekday: 'long',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
  const recent = input.conversations.length > 0
    ? input.conversations.map((item) => `- ${item.role}${formatConversationTime(item.createdAt) ? ` (${formatConversationTime(item.createdAt)})` : ''}: ${item.content}`).join('\n')
    : '(暂无)'
  const recentSegments = recentScenarios.length > 0
    ? recentScenarios.map((item, index) => `- S${index + 1}: ${item}`).join('\n')
    : '(暂无)'
  const tasteSignals = input.profile
    ? [
      input.profile.echo_portrait,
      input.profile.moods?.slice(0, 4).map((item) => `${item.tag} ${Math.round(item.frequency * 100)}%`).join(' / '),
      input.profile.artists?.slice(0, 5).map((item) => `${item.name} affinity ${Math.round(item.affinity * 100)}%`).join(' / '),
    ].filter(Boolean).join('\n')
    : '(暂无)'

  return `<current_time>${currentTime}</current_time>

<weather>${input.weatherSummary ?? '未知'}</weather>

<recent_conversations>
${recent}
</recent_conversations>

<yesterday_seal_summary>
${input.seal ? input.seal.slice(0, 900) : '(暂无)'}
</yesterday_seal_summary>

<taste_signals_recent>
${tasteSignals}
</taste_signals_recent>

<recent_listening_segments>
${recentSegments}
</recent_listening_segments>

<candidates>
${input.candidates.map((item, index) => `- C${index + 1}: ${item.artist} / ${item.title}${item.album ? ` (${item.album})` : ''}`).join('\n')}
</candidates>

<output_contract>
只输出最终要朗读的一段话。不要 JSON,不要 Markdown,不要编号,不要解释。
必须从 candidates 里选一首,并在文案里写成《歌名》。
</output_contract>`
}

export async function generateListeningSegment(): Promise<{ text: string; track: Track | null; audioUrl?: string; error?: string; generatedAt: string }> {
  const generatedAt = new Date().toISOString()
  const settings = getSettings()
  const conversations = loadRecentConversations(5)
  const seal = getMostRecentSeal()
  const profile = getTasteProfile()
  const weather = await getWeather(settings.user.city)
  const candidates = await getCandidates()
  const prompt = readRootFile('prompts/scenario-100.md')

  let text = fallbackText(candidates[0] ?? null)
  let track: Track | null = candidates[0] ?? null

  if (candidates.length > 0) {
    try {
      const response = await completeChat(settings, [
        { role: 'system', content: prompt },
        {
          role: 'user',
          content: buildContext({ generatedAt, weatherSummary: weather?.summary, conversations, seal, profile, candidates }),
        },
      ], { temperature: 0.85 })
      const parsed = parseJsonObject(response)
      const nextText = parsed?.text ? limitText(parsed.text) : limitText(response)
      if (nextText) text = nextText
      track = pickTrackFromText(text, candidates, parsed?.selectedIndex)
      text = alignTextToTrack(text, track)
    } catch (error) {
      if (error instanceof LlmError) {
        recordHealth('llm', error.kind === 'auth' || error.kind === 'config' ? 'error' : 'degraded', 'Echo 连不上模型。去设置里检查 API key。', error.message)
      }
      text = fallbackText(track)
    }
  }

  const audio = await synthesize(text)
  rememberScenario(text, track)
  if (track) {
    appendRecommendedTracks([{
      ...track,
      reason: track.reason ?? '回声里 Echo 给你接上的这首。',
    }])
  }
  if (audio.ok && audio.audioUrl) {
    return { text, track, audioUrl: audio.audioUrl, generatedAt }
  }
  return { text, track, error: audio.error?.message ?? 'Echo 现在说不出话来', generatedAt }
}
