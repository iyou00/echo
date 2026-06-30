import { describe, expect, it } from 'vitest'
import { CASUAL_WAITING_LINES, WAITING_LINES, pickWaitingLineFor } from './chatWaitingLines'

const FORBIDDEN_CHAT_COPY = /接住你|接住你心情|给你接上|稳稳|太猛|太满|上头|燃爆/

describe('chat waiting lines', () => {
  it('keeps static waiting copy close to Echo voice', () => {
    for (const line of [...WAITING_LINES, ...CASUAL_WAITING_LINES]) {
      expect(line).not.toMatch(FORBIDDEN_CHAT_COPY)
    }
  })

  it('returns a deterministic waiting line for the same text', () => {
    expect(pickWaitingLineFor('今天有什么值得听的吗')).toBe(pickWaitingLineFor('今天有什么值得听的吗'))
    expect(pickWaitingLineFor('我有点累')).toBe(pickWaitingLineFor('我有点累'))
  })
})
