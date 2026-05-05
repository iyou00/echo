import type { WebContents } from 'electron'
import type { ChatMessage, SendChatResult, TasteQuestion, Track } from '../../types/ipc'
import { appendConversation, loadTodayConversations } from '../db/conversations'
import { appendRecommendedTracks } from '../db/tracks'
import { getSettings } from '../db/settings'
import { buildChatContext } from '../llm/prompt'
import { LlmError, streamChat } from '../llm/client'
import { applySignal } from './taste'
import { resolvePlayableTrack } from '../netease/music'
import { recordHealth } from './health'
import { MAX_RECOMMENDATION_COUNT, OVER_LIMIT_RECOMMENDATION_LINE, inferIntentWithLlm, NeteaseAuthRequiredError, parseRequestedTrackCount, recommendFromNetease } from './recommendation'
import { getCurrentScene } from './scene'
import {
  capturePendingQuestionAnswer,
  generateDynamicTasteQuestions,
  type PendingQuestionReplyCapture,
  pickTasteFollowUpQuestion,
  recordFollowUpQuestionAsked,
} from './tasteQuestionScheduler'
import { checkJailbreak, pickJailbreakResponse } from './safety/jailbreak-filter'
import { checkOutputSafe } from './safety/output-filter'

/**
 * LLM 偶尔会原样回吐系统注入的 XML 标签块（如 <recommendation_candidates>）。
 * 在输出用于展示 / 匹配 / 存储之前，统一清掉这些标签及内容。
 */
const SYSTEM_OUTPUT_TAGS = [
  'recommendation_candidates',
  'netease_status',
  'taste_curiosity',
  'today_music_session',
  'recent_day_seal',
  'current_context',
  'taste_profile_summary',
]

function stripSystemBlocks(text: string): string {
  let result = text
  for (const tag of SYSTEM_OUTPUT_TAGS) {
    result = result.replace(new RegExp(`<${tag}>[\\s\\S]*?<\\/${tag}>`, 'g'), '')
  }
  return result.replace(/\n{3,}/g, '\n\n').trim()
}

interface ActiveChat {
  canceled: boolean
}

const activeChats = new Set<ActiveChat>()

function friendlyError(error: unknown): string {
  if (error instanceof LlmError) {
    if (error.kind === 'config') return '我连不上自己脑子。去设置里看看 API key?'
    if (error.kind === 'auth') return '我连不上自己脑子。API key 好像过期了。'
    if (error.kind === 'rate_limit') return '我们今天聊得有点快,我这边被限速了。等一下再来。'
    return '我这会儿好像走神了,你刚说的我没接住,再说一遍?'
  }
  return '我这会儿好像走神了,你刚说的我没接住,再说一遍?'
}

/**
 * 粗筛：这一句"看起来"和音乐 / 心情 / 场景有关，才值得让 LLM 跑一次结构化意图解析。
 * 命中范围比真正的"是不是要推歌"宽一些——LLM 那一关会再判 wantsMusic。
 *
 * 包括：
 * - 显式音乐词：歌 / 听 / 曲 / 放 / 推 / 推荐 / 歌单 / music / song
 * - 节奏/氛围词：慢 / 快 / 安静 / 热闹 / 舒缓 / 燃 / 治愈 / 怀旧
 * - 心情信号：累 / 困 / 烦 / 燥 / 低落 / emo / 想哭 / 难过 / 开心 / 兴奋
 * - 场景信号：工作 / 专注 / 犯困 / 放松 / 雨天 / 烦躁 / 发呆 / 加班
 * - 语言/地区：国外 / 外国 / 英文 / 欧美 / 粤语 / 韩 / 日
 */
function looksLikeMusicRelated(text: string): boolean {
  return /推|推荐|来几首|听什么|听啥|值得听|适合听|想听|能听|放点|放首|来点|帮我|接\s*\d|首|歌|曲|歌单|music|song|慢|快|安静|热闹|循环|舒缓|缓和|轻|燃|激昂|高昂|亢奋|振奋|热血|澎湃|带感|节奏感强|节奏强|动感|鼓点|有劲|提神|治愈|怀旧|累|困|疲|睡|烦|燥|低落|emo|想哭|难过|伤心|开心|兴奋|阳光|工作|专注|放松|发呆|下班|通勤|睡前|雨|加班|一个人|独处|国外|外国|外文|英文|欧美|英语|粤语|广东|韩|kpop|日语|日本/i.test(text)
}

function looksLikeRecommendationRequest(text: string): boolean {
  return /推|推荐|来几首|听什么|听啥|值得听|适合听|想听|能听|放点|放首|来点|帮我|接\s*\d|首|歌|慢|快|安静|热闹|循环|工作|专注|激昂|高昂|亢奋|振奋|热血|澎湃|带感|节奏感强|节奏强|动感|鼓点|有劲|提神|歌单|music|song/i.test(text)
}

function trackKey(track: Track): string {
  return `${track.id ?? track.neteaseId ?? ''}::${track.title.trim().toLowerCase()}::${track.artist.trim().toLowerCase()}`
}

function attachSceneToTracks(tracks: Track[]): Track[] {
  const scene = getCurrentScene()
  if (!scene || tracks.length === 0) return tracks
  return tracks.map((track) => ({
    ...track,
    sceneKey: scene.key,
    sceneLabel: scene.label,
    sceneLine: scene.line,
    sceneSessionId: scene.id,
    reason: track.reason ?? scene.line,
    echoNote: track.echoNote ?? track.reason ?? scene.line,
  }))
}

function compactText(value: string): string {
  return value
    .toLowerCase()
    .replace(/\s+/g, '')
    .replace(/[《》"'“”·.,，。!！?？()（）:：\-_]/g, '')
}

/**
 * 从 LLM 最终文本中匹配候选里的歌名，按出现顺序去重返回。
 *
 * 匹配策略（按精度从高到低）：
 * 1. 候选 title 完全等于文本里某个《...》里的内容
 * 2. 文本里出现了候选 title 的 substring（候选叫 "Electric Feel"，LLM 写《Electric Feel》）
 * 3. 文本里某个《...》是候选 title 的简称（LLM 简化成《Electric》，候选是 "Electric Feel"）
 *    —— 简称必须 ≥ 3 字符，避免太宽匹错
 */
function pickCandidatesFromText(text: string, candidates: Track[], limit = MAX_RECOMMENDATION_COUNT): Track[] {
  if (candidates.length === 0) return []
  const compactBody = compactText(text)
  const quoted = Array.from(text.matchAll(/《([^》]+)》/g))
    .map((match) => ({ raw: match[1]?.trim() ?? '', compact: compactText(match[1] ?? ''), index: match.index ?? 0 }))
    .filter((item) => item.compact.length > 0)

  const seen = new Set<string>()
  const picked: Array<{ track: Track; order: number }> = []

  function pushIfNew(track: Track, order: number) {
    const key = trackKey(track)
    if (seen.has(key)) return
    seen.add(key)
    picked.push({ track, order })
  }

  // 1) 完全相等
  for (const candidate of candidates) {
    const compactTitle = compactText(candidate.title)
    if (!compactTitle) continue
    for (const q of quoted) {
      if (q.compact === compactTitle) {
        pushIfNew(candidate, q.index)
        break
      }
    }
  }

  // 2) 文本含候选完整 title（有可能 LLM 没用《》包起来，而是顺嘴写出）
  for (const candidate of candidates) {
    const compactTitle = compactText(candidate.title)
    if (!compactTitle || compactTitle.length < 3) continue
    const offset = compactBody.indexOf(compactTitle)
    if (offset >= 0) pushIfNew(candidate, offset + 100000)
  }

  // 3) 候选 title 含《》里的简称（双向 substring，简称要 ≥ 3 字符避免误匹）
  for (const q of quoted) {
    if (q.compact.length < 3) continue
    for (const candidate of candidates) {
      const compactTitle = compactText(candidate.title)
      if (!compactTitle || compactTitle.length < 3) continue
      if (compactTitle.includes(q.compact)) {
        pushIfNew(candidate, q.index + 200000)
        break
      }
    }
  }

  return picked.sort((a, b) => a.order - b.order).map((item) => item.track).slice(0, limit)
}

// 中文里像"换一首"、"放一首"、"先来"、"接一首"这种动作词，不是真实艺人名。
// 当正则把它们扫成 artist 时丢弃，留给 fallback 的"仅 title"路径处理。
const ARTIST_LIKE_BLACKLIST = /^(换|放|先|接|来|播|挑|推|选|给|让|帮|叫|让我|那)/

function extractMentionedTracks(content: string): Track[] {
  const tracks: Track[] = []
  const seen = new Set<string>()

  // pass 1: 严格 "艺人 + 的?《歌名》" 格式
  const pairPattern = /(?:^|[，。；、\s])([^，。；、\s《》]{1,16})的?《([^》]{1,40})》/g
  let match: RegExpExecArray | null
  while ((match = pairPattern.exec(content))) {
    const artistRaw = match[1]?.trim()
    const title = match[2]?.trim()
    if (!artistRaw || !title) continue
    if (ARTIST_LIKE_BLACKLIST.test(artistRaw)) continue
    const key = `${artistRaw}::${title}`
    if (seen.has(key)) continue
    seen.add(key)
    tracks.push({
      title,
      artist: artistRaw,
      source: 'netease',
    })
  }

  // pass 2: 无艺人，仅《歌名》——之前被黑名单过滤掉的、或前面真的没艺人名的情况都走这里。
  // resolvePlayableTrack 里 findNeteaseSong 在 artist 为空时只按 title 搜。
  const titlePattern = /《([^》]{1,40})》/g
  while ((match = titlePattern.exec(content))) {
    const title = match[1]?.trim()
    if (!title) continue
    if (tracks.some((existing) => existing.title === title)) continue
    const key = `::${title}`
    if (seen.has(key)) continue
    seen.add(key)
    tracks.push({
      title,
      artist: '',
      source: 'netease',
    })
  }

  return tracks
}

function fallbackRecommendationContent(tracks: Track[], overLimit = false): string {
  const first = tracks[0]
  if (!first) return friendlyError(new Error('empty_candidates'))
  const prefix = overLimit ? `${OVER_LIMIT_RECOMMENDATION_LINE} ` : ''
  if (tracks.length === 1) {
    return `${prefix}我这会儿说得不太顺,但歌先给你挑好了——${first.artist}的《${first.title}》。${first.reason ?? '先听它,比较稳。'}`
  }
  const names = tracks.map((track) => `${track.artist}的《${track.title}》`).join('、')
  return `${prefix}我这会儿说得不太顺,但歌先给你挑好了: ${names}。先从第一首开始。`
}

async function resolveMentionedTracks(content: string, limit = MAX_RECOMMENDATION_COUNT): Promise<Track[]> {
  const mentioned = extractMentionedTracks(content)
  const resolved: Track[] = []
  for (const item of mentioned) {
    if (resolved.length >= limit) break
    const track = await resolvePlayableTrack(item).catch(() => null)
    if (track) resolved.push(track)
  }
  return resolved
}

async function inferTasteSignal(text: string): Promise<void> {
  const patterns: Array<{ regex: RegExp; kind: string }> = [
    { regex: /(?:喜欢|爱听|最近迷上|新发现)([^,，。.!！?？]{1,24})/, kind: 'like_artist' },
    { regex: /(?:不喜欢|不爱听|腻了|少来点)([^,，。.!！?？]{1,24})/, kind: 'unlike_artist' },
    { regex: /(?:这种感觉|这个味道|这类歌)(?:再多|多来|可以多)(?:一点|点)?/, kind: 'reinforce_vibe' },
    { regex: /(?:结束了|过去了|搞定了)([^,，。.!！?？]{0,24})/, kind: 'event_ended' },
  ]

  for (const pattern of patterns) {
    const match = text.match(pattern.regex)
    if (!match) continue
    const target = (match[1] || '当前偏好').trim()
    await applySignal(pattern.kind, { target, strength: 0.25, note: text.slice(0, 120) })
    return
  }
}

function pendingAnswerFallback(capture: PendingQuestionReplyCapture): string {
  const title = typeof capture.question?.context?.title === 'string' ? capture.question.context.title.trim() : ''
  const artist = typeof capture.question?.context?.artist === 'string' ? capture.question.context.artist.trim() : ''
  const song = title ? `《${title}》` : '刚才那首'
  const focus = capture.focus || '整体感觉'
  if (capture.polarity === 'negative') {
    return `懂了，${song}这次没贴住你要的${focus}。我会把这个方向收一收，下次别再沿着它硬走。`
  }
  if (capture.polarity === 'mixed') {
    return `懂了，${song}${artist ? `这版${artist}` : ''}有一部分是对的，主要落在${focus}上。我先把这个细节记住。`
  }
  return `懂了，${song}${artist ? `这首${artist}` : ''}算挑对了，打中的是${focus}。我会把这个方向记住，先让它继续放着。`
}

async function streamPendingAnswerReply(
  userText: string,
  capture: PendingQuestionReplyCapture,
  active: ActiveChat,
  settings: ReturnType<typeof getSettings>,
  sender?: WebContents,
): Promise<string> {
  const fallback = pendingAnswerFallback(capture)
  let content = ''
  try {
    const title = typeof capture.question?.context?.title === 'string' ? capture.question.context.title.trim() : ''
    const artist = typeof capture.question?.context?.artist === 'string' ? capture.question.context.artist.trim() : ''
    for await (const chunk of streamChat(settings, [
      {
        role: 'system',
        content: `你是 Echo。用户正在回答你刚才的追问。

你要做的事:
1. 只回应这次偏好确认。
2. 不推荐新歌,不换歌,不输出歌曲卡片。
3. 把用户说的偏好自然接住,语气像朋友。
4. 40-90 个中文字。

刚才追问:${capture.question?.content ?? ''}
关联歌曲:${artist || '未知艺人'} / ${title || '刚才那首'}
判断:${capture.polarity ?? 'neutral'}
焦点:${capture.focus || '未明确'}`,
      },
      { role: 'user', content: userText },
    ])) {
      if (active.canceled) break
      content += chunk.content
      sender?.send('chat:stream:chunk', chunk.content)
    }
    return content.trim() || fallback
  } catch (error) {
    if (error instanceof LlmError) {
      recordHealth('llm', error.kind === 'auth' || error.kind === 'config' ? 'error' : 'degraded', 'Echo 连不上模型。去设置里检查 API key。', error.message)
    }
    if (content.trim()) return content.trim()
    sender?.send('chat:stream:chunk', fallback)
    return fallback
  }
}

/**
 * 取最近两轮对话拼成短上下文，给意图解析参考（"我累了"等延续性表达用得上）。
 */
function buildRecentDialogHint(): string {
  const recent = loadTodayConversations(4)
  if (recent.length === 0) return ''
  return recent.map((item) => `${item.role}: ${item.content.slice(0, 80)}`).join('\n')
}

/**
 * 当用户这一句像在问歌时，先去网易云抓候选；抓不到（cookie 过期/网络/未登录）时返回空数组并标记原因，
 * 后续 LLM 流程会读到 system prompt 里的 <netease_status> 块来引导用户。
 *
 * 流程：
 * 1. 用 LLM 把这一句翻译成结构化意图（"我累了" / "国外" / "舒缓" 这种正则覆盖不到的表达）
 * 2. LLM 说不是音乐请求 → 跳过；说是音乐请求 → 把它的意图字段融合到正则推断
 * 3. LLM 失败 / 超时 → 退回正则版 looksLikeRecommendationRequest
 *
 * `active` 让本函数在等待 LLM 解析 / 网易云召回时也能响应用户的取消。
 */
async function fetchRecommendationCandidates(
  text: string,
  active: ActiveChat,
): Promise<{ candidates: Track[]; authRequired: boolean; canceled?: boolean }> {
  if (active.canceled) return { candidates: [], authRequired: false, canceled: true }
  if (!looksLikeMusicRelated(text)) return { candidates: [], authRequired: false }

  const currentScene = getCurrentScene()
  const directSceneRequest = Boolean(currentScene && currentScene.prompt.trim() === text.trim())
  const llmIntent = directSceneRequest ? null : await inferIntentWithLlm(text, buildRecentDialogHint())
  if (active.canceled) return { candidates: [], authRequired: false, canceled: true }

  const wantsMusic = directSceneRequest || (llmIntent ? Boolean(llmIntent.wantsMusic) : looksLikeRecommendationRequest(text))
  if (!wantsMusic) return { candidates: [], authRequired: false }

  try {
    const candidates = await recommendFromNetease(text, llmIntent ?? undefined)
    if (active.canceled) return { candidates: [], authRequired: false, canceled: true }
    return { candidates, authRequired: false }
  } catch (error) {
    if (active.canceled) return { candidates: [], authRequired: false, canceled: true }
    if (error instanceof NeteaseAuthRequiredError) {
      return { candidates: [], authRequired: true }
    }
    return { candidates: [], authRequired: false }
  }
}

export async function send(text: string, sender?: WebContents): Promise<SendChatResult> {
  const trimmed = text.trim()
  if (!trimmed) throw new Error('消息不能为空')
  if (trimmed.length > 2000) throw new Error('这么长我得分两口气听,你要不分两次发?')

  appendConversation('user', trimmed)

  const jailbreak = checkJailbreak(trimmed)
  if (jailbreak.isJailbreak) {
    const response = pickJailbreakResponse()
    const message = appendConversation('assistant', response)
    sender?.send('chat:stream:end', { message, tracks: [], durationMs: 0 })
    return { message, tracks: [] }
  }

  await inferTasteSignal(trimmed)
  const pendingReply = await capturePendingQuestionAnswer(trimmed)

  const active: ActiveChat = { canceled: false }
  activeChats.add(active)
  const settings = getSettings()
  if (pendingReply.action === 'answer_only') {
    const started = Date.now()
    let content = await streamPendingAnswerReply(trimmed, pendingReply, active, settings, sender)
    activeChats.delete(active)
    content = stripSystemBlocks(content)
    if (!checkOutputSafe(content).safe) content = pickJailbreakResponse()
    const message = appendConversation('assistant', content.trim(), [])
    sender?.send('chat:stream:end', { message, tracks: [], durationMs: Date.now() - started })
    return { message, tracks: [] }
  }

  const recommendationQuery = pendingReply.action === 'extend_recommendation' && pendingReply.recommendationText
    ? pendingReply.recommendationText
    : trimmed
  const requested = parseRequestedTrackCount(trimmed)
  const { candidates, authRequired, canceled: candidatesCanceled } = await fetchRecommendationCandidates(recommendationQuery, active)
  if (candidatesCanceled || active.canceled) {
    activeChats.delete(active)
    const message = appendConversation('assistant', '行,我先停在这里。')
    sender?.send('chat:stream:end', { message, tracks: [], durationMs: 0 })
    return { message, tracks: [] }
  }
  const tracks: Track[] = []
  const started = Date.now()
  let content = ''
  let followUpQuestion: TasteQuestion | null = null

  try {
    generateDynamicTasteQuestions(trimmed, candidates)
    followUpQuestion = pendingReply.action !== 'none' ? null : pickTasteFollowUpQuestion(trimmed, candidates)
    const messages = buildChatContext(trimmed, {
      recommendationCandidates: candidates,
      neteaseAuthRequired: authRequired,
      followUpQuestion,
    })
    for await (const chunk of streamChat(settings, messages)) {
      if (active.canceled) break
      content += chunk.content
      sender?.send('chat:stream:chunk', chunk.content)
    }

    if (active.canceled) {
      content = content.trim() || '行,我先停在这里。'
    }

    content = stripSystemBlocks(content)

    if (!checkOutputSafe(content).safe) content = pickJailbreakResponse()

    if (candidates.length > 0) {
      const picked = pickCandidatesFromText(content, candidates, requested.targetCount)
      if (picked.length > 0) tracks.push(...picked)
      else if (candidates.length === 1) tracks.push(candidates[0])
      if (requested.explicit && tracks.length < requested.targetCount) {
        const existing = new Set(tracks.map(trackKey))
        tracks.push(...candidates.filter((track) => !existing.has(trackKey(track))).slice(0, requested.targetCount - tracks.length))
      }
    }

    if (tracks.length === 0 && !authRequired) {
      tracks.push(...await resolveMentionedTracks(content, requested.targetCount))
    }

    if (!content.trim()) {
      content = tracks.length > 0 ? '我先给你挑这首。' : '(没说话——我先想想,你接着说)'
    }
    if (requested.overLimit && tracks.length > 0 && !content.includes(OVER_LIMIT_RECOMMENDATION_LINE)) {
      content = `${OVER_LIMIT_RECOMMENDATION_LINE}${content ? ` ${content}` : ''}`
    }
  } catch (error) {
    followUpQuestion = null
    if (error instanceof LlmError) {
      recordHealth('llm', error.kind === 'auth' || error.kind === 'config' ? 'error' : 'degraded', 'Echo 连不上模型。去设置里检查 API key。', error.message)
    }
    if (candidates.length > 0) {
      tracks.push(...candidates.slice(0, requested.targetCount))
      content = fallbackRecommendationContent(tracks, requested.overLimit)
    } else {
      content = friendlyError(error)
    }
    sender?.send('chat:stream:chunk', content)
  } finally {
    activeChats.delete(active)
  }

  const finalTracks = attachSceneToTracks(tracks)
  appendRecommendedTracks(finalTracks)
  const message = appendConversation('assistant', content.trim(), finalTracks)
  recordFollowUpQuestionAsked(followUpQuestion, message.id)
  const hints = authRequired ? { neteaseAuthRequired: true } : undefined
  sender?.send('chat:stream:end', { message, tracks: finalTracks, durationMs: Date.now() - started, hints })

  return { message, tracks: finalTracks, hints }
}

export function loadRecent(limit = 30): ChatMessage[] {
  return loadTodayConversations(limit)
}

export function cancel(): { ok: boolean } {
  for (const active of Array.from(activeChats)) active.canceled = true
  return { ok: true }
}
