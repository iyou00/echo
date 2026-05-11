import type { Track } from '../../types/ipc'
import { loadRecentConversations } from '../db/conversations'
import { appendRecommendedTracks, loadListenedTracksSince, loadRecentRecommendedTracks } from '../db/tracks'
import { getAllImportedTracks } from '../db/playlists'
import { getTasteProfile } from '../db/taste'
import { getSettings } from '../db/settings'
import { getTrackSemantic } from '../db/semantics'
import { completeChat, LlmError } from '../llm/client'
import { filterPlayableTracks } from '../netease/music'
import { synthesize } from '../tts/client'
import { readRootFile } from '../utils/paths'
import { getMostRecentSeal } from './daySeal'
import { getWeather } from '../weather/client'
import { recordHealth } from './health'
import { recommendFromNetease } from './recommendation'
import { inferTrackSemanticFallback } from './semantics'

interface ListeningText {
  text?: string
  selectedIndex?: number
}

const recentScenarios: string[] = []
const recentTrackKeys: string[] = []

interface SegmentSemantic {
  moods: string[]
  genres: string[]
  energy: number
  tempo: string
  artist: string
}

const recentSegmentSemantics: SegmentSemantic[] = []
const recentArtists: string[] = []

let lastConversationFingerprint = ''

function primaryArtist(artist: string): string {
  return artist.split(/[/、,，&＋+]| feat\.?| ft\.?| and /i)[0]?.trim().toLowerCase() ?? artist.trim().toLowerCase()
}

function trackKey(track: Track): string {
  return String(track.neteaseId ?? track.id ?? `${track.title}::${track.artist}`).toLowerCase()
}

function nameTrackKey(track: Track): string {
  return `name:${compactText(track.title)}::${compactText(track.artist)}`
}

function trackIdentityKeys(track: Track): string[] {
  const keys = new Set<string>()
  const neteaseId = String(track.neteaseId ?? '').trim()
  const id = String(track.id ?? '').trim()
  if (neteaseId) keys.add(`netease:${neteaseId}`)
  if (id) keys.add(`id:${id}`)
  keys.add(nameTrackKey(track))
  keys.add(trackKey(track))
  return Array.from(keys).filter(Boolean)
}

function trackIdentitySet(tracks: Track[]): Set<string> {
  const keys = new Set<string>()
  for (const track of tracks) {
    for (const key of trackIdentityKeys(track)) keys.add(key)
  }
  return keys
}

function hasTrackIdentity(keys: Set<string>, track: Track): boolean {
  return trackIdentityKeys(track).some((key) => keys.has(key))
}

function recentBlockedKeys(): Set<string> {
  const keys = trackIdentitySet([
    ...loadRecentRecommendedTracks(120),
    ...loadListenedTracksSince(24, 500),
  ])
  for (const key of recentTrackKeys) keys.add(key)
  return keys
}

function semanticForTrack(track: Track): SegmentSemantic {
  const semantic = track.semantic ?? getTrackSemantic(track) ?? inferTrackSemanticFallback(track)
  return {
    moods: semantic.moods,
    genres: semantic.genres,
    energy: semantic.energy,
    tempo: semantic.tempo,
    artist: track.artist.split(/[/、,，&＋+]| feat\.?| ft\.?| and /i)[0]?.trim() ?? track.artist,
  }
}

function rememberScenario(text: string, track: Track | null) {
  recentScenarios.unshift(text)
  recentScenarios.splice(8)
  if (track) {
    recentTrackKeys.unshift(...trackIdentityKeys(track))
    recentTrackKeys.splice(36)
    recentSegmentSemantics.unshift(semanticForTrack(track))
    recentSegmentSemantics.splice(8)
    recentArtists.unshift(primaryArtist(track.artist))
    recentArtists.splice(8)
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

function artistParts(artist: string): string[] {
  return artist
    .split(/[/、,，&＋+]| feat\.?| ft\.?| and /i)
    .map(compactText)
    .filter((item) => item.length >= 2)
}

function songLabel(track: Track): string {
  return `${track.artist}的《${track.title}》`
}

function replaceSongSentence(text: string, track: Track): string {
  const next = text.replace(/[^。！？!?\n]*《[^》]+》[^。！？!?\n]*(?:[。！？!?]|$)/, `我给你接上${songLabel(track)}。`)
  return next === text ? `${text.replace(/[。！？!?]*$/, '').trim()}。我给你接上${songLabel(track)}。` : next.trim()
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
  if (!compactBody.includes(compactTitle)) return false
  const artists = artistParts(track.artist)
  return artists.length === 0 || artists.some((artist) => compactBody.includes(artist))
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
  let aligned = text
  if (quoted.length > 0) {
    for (const title of quoted) {
      aligned = aligned.split(`《${title}》`).join(`《${track.title}》`)
    }
    if (textMentionsTrack(aligned, track)) return aligned
    return replaceSongSentence(aligned, track)
  }
  const trimmed = aligned.replace(/[。！？!?]*$/, '').trim()
  return `${trimmed}。我给你接上${songLabel(track)}。`
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
  if (!track) return `${time}好。我先不急着推歌，你先听点什么，或者跟我聊两句，我慢慢跟上你的节奏。`
  const profile = getTasteProfile()
  const topArtist = profile?.artists?.[0]?.name
  const variants = [
    `${time}这个点,我猜你可能只是想让旁边有点声音。我也没打算讲大道理,就给你接一首${track.artist}的《${track.title}》。它不会太抢,先垫着,你手上的事可以慢慢做。`,
    `我刚刚在想,你这会儿点回声,大概不是想听我分析什么,就是想有个人先开个头。那我给你放${track.artist}的《${track.title}》,旋律先进来,你跟着缓一会儿。`,
    `现在这个点挺适合换一口气。你不用马上进入什么状态,先听${track.artist}的《${track.title}》。这首入口轻,能把刚才那点绷着的感觉慢慢放下来。`,
    `${time}了,${topArtist ? `你之前听过不少${topArtist}的歌,` : ''}我猜这会儿需要的是一首不那么抢的歌。${track.artist}的《${track.title}》刚好,先让它走一遍。`,
    `这会儿没什么特别要做的对吧。我给你放${track.artist}的《${track.title}》,旋律进去以后,手上的事可以慢一点做。`,
  ]
  return variants[Math.floor(Math.random() * variants.length)]
}

async function getFallbackCandidates(): Promise<Track[]> {
  const imported = getAllImportedTracks()
  const blocked = recentBlockedKeys()
  const fresh = imported.filter((track) => !hasTrackIdentity(blocked, track))
  let pool = fresh
  if (fresh.length < 8 && imported.length > fresh.length) {
    const hardBlocked = trackIdentitySet(loadListenedTracksSince(2, 200))
    const relaxed = imported.filter((track) => !hasTrackIdentity(hardBlocked, track))
    pool = relaxed.length >= fresh.length ? relaxed : imported
  }
  const candidates = shuffled(pool).slice(0, 24)
  return filterPlayableTracks(candidates, 5)
}

function diversifyCandidatesByArtist(candidates: Track[], maxPerArtist: number): Track[] {
  const artistCounts = new Map<string, number>()
  return candidates.filter((track) => {
    const key = primaryArtist(track.artist)
    const count = artistCounts.get(key) ?? 0
    if (count >= maxPerArtist) return false
    artistCounts.set(key, count + 1)
    return true
  })
}

function uniqueTracksByKey(tracks: Track[]): Track[] {
  const seen = new Set<string>()
  return tracks.filter((track) => {
    const key = trackKey(track)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

const DIVERSITY_DIMENSIONS = [
  { label: '热烈', keywords: ['热烈', '激昂'] },
  { label: '轻快', keywords: ['轻快', '清新'] },
  { label: '放松', keywords: ['放松', '舒缓'] },
  { label: '治愈', keywords: ['治愈', '暖心'] },
  { label: '怀旧', keywords: ['怀旧', '经典'] },
  { label: '孤独', keywords: ['孤独', '安静'] },
  { label: '清醒', keywords: ['清醒', '提神'] },
  { label: '松弛', keywords: ['松弛', '慵懒'] },
]

function pickUncoveredDimension(): string {
  const coveredMoods = new Set(recentSegmentSemantics.flatMap((s) => s.moods))
  const uncovered = DIVERSITY_DIMENSIONS.filter((d) => !d.keywords.some((k) => coveredMoods.has(k)))
  const pool = uncovered.length > 0 ? uncovered : DIVERSITY_DIMENSIONS
  const pick = pool[Math.floor(Math.random() * pool.length)]
  return pick.keywords[Math.floor(Math.random() * pick.keywords.length)]
}

async function getCandidates(continuation?: boolean): Promise<Track[]> {
  const blocked = recentBlockedKeys()
  const query = continuation && recentSegmentSemantics.length > 0
    ? `回声里给我一首${pickUncoveredDimension()}的、适合现在听的歌`
    : '回声里随机给我一首适合现在听的歌'
  const fromNetease = await recommendFromNetease(query, undefined, { ignoreScene: true, candidateCount: 8 }).catch(() => [])
  const fresh = fromNetease.filter((track) => !hasTrackIdentity(blocked, track))
  const diversified = diversifyCandidatesByArtist(fresh, 2)
  if (diversified.length >= 3) return diversified.slice(0, 5)
  const fallback = await getFallbackCandidates()
  const mixed = diversifyCandidatesByArtist(uniqueTracksByKey([...diversified, ...fallback.filter((t) => !hasTrackIdentity(blocked, t))]), 2)
  return mixed.slice(0, 5)
}

const WEEKDAYS = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

function buildContext(input: {
  generatedAt: string
  weatherSummary?: string
  conversations: ReturnType<typeof loadRecentConversations>
  seal: string
  profile: ReturnType<typeof getTasteProfile>
  candidates: Track[]
  continuation?: boolean
}) {
  const now = new Date(input.generatedAt)
  const y = now.getFullYear()
  const m = String(now.getMonth() + 1).padStart(2, '0')
  const d = String(now.getDate()).padStart(2, '0')
  const hh = String(now.getHours()).padStart(2, '0')
  const mm = String(now.getMinutes()).padStart(2, '0')
  const weekday = WEEKDAYS[now.getDay()]
  const currentTime = `${y}-${m}-${d} ${hh}:${mm} ${weekday}`
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

  const continuationBlock = input.continuation && recentScenarios.length > 0
    ? `

<continuation>
你正在连续说话。${recentScenarios.slice(0, 3).map((_, index) => `S${index + 1}`).join('、')} 是你刚刚说的段落,接着说。

你最近几次的开头分别是:
${recentScenarios.slice(0, 3).map((item, index) => `- S${index + 1}: "${item.slice(0, 40)}${item.length > 40 ? '...' : ''}"`).join('\n')}
${recentSegmentSemantics.length > 0 ? `
最近几段的音乐特征:
${recentSegmentSemantics.slice(0, 3).map((s, index) => `- S${index + 1}: ${s.artist} 气质[${s.moods.slice(0, 3).join('/')}] 流派[${s.genres.slice(0, 2).join('/')}] 节奏[${s.tempo}] 能量[${s.energy > 0.65 ? '高' : s.energy > 0.4 ? '中' : '低'}]`).join('\n')}

你已经覆盖了这些音乐方向。这次从 candidates 里选一首气质或流派不同的歌。
如果前几首偏安静,这次挑一首节奏感强一点的;如果前几首偏热烈,这次挑一首放松的。` : ''}
${recentArtists.length > 0 ? `最近推荐的歌手: ${[...new Set(recentArtists.slice(0, 3))].join('、')}
${new Set(recentArtists.slice(0, 3)).size < 3 ? '你已经连续推荐了同一个歌手。这次必须从 candidates 里选一首不同歌手的。' : '这次换一个歌手。'}` : ''}

这些开头方式已经用过了。这次必须换一个完全不同的切入点、不同的句式。
可以换个话题,可以跑题,可以回前面的话题但用新的角度。
</continuation>`
    : ''

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
</recent_listening_segments>${continuationBlock}

<candidates>
${input.candidates.map((item, index) => `- C${index + 1}: ${item.artist} / ${item.title}${item.album ? ` (${item.album})` : ''}`).join('\n')}
</candidates>

<output_contract>
只输出最终要朗读的一段话。不要 JSON,不要 Markdown,不要编号,不要解释。
必须从 candidates 里选一首,并在文案里写成《歌名》。
</output_contract>`
}

export async function generateListeningSegment(options?: { continuation?: boolean }): Promise<{ text: string; track: Track | null; audioUrl?: string; error?: string; generatedAt: string }> {
  const generatedAt = new Date().toISOString()
  const settings = getSettings()
  const limit = options?.continuation ? 2 : 5
  const conversations = loadRecentConversations(limit)
  if (options?.continuation && conversations.length > 0) {
    const fp = String(conversations[conversations.length - 1].id ?? '')
    if (fp === lastConversationFingerprint) conversations.length = 0
    lastConversationFingerprint = fp
  } else if (conversations.length > 0) {
    lastConversationFingerprint = String(conversations[conversations.length - 1].id ?? '')
  }
  const seal = getMostRecentSeal()
  const profile = getTasteProfile()
  const weather = await getWeather(settings.user.city)
  const candidates = await getCandidates(options?.continuation)
  const prompt = readRootFile('prompts/scenario-100.md')

  let text = fallbackText(candidates[0] ?? null)
  let track: Track | null = candidates[0] ?? null

  if (candidates.length > 0) {
    try {
      const response = await completeChat(settings, [
        { role: 'system', content: prompt },
        {
          role: 'user',
          content: buildContext({ generatedAt, weatherSummary: weather?.summary, conversations, seal, profile, candidates, continuation: options?.continuation }),
        },
      ], { temperature: options?.continuation ? 0.95 : 0.85 })
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
    track = {
      ...track,
      sourceContext: 'voice',
      reason: track.reason ?? '回声里 Echo 给你接上的这首。',
    }
    appendRecommendedTracks([track])
  }
  if (audio.ok && audio.audioUrl) {
    return { text, track, audioUrl: audio.audioUrl, generatedAt }
  }
  return { text, track, error: audio.error?.message ?? 'Echo 现在说不出话来', generatedAt }
}

export const listeningTestHelpers = {
  alignTextToTrack,
}
