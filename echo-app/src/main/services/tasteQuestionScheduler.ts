import type { TasteQuestion, Track } from '../../types/ipc'
import {
  answerTasteQuestion,
  countTasteQuestionsAskedToday,
  getLatestQuestionPromptConversationId,
  countUserMessagesAfterConversation,
  getLatestAskedPendingQuestion,
  getPendingQuestions,
  hasTasteQuestionBeenAsked,
  hasRecentTasteQuestionForTrack,
  markTasteQuestionAsked,
  addTasteQuestion,
} from '../db/taste'
import { listTrackFeedback } from '../db/feedback'
import { applyMemorySignal } from './memoryPolicy'
import { getSettings } from '../db/settings'
import { completeChat } from '../llm/client'
import {
  buildRecommendationTextFromAnswer,
  detectPendingReplyFocus,
  detectPendingReplyPolarity,
  parsePendingReplyAction,
  questionTrackLabel,
  ruleClassifyPendingReply,
  type PendingQuestionReplyAction,
  type PendingQuestionReplyCapture,
} from '../skills/intent/pendingReply'

const DAILY_QUESTION_LIMIT = 3
const MIN_USER_TURNS_AFTER_QUESTION = 2
const FOLLOW_UP_CLASSIFIER_TIMEOUT_MS = 2500
const RECOMMENDATION_FOLLOW_UP_COOLDOWN_DAYS = 7
const RECOMMENDATION_FOLLOW_UP_EXPIRES_MS = 24 * 60 * 60 * 1000

export type { PendingQuestionReplyAction, PendingQuestionReplyCapture } from '../skills/intent/pendingReply'

function stableIndex(value: string, modulo: number): number {
  let hash = 0
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) >>> 0
  }
  return modulo > 0 ? hash % modulo : 0
}

function buildRecommendationFollowUpQuestion(track: Track): string {
  const variants = [
    `刚才这首《${track.title}》，你更被旋律、人声，还是整体氛围打到？`,
    `我想记一下，《${track.title}》对你来说更像是旋律对了，还是声音和氛围对了？`,
    `这首《${track.title}》如果算贴近，你觉得主要贴在哪：人声、旋律，还是那种感觉？`,
    `《${track.title}》这首我想确认一下：它打中你的是唱的人、旋律，还是整体气质？`,
  ]
  return variants[stableIndex(`${track.title}::${track.artist}`, variants.length)]
}

function recommendationFollowUpExpiresAt(): string {
  return new Date(Date.now() + RECOMMENDATION_FOLLOW_UP_EXPIRES_MS).toISOString().slice(0, 19).replace('T', ' ')
}

function compact(value: string): string {
  return value.toLowerCase().replace(/\s+/g, '').replace(/[《》"'“”·.,，。!！?？()（）:：\-_]/g, '')
}

function contextText(question: TasteQuestion): string {
  return [
    question.kind,
    question.content,
    ...Object.values(question.context ?? {}).map((value) => String(value)),
  ].join(' ')
}

function scoreQuestion(question: TasteQuestion, userText: string, tracks: Track[]): number {
  const haystack = compact(`${userText} ${tracks.map((track) => `${track.title} ${track.artist} ${track.reason ?? ''}`).join(' ')}`)
  const source = compact(contextText(question))
  let score = 0
  for (const token of source.match(/[\u4e00-\u9fa5a-zA-Z0-9]{2,}/g) ?? []) {
    if (token.length >= 2 && haystack.includes(compact(token))) score += token.length >= 4 ? 3 : 1
  }
  for (const track of tracks) {
    if (source.includes(compact(track.artist))) score += 4
    if (source.includes(compact(track.title))) score += 5
  }
  if (/喜欢|不喜欢|偏好|怎么形容|哪种|为什么|变化|最近/.test(question.content) && /喜欢|不喜欢|感觉|想听|来|推|最近|这首|这种|那种|歌|声音|氛围/.test(userText)) {
    score += 1
  }
  return score
}

function canAskAfterLatestQuestion(): boolean {
  const latestConversationId = getLatestQuestionPromptConversationId()
  if (!latestConversationId) return true
  return countUserMessagesAfterConversation(latestConversationId) >= MIN_USER_TURNS_AFTER_QUESTION
}

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms)
    promise
      .then((value) => {
        clearTimeout(timer)
        resolve(value)
      })
      .catch(() => {
        clearTimeout(timer)
        resolve(null)
      })
  })
}

function assertTasteQuestionActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('任务已取消', 'AbortError')
}

async function llmClassifyPendingReply(text: string, question: TasteQuestion, signal?: AbortSignal): Promise<PendingQuestionReplyCapture['action'] | null> {
  assertTasteQuestionActive(signal)
  const settings = getSettings()
  if (!settings.llm.baseUrl || !settings.llm.apiKey || !settings.llm.model) return null
  const response = await withTimeout(
    completeChat(settings, [
      {
        role: 'system',
        content: `你是 Echo 的追问回答分类器。只输出 JSON,不要解释。

分类只允许三种:
- answer_only: 用户在回答 Echo 刚才的问题,表达认可、否定、补充偏好、解释原因。此时不要换歌。
- extend_recommendation: 用户回答后明确要求继续找歌,例如再来一首、类似的继续、按这个方向多来几首、换一首。
- none: 用户开始了一个新请求或普通闲聊,交给主对话处理。

边界:
1. "我觉得这首歌的氛围可以"、"对,就是这个感觉"、"人声更打动我" → answer_only。
2. "这种再来一首"、"按这个氛围继续"、"换一首类似的" → extend_recommendation。
3. "来一首粤语慢歌"、"推荐五首欢快的"、"魔力红的歌来一首" → none。
4. 如果 Echo 刚才的问题本身是在问是否换歌、继续类似方向、再接一首,用户回答"可以"、"好"、"行"、"来吧" → extend_recommendation。

输出格式: {"action":"answer_only|extend_recommendation|none"}`,
      },
      {
        role: 'user',
        content: `Echo 刚才问: ${question.content}
问题上下文:${JSON.stringify(question.context ?? {})}
用户这句:${text}`,
      },
    ], { temperature: 0, signal }),
    FOLLOW_UP_CLASSIFIER_TIMEOUT_MS,
  )
  assertTasteQuestionActive(signal)
  if (!response) return null
  const match = response.match(/\{[\s\S]*\}/)
  if (!match) return null
  try {
    const parsed = JSON.parse(match[0]) as { action?: unknown }
    return parsePendingReplyAction(parsed.action)
  } catch {
    return null
  }
}

export const tasteQuestionSchedulerTestHelpers = {
  buildRecommendationTextFromAnswer,
  ruleClassifyPendingReply,
}

async function classifyPendingQuestionReply(text: string, question: TasteQuestion, signal?: AbortSignal): Promise<PendingQuestionReplyCapture['action']> {
  const ruleAction = ruleClassifyPendingReply(text, question)
  if (ruleAction) return ruleAction
  const llmAction = await llmClassifyPendingReply(text, question, signal)
  return llmAction ?? 'none'
}

function addConversationQuestions(userText: string): void {
  const items: Array<{ regex: RegExp; kind: string; content: string; context: Record<string, unknown> }> = [
    {
      regex: /太吵|吵|炸|刺耳|刺|冲|闹/,
      kind: 'conversation_texture',
      content: '你说的“吵”，更像编曲太满，还是人声太冲？',
      context: { source: 'conversation', cue: 'noisy' },
    },
    {
      regex: /激昂|燃|热血|提神|有劲|带感|振奋|亢奋/,
      kind: 'conversation_energy',
      content: '你要的“激昂”，是节奏更快，还是副歌更有力量？',
      context: { source: 'conversation', cue: 'high_energy' },
    },
    {
      regex: /慢|舒缓|放松|休息|轻一点|缓一缓|安静/,
      kind: 'conversation_slow',
      content: '你说的慢一点，是想让节奏慢，还是让情绪轻一点？',
      context: { source: 'conversation', cue: 'slow' },
    },
    {
      regex: /粤语|港乐|广东歌/,
      kind: 'conversation_language',
      content: '你想听粤语时，更偏老港乐的旧气味，还是新一点的粤语流行？',
      context: { source: 'conversation', cue: 'cantonese' },
    },
    {
      regex: /英文|英语|欧美|国外|外文/,
      kind: 'conversation_language',
      content: '你听英文歌时，更在意旋律顺耳，还是节奏和制作感？',
      context: { source: 'conversation', cue: 'english' },
    },
  ]
  for (const item of items) {
    if (item.regex.test(userText)) addTasteQuestion(item.kind, item.content, item.context)
  }
}

function addCurrentRecommendationQuestions(userText: string, tracks: Track[]): void {
  if (!/喜欢|不喜欢|感觉|想听|来|推|推荐|这首|这种|那种|歌|声音|氛围|慢|快|燃|粤语|英文/.test(userText)) return
  for (const track of tracks.slice(0, 2)) {
    if (hasRecentTasteQuestionForTrack('recommendation_followup', track.title, track.artist, RECOMMENDATION_FOLLOW_UP_COOLDOWN_DAYS)) continue
    addTasteQuestion(
      'recommendation_followup',
      buildRecommendationFollowUpQuestion(track),
      { source: 'current_recommendation', title: track.title, artist: track.artist },
      recommendationFollowUpExpiresAt(),
    )
  }
}

function addBehaviorQuestions(): void {
  const feedback = listTrackFeedback(80)
  let created = 0
  for (const item of feedback) {
    if (created >= 3) break
    const { track } = item
    if (item.favoriteCount > 0 && item.skipCount > 0) {
      addTasteQuestion(
        'contradiction_favorite_skip',
        `你收藏过《${track.title}》，也切过它。我有点拿不准：它是只适合某个场景，还是你对它的感觉在变？`,
        { source: 'contradiction', title: track.title, artist: track.artist },
      )
      created += 1
      continue
    }
    if (item.playCount >= 2 && item.skipCount >= 2) {
      addTasteQuestion(
        'contradiction_play_skip',
        `《${track.title}》你听过几次，也跳过几次。它对你来说是看心情，还是有些段落容易腻？`,
        { source: 'contradiction', title: track.title, artist: track.artist },
      )
      created += 1
      continue
    }
    if (item.loopCount >= 2) {
      addTasteQuestion(
        'behavior_loop',
        `《${track.title}》你循环过几次，我想确认一下：它抓住你的是旋律、人声，还是某个时间点的感觉？`,
        { source: 'behavior', title: track.title, artist: track.artist },
      )
      created += 1
      continue
    }
    if (item.favoriteCount > 0) {
      addTasteQuestion(
        'behavior_favorite',
        `你收藏了《${track.title}》。这首对你来说是“声音舒服”，还是“情绪刚好”？`,
        { source: 'behavior', title: track.title, artist: track.artist },
      )
      created += 1
      continue
    }
    if (item.skipCount >= 3 && item.playCount === 0) {
      addTasteQuestion(
        'behavior_skip',
        `我看到你几次切掉《${track.title}》，是它太吵、太慢，还是情绪不对？`,
        { source: 'behavior', title: track.title, artist: track.artist },
      )
      created += 1
    }
  }
}

export function generateDynamicTasteQuestions(userText: string, tracks: Track[]): void {
  addConversationQuestions(userText)
  addCurrentRecommendationQuestions(userText, tracks)
  addBehaviorQuestions()
}

export async function capturePendingQuestionAnswer(userText: string, signal?: AbortSignal): Promise<PendingQuestionReplyCapture> {
  assertTasteQuestionActive(signal)
  const latest = getLatestAskedPendingQuestion()
  if (!latest?.conversationId) return { action: 'none' }
  const turns = countUserMessagesAfterConversation(latest.conversationId)
  if (turns > MIN_USER_TURNS_AFTER_QUESTION) return { action: 'none' }
  const action = await classifyPendingQuestionReply(userText, latest.question, signal)
  if (action === 'none') return { action: 'none' }

  answerTasteQuestion(latest.question.id, userText)
  const polarity = detectPendingReplyPolarity(userText)
  const focus = detectPendingReplyFocus(userText)
  await applyMemorySignal('correct_assumption', {
    target: questionTrackLabel(latest.question),
    strength: polarity === 'negative' ? 0.12 : 0.24,
    note: `taste_question:${latest.question.id}; answer:${userText.slice(0, 120)}${focus ? `; focus:${focus}` : ''}`,
  }, {
    source: 'taste_question',
    refreshReason: 'taste_question',
  })
  return {
    action,
    question: latest.question,
    polarity,
    focus,
    recommendationText: action === 'extend_recommendation' ? buildRecommendationTextFromAnswer(userText, latest.question) : undefined,
  }
}

export function pickTasteFollowUpQuestion(userText: string, tracks: Track[]): TasteQuestion | null {
  if (countTasteQuestionsAskedToday() >= DAILY_QUESTION_LIMIT) return null
  if (!canAskAfterLatestQuestion()) return null
  const candidates = getPendingQuestions(12)
    .filter((question) => !hasTasteQuestionBeenAsked(question.id))
    .map((question) => ({ question, score: scoreQuestion(question, userText, tracks) }))
    .filter((item) => item.score > 0)
    .sort((a, b) => b.score - a.score)
  return candidates[0]?.question ?? null
}

export function recordFollowUpQuestionAsked(question: TasteQuestion | null, conversationId: number): void {
  if (!question) return
  markTasteQuestionAsked(question.id, conversationId)
}
