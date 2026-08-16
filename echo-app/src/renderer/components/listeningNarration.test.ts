import { describe, expect, it } from 'vitest'
import { afterListeningLine, splitNarration } from './listeningNarration'

describe('listening narration', () => {
  it('splits on Chinese and ASCII sentence punctuation, keeping it', () => {
    const sentences = splitNarration('先撑开一点。别急！真的吗？ok! 好。')
    expect(sentences.map((item) => item.text)).toEqual(['先撑开一点。', '别急！', '真的吗？', 'ok!', '好。'])
  })

  it('staggers each sentence by the gap', () => {
    const sentences = splitNarration('一。二。三。')
    expect(sentences[0].delayMs).toBe(0)
    expect(sentences[1].delayMs).toBeGreaterThan(sentences[0].delayMs)
    expect(sentences[2].delayMs).toBeGreaterThan(sentences[1].delayMs)
  })

  it('skips empty segments', () => {
    expect(splitNarration('。。')).toHaveLength(0)
    expect(splitNarration('')).toHaveLength(0)
  })

  it('bridges into the next song reason when present', () => {
    const line = afterListeningLine({ nextReason: '适合把节奏接住。后面更轻。', variantIndex: 0 })
    expect(line).toContain('听完了')
    expect(line).toContain('适合把节奏接住。')
    expect(line).not.toContain('后面更轻')
  })

  it('stands alone when there is no next reason', () => {
    const line = afterListeningLine({})
    expect(line).toContain('听完了')
    expect(line.endsWith('。')).toBe(true)
  })

  it('rotates copy across consecutive completions', () => {
    const a = afterListeningLine({})
    const b = afterListeningLine({ variantIndex: 1 })
    const c = afterListeningLine({ variantIndex: 2 })
    expect(new Set([a, b, c]).size).toBe(3)
  })
})
