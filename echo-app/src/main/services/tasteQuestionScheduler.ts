import type { TasteQuestion, Track } from '../../types/ipc'
import {
  answerTasteQuestion,
  countTasteQuestionsAskedToday,
  getLatestQuestionPromptConversationId,
  countUserMessagesAfterConversation,
  getLatestAskedPendingQuestion,
  getPendingQuestions,
  hasTasteQuestionBeenAsked,
  markTasteQuestionAsked,
  addTasteQuestion,
} from '../db/taste'
import { listTrackFeedback } from '../db/feedback'
import { applySignal } from './taste'

const DAILY_QUESTION_LIMIT = 3
const MIN_USER_TURNS_AFTER_QUESTION = 2

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

function isLikelyAnswer(text: string): boolean {
  if (text.length < 2 || text.length > 240) return false
  if (/^(再来|来一首|来几首|放|播放|推|推荐|换|下一首|上一首|收藏|暂停|继续|打开|关闭|设置)/.test(text)) return false
  return /喜欢|不喜欢|因为|更|主要|其实|感觉|氛围|声音|歌词|旋律|节奏|编曲|情绪|以前|现在|最近|是|不是|算是|偏/.test(text)
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
    addTasteQuestion(
      'recommendation_followup',
      `刚才我给你接了《${track.title}》，我想确认一下：你更吃它的旋律、人声，还是这首歌的氛围？`,
      { source: 'current_recommendation', title: track.title, artist: track.artist },
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

export async function capturePendingQuestionAnswer(userText: string): Promise<boolean> {
  const latest = getLatestAskedPendingQuestion()
  if (!latest?.conversationId) return false
  const turns = countUserMessagesAfterConversation(latest.conversationId)
  if (turns > MIN_USER_TURNS_AFTER_QUESTION) return false
  if (!isLikelyAnswer(userText)) return false
  answerTasteQuestion(latest.question.id, userText)
  await applySignal('correct_assumption', {
    target: userText,
    strength: 0.22,
    note: `taste_question:${latest.question.id}`,
  })
  return true
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

export function appendFollowUpQuestion(content: string, question: TasteQuestion | null): string {
  if (!question) return content
  const text = content.trim()
  if (!text) return content
  if (compact(text).includes(compact(question.content).slice(0, 8))) return text
  return `${text}\n\n顺便问一句，${question.content}`
}

export function recordFollowUpQuestionAsked(question: TasteQuestion | null, conversationId: number): void {
  if (!question) return
  markTasteQuestionAsked(question.id, conversationId)
}
