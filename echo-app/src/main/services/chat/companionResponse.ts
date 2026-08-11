import { loadUserConversationsSince } from '../../db/conversations'
import type { CompanionResponseStrategy } from './companionTypes'

export interface CompanionConversationDay {
  date: string
  messages: string[]
}

export interface CompanionResponseBrief {
  topic: 'fatigue'
  tone: 'warm_care' | 'playful_concern' | 'serious_care'
  pattern: 'single' | 'same_day_repeat' | 'three_day_streak' | 'same_day_repeat_and_three_day_streak' | 'serious'
  sameDayMentions: number
  guidance: string[]
}

const FATIGUE_PATTERN = /(?:累(?:了|死|得|坏|惨|趴|瘫|爆)?|疲惫|疲劳|乏力|没力气|精疲力尽|身心俱疲|困得不行)/i
const FATIGUE_RECOVERY_PATTERN = /(?:不累了|不觉得累|一点也不累|完全不累|没那么累|已经不累|缓过来|休息好了|有力气了|精神好多了)/i
const NON_FATIGUE_COMPOUND_PATTERN = /(?:积累|累计|累积|拖累|连累|累赘)/gi
const SERIOUS_DISTRESS_PATTERN = /(?:想死|不想活|活不下|撑不下去|要崩溃|彻底崩溃|胸痛|胸闷|呼吸困难|喘不上气|晕倒|昏倒|高烧|发烧|生病|急诊|连续失眠|几天没睡|整夜没睡)/i

export function isFatigueExpression(text: string): boolean {
  const normalized = text.trim()
  if (!normalized || FATIGUE_RECOVERY_PATTERN.test(normalized)) return false
  return FATIGUE_PATTERN.test(normalized.replace(NON_FATIGUE_COMPOUND_PATTERN, ''))
}

function localDateKey(value: Date): string {
  return value.toLocaleDateString('sv-SE')
}

function sqliteTimestamp(value: Date): string {
  return value.toISOString().slice(0, 19).replace('T', ' ')
}

export function loadCompanionResponseBrief(userText: string, now = new Date()): CompanionResponseBrief | null {
  if (!isFatigueExpression(userText)) return null
  const oldestLocalDay = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 2)
  const messages = loadUserConversationsSince(sqliteTimestamp(oldestLocalDay), 500)
  const days = [0, 1, 2].map((daysAgo) => {
    const day = new Date(now.getFullYear(), now.getMonth(), now.getDate() - daysAgo)
    const date = localDateKey(day)
    return {
      date,
      messages: messages
        .filter((message) => localDateKey(new Date(message.createdAt)) === date)
        .map((message) => message.content),
    }
  })
  return buildCompanionResponseBrief(userText, days)
}

export function applyCompanionResponseStyle(
  content: string,
  userText: string,
  brief: CompanionResponseBrief | null,
  strategy?: CompanionResponseStrategy,
): string {
  if (!brief) return content
  const effectiveTone = strategy?.mode === 'serious_care'
    ? 'serious_care'
    : strategy?.mode === 'playful_tease'
      ? 'playful_concern'
      : strategy?.mode === 'warm_care'
        ? 'warm_care'
      : strategy
        ? 'neutral'
        : brief.tone
  if (effectiveTone === 'serious_care') {
    const safetyLine = /(?:想死|不想活|活不下|撑不下去|崩溃)/.test(userText)
      ? '你先别一个人扛着，找个信任的人陪在身边；有即时危险就立刻联系当地急救。'
      : '你先停下来休息，这种身体不适要认真对待，尽快找身边的人陪你处理。'
    return `${safetyLine}${content}`
  }
  if (effectiveTone === 'playful_concern') {
    const playfulLine = /(?:工作|上班|加班|项目|开会|忙)/.test(userText)
      ? '你这累法，是准备忙到发财吗？先歇口气。'
      : brief.pattern === 'three_day_streak' || brief.pattern === 'same_day_repeat_and_three_day_streak'
        ? '连续几天都喊累，你这是准备拿疲惫换年终奖吗？先歇会儿。'
        : `今天都第${brief.sameDayMentions}次喊累了，再不休息可真有点活该。先缓口气。`
    return `${playfulLine}${content}`
  }
  if (effectiveTone === 'warm_care') return `累了就先别硬撑，给自己留口气。${content}`
  return content
}

function previousTodayMessages(userText: string, todayMessages: string[]): string[] {
  const messages = todayMessages.slice()
  const latest = messages[messages.length - 1]
  if (latest?.trim() === userText.trim()) messages.pop()
  return messages
}

export function buildCompanionResponseBrief(
  userText: string,
  days: CompanionConversationDay[],
): CompanionResponseBrief | null {
  if (!isFatigueExpression(userText)) return null

  const serious = SERIOUS_DISTRESS_PATTERN.test(userText)
  const todayMessages = previousTodayMessages(userText, days[0]?.messages ?? [])
  const sameDayMentions = 1 + todayMessages.filter(isFatigueExpression).length
  const threeDayStreak = days.length >= 3
    && days.slice(1, 3).every((day) => day.messages.some(isFatigueExpression))

  if (serious) {
    return {
      topic: 'fatigue',
      tone: 'serious_care',
      pattern: 'serious',
      sameDayMentions,
      guidance: [
        '认真回应身体或情绪风险，先建议停下来休息，并在必要时建议联系身边的人或寻求专业帮助。',
        '保持具体、平静，不使用调侃、挖苦或轻描淡写的语气。',
      ],
    }
  }

  if (sameDayMentions >= 2 || threeDayStreak) {
    const pattern = sameDayMentions >= 2 && threeDayStreak
      ? 'same_day_repeat_and_three_day_streak'
      : sameDayMentions >= 2
        ? 'same_day_repeat'
        : 'three_day_streak'
    return {
      topic: 'fatigue',
      tone: 'playful_concern',
      pattern,
      sameDayMentions,
      guidance: [
        '可以像熟悉的朋友一样善意挤兑一句，例如调侃 Ta 忙成这样是不是要发财，或提醒 Ta 自己不休息也有点活该。',
        '调侃只来一句，随后给出具体关心或休息建议；根据用户原话和当前场景现场组织，避免照抄示例。',
        '语气要亲近、有分寸，让用户听得出关心比挖苦更多。',
      ],
    }
  }

  return {
    topic: 'fatigue',
    tone: 'warm_care',
    pattern: 'single',
    sameDayMentions,
    guidance: [
      '先回应这次疲惫的具体处境，可以给一个轻量、实际的休息建议。',
      '保持自然朋友感，不需要把一次疲惫写成长期状态。',
    ],
  }
}
