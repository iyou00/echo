import { describe, expect, it } from 'vitest'
import { buildSoulPolicyPrompt } from './policy'

describe('soul policy prompt', () => {
  it('keeps portrait evidence internal while user copy stays observational', () => {
    const prompt = buildSoulPolicyPrompt('portrait')

    expect(prompt).toContain('具体歌曲、时间、次数和行为只作为内部证据')
    expect(prompt).toContain('写成状态、变化和仍需确认的地方')
    expect(prompt).not.toContain('使用具体歌曲、时间、次数或行为作为锚点')
  })

  it('keeps companion teasing scoped to chat surfaces', () => {
    const chat = buildSoulPolicyPrompt('chat')
    const pendingAnswer = buildSoulPolicyPrompt('pending_answer')

    expect(chat).toContain('playful_concern')
    expect(chat).toContain('复合输入要覆盖用户说出的关键内容')
    expect(pendingAnswer).toContain('playful_concern')

    for (const surface of ['scene', 'voice', 'yinyi', 'portrait', 'care'] as const) {
      const prompt = buildSoulPolicyPrompt(surface)
      expect(prompt).not.toContain('playful_concern')
      expect(prompt).not.toContain('复合输入要覆盖用户说出的关键内容')
    }
  })
})
