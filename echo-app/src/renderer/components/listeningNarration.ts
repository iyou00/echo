export type NarrationSentence = {
  text: string
  delayMs: number
}

export const NARRATION_SENTENCE_GAP_MS = 350
export const NARRATION_FADE_MS = 550

const SENTENCE_SPLIT = /([。！？!?])/

/**
 * 把 Echo 的一句话按句切分，供一起听面板逐句淡入。
 * 保留原标点；空句跳过。
 */
export function splitNarration(text: string): NarrationSentence[] {
  const parts = text.split(SENTENCE_SPLIT)
  const sentences: string[] = []
  for (let index = 0; index < parts.length; index += 2) {
    const body = parts[index] ?? ''
    const punct = parts[index + 1] ?? ''
    if (!body.trim()) continue
    const sentence = `${body}${punct}`.trim()
    if (sentence) sentences.push(sentence)
  }
  return sentences.map((text, index) => ({
    text,
    delayMs: index * NARRATION_SENTENCE_GAP_MS,
  }))
}

export type AfterListeningInput = {
  /** 下一首的 Echo 理由（如果有） */
  nextReason?: string
  /** 简单轮换，让连续听完多首时文案不重样 */
  variantIndex?: number
}

const LISTENED_LINES = [
  '刚才那首，听完了。',
  '这一首也放完了。',
  '嗯，听完了。',
]

const BRIDGE_LINES = [
  '接下来这首，',
  '下一首已经接好，',
  '我接着放，',
]

/**
 * 听完一首、下一首开始前的过渡句。确定性文案，不走 LLM——
 * 旁白要的是"在场感"，不是新的判断。
 */
export function afterListeningLine({ nextReason, variantIndex = 0 }: AfterListeningInput): string {
  const listened = LISTENED_LINES[Math.abs(variantIndex) % LISTENED_LINES.length]
  if (!nextReason) return listened
  const bridge = BRIDGE_LINES[Math.abs(variantIndex) % BRIDGE_LINES.length]
  const firstSentence = splitNarration(nextReason)[0]?.text ?? ''
  return `${listened}${bridge}${firstSentence}`
}
