import type { TasteQuestion } from '../../../types/ipc'

export type PendingQuestionReplyAction = 'none' | 'answer_only' | 'extend_recommendation'
export type PendingQuestionReplyPolarity = 'positive' | 'negative' | 'mixed' | 'neutral'

export interface PendingQuestionReplyCapture {
  action: PendingQuestionReplyAction
  question?: TasteQuestion
  polarity?: PendingQuestionReplyPolarity
  focus?: string
  recommendationText?: string
}

export function questionTrackLabel(question: TasteQuestion): string {
  const title = typeof question.context?.title === 'string' ? question.context.title.trim() : ''
  const artist = typeof question.context?.artist === 'string' ? question.context.artist.trim() : ''
  if (title && artist) return `${artist} / ${title}`
  return title || artist || '刚才那首'
}

export function questionSeedText(question: TasteQuestion): string {
  const title = typeof question.context?.title === 'string' ? question.context.title.trim() : ''
  const artist = typeof question.context?.artist === 'string' ? question.context.artist.trim() : ''
  if (title && artist) return `${artist}的《${title}》`
  if (title) return `《${title}》`
  if (artist) return `${artist}的歌`
  return '刚才那首歌'
}

function isLikelyAnswer(text: string): boolean {
  if (text.length < 2 || text.length > 240) return false
  if (/^(再来|来一首|来几首|放|播放|推|推荐|换|下一首|上一首|收藏|暂停|继续|打开|关闭|设置)/.test(text)) return false
  return /喜欢|不喜欢|因为|更|主要|其实|感觉|氛围|声音|歌词|旋律|节奏|编曲|情绪|以前|现在|最近|是|不是|算是|偏/.test(text)
}

function isSimpleConfirmation(text: string): boolean {
  return /^(嗯|对|是|可以|可以的|好|好的|行|行啊|好啊|来吧|没问题|也行|就这样)[呀啊吧的了，。!！?？]*$/.test(text)
}

function isActionConfirmationQuestion(question?: TasteQuestion): boolean {
  if (!question) return false
  const content = `${question.kind} ${question.content}`
  if (/口味|偏好|喜欢|不喜欢|更被|更喜欢|主要|哪里|哪种|怎么形容|打到|人声|旋律|氛围|节奏|歌词/.test(content)) return false
  return /(要不要|要不|想不想|还要|需要|可以).{0,18}(换|继续|再来|接一首|类似|推荐|找歌|放歌|来一首)|(换|继续|再来|接一首|类似).{0,18}(吗|么|嘛|可以|要不要)/.test(content)
}

export function looksLikeFollowUpExtension(text: string): boolean {
  if (/^(再来|再给|再放|接着|继续|还有|多来|来一首|来几首|换一首|下一首)/.test(text)) return true
  if (/^(类似|像|照这个|按这个|这个方向).{0,12}(来|找|推|推荐|放|继续|再|换)/.test(text)) return true
  if (/(再来|再给|接着|继续|还有|多来|换一首|下一首).{0,12}(这种|那种|类似|这个方向|氛围|感觉|味道)/.test(text)) return true
  if (/(这种|那种|类似|这个方向|氛围|感觉|味道).{0,12}(再来|再给|接着|继续|还有|多来|换一首|下一首|来一首|来几首)/.test(text)) return true
  return false
}

function looksLikeFreshMusicRequest(text: string): boolean {
  if (looksLikeFollowUpExtension(text)) return false
  return /(?:来|推|推荐|放|找|听|给我).{0,16}(首|几首|歌|音乐|曲)|粤语|英文|欧美|华语|韩语|日语|激昂|热血|舒缓|慢歌|快歌|工作|专注|雨天|放松|欢快|魔力红|maroon/i.test(text)
}

export function detectPendingReplyPolarity(text: string): PendingQuestionReplyPolarity {
  if (/不喜欢|不太|不是|不对|没那么|一般|算了|太吵|太慢|太冲|听不下|不合适/.test(text)) return 'negative'
  if (/但是|不过|有点|还行|可以但|喜欢但/.test(text)) return 'mixed'
  if (/喜欢|可以|对|是|算|不错|挺好|刚好|舒服|合适|中|吃这个|这个感觉/.test(text)) return 'positive'
  return 'neutral'
}

export function detectPendingReplyFocus(text: string): string {
  const focuses = [
    ['氛围', /氛围|感觉|气氛|味道/],
    ['旋律', /旋律|副歌|前奏|曲调/],
    ['人声', /人声|声音|嗓音|唱腔/],
    ['节奏', /节奏|鼓点|律动|速度/],
    ['歌词', /歌词|词/],
    ['编曲', /编曲|制作|乐器/],
  ] as const
  return focuses.find(([, pattern]) => pattern.test(text))?.[0] ?? ''
}

export function ruleClassifyPendingReply(text: string, question?: TasteQuestion): PendingQuestionReplyAction | null {
  const explicitFreshMusic = /(来一首|来几首|推荐|推|放首|放点|找首|找一首|给我).{0,18}(歌|音乐|曲|粤语|英文|欧美|华语|韩语|日语|激昂|热血|舒缓|慢歌|快歌|放松|欢快|魔力红|maroon)/i
  if (explicitFreshMusic.test(text) && !/(这种|那种|类似|这个方向|氛围|感觉|味道)/.test(text)) return 'none'
  if (looksLikeFollowUpExtension(text)) return 'extend_recommendation'
  if (explicitFreshMusic.test(text)) return 'none'
  if (isSimpleConfirmation(text) && isActionConfirmationQuestion(question)) return 'extend_recommendation'
  if (isLikelyAnswer(text)) return 'answer_only'
  if (isSimpleConfirmation(text) || /^(还行|不错|喜欢|算|挺好)[呀啊吧的了，。!！?？]*$/.test(text)) return 'answer_only'
  if (looksLikeFreshMusicRequest(text)) return 'none'
  return null
}

export function parsePendingReplyAction(value: unknown): PendingQuestionReplyAction | null {
  const action = String(value ?? '')
  if (action === 'answer_only' || action === 'extend_recommendation' || action === 'none') return action
  return null
}

export function buildRecommendationTextFromAnswer(text: string, question: TasteQuestion): string {
  const seed = questionSeedText(question)
  const requestedCount = text.match(/(\d{1,2}|[一二两三四五六七八九十])\s*首/)?.[0] ?? ''
  const countHint = requestedCount ? `给我${requestedCount}` : '给我一首'
  return `像${seed}这种感觉，${text}。${countHint}可播放的歌。`
}
