import { describe, expect, it, vi } from 'vitest'
import { correctProfileMemory, isActionableProfileCorrection } from './profileCorrection'
import { applyMemorySignal } from './memoryPolicy'

vi.mock('./memoryPolicy', () => ({
  applyMemorySignal: vi.fn(async () => true),
}))

describe('profile correction memory', () => {
  it('accepts corrections with concrete music or portrait direction', () => {
    expect(isActionableProfileCorrection('我最近听王菲比较多，是那几天刚好在听。')).toBe(true)
    expect(isActionableProfileCorrection('少推电子音墙，我现在听这个会烦。')).toBe(true)
    expect(isActionableProfileCorrection('别把我写成一直很悲伤的人，我最近更想听轻快一点。')).toBe(true)
  })

  it('rejects vague correction text before it pollutes long-term memory', () => {
    expect(isActionableProfileCorrection('这段理解不准')).toBe(false)
    expect(isActionableProfileCorrection('不太对')).toBe(false)
    expect(isActionableProfileCorrection('这个感觉不对')).toBe(false)
    expect(isActionableProfileCorrection('你写得怪怪的')).toBe(false)
  })

  it('stores profile corrections as high-priority memory signals', async () => {
    const result = await correctProfileMemory('我最近听周杰伦只是阶段性的，别一直这么写。')

    expect(result).toEqual({
      ok: true,
      message: '我记下了。后面的推荐和回声会先按这个修正，重新生成画像时也会用上。',
    })
    expect(applyMemorySignal).toHaveBeenCalledWith('correct_assumption', {
      target: '我最近听周杰伦只是阶段性的，别一直这么写。',
      strength: 0.3,
      note: '我最近听周杰伦只是阶段性的，别一直这么写。',
    }, {
      source: 'profile_correction',
      refreshReason: 'profile_correction',
    })
  })

  it('rejects empty corrections before writing memory', async () => {
    vi.mocked(applyMemorySignal).mockClear()

    const result = await correctProfileMemory('   ')

    expect(result.ok).toBe(false)
    expect(applyMemorySignal).not.toHaveBeenCalled()
  })

  it('rejects vague corrections before writing memory', async () => {
    vi.mocked(applyMemorySignal).mockClear()

    const result = await correctProfileMemory('这段理解不准')

    expect(result).toEqual({
      ok: false,
      message: '告诉我具体哪里不准，比如少推哪类声音，或别把你写成什么样。',
    })
    expect(applyMemorySignal).not.toHaveBeenCalled()
  })
})
