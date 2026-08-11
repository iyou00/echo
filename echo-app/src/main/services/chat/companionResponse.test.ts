import { describe, expect, it, vi } from 'vitest'

vi.mock('../../db/conversations', () => ({
  loadUserConversationsSince: vi.fn(() => []),
}))

import { loadUserConversationsSince } from '../../db/conversations'
import {
  applyCompanionResponseStyle,
  buildCompanionResponseBrief,
  isFatigueExpression,
  loadCompanionResponseBrief,
} from './companionResponse'

describe('companion response brief', () => {
  it('uses warm care for a first mild fatigue message', () => {
    const brief = buildCompanionResponseBrief('今天工作有点累，给我找三首歌', [
      { date: '2026-08-10', messages: ['今天工作有点累，给我找三首歌'] },
      { date: '2026-08-09', messages: [] },
      { date: '2026-08-08', messages: [] },
    ])

    expect(brief?.tone).toBe('warm_care')
    expect(brief?.pattern).toBe('single')
  })

  it('allows playful concern after fatigue repeats on the same day', () => {
    const brief = buildCompanionResponseBrief('我又累了，想摸会儿鱼', [
      { date: '2026-08-10', messages: ['上午忙得好累', '我又累了，想摸会儿鱼'] },
      { date: '2026-08-09', messages: [] },
      { date: '2026-08-08', messages: [] },
    ])

    expect(brief?.tone).toBe('playful_concern')
    expect(brief?.pattern).toBe('same_day_repeat')
    expect(brief?.sameDayMentions).toBe(2)
  })

  it('allows playful concern for fatigue across three consecutive days', () => {
    const brief = buildCompanionResponseBrief('今天也好累', [
      { date: '2026-08-10', messages: ['今天也好累'] },
      { date: '2026-08-09', messages: ['下班以后整个人很疲惫'] },
      { date: '2026-08-08', messages: ['忙了一天，累了'] },
    ])

    expect(brief?.tone).toBe('playful_concern')
    expect(brief?.pattern).toBe('three_day_streak')
  })

  it('switches to serious care when fatigue includes a health risk', () => {
    const brief = buildCompanionResponseBrief('我累得胸闷，感觉呼吸困难', [
      { date: '2026-08-10', messages: ['上午就很累', '我累得胸闷，感觉呼吸困难'] },
      { date: '2026-08-09', messages: ['昨天也很累'] },
      { date: '2026-08-08', messages: ['前天累得没力气'] },
    ])

    expect(brief?.tone).toBe('serious_care')
    expect(brief?.pattern).toBe('serious')
    expect(brief?.guidance.join('')).toContain('不使用调侃')
  })

  it('does not treat recovery language as current fatigue', () => {
    expect(isFatigueExpression('睡了一觉，已经不累了')).toBe(false)
    expect(buildCompanionResponseBrief('睡了一觉，已经不累了', [])).toBeNull()
  })

  it('does not treat accumulation words as fatigue', () => {
    expect(isFatigueExpression('最近在积累听歌数据')).toBe(false)
    expect(isFatigueExpression('这个月累计听了三百首')).toBe(false)
    expect(isFatigueExpression('这些记录会累积成画像')).toBe(false)
  })

  it('skips history queries when the current message is unrelated to fatigue', () => {
    vi.mocked(loadUserConversationsSince).mockClear()

    expect(loadCompanionResponseBrief('给我推荐三首歌', new Date('2026-08-10T08:00:00+08:00'))).toBeNull()
    expect(loadUserConversationsSince).not.toHaveBeenCalled()
  })

  it('loads three days in one query and decorates an early reply', () => {
    vi.mocked(loadUserConversationsSince).mockReturnValueOnce([
      { id: 1, role: 'user', content: '上午忙得好累', createdAt: '2026-08-10T01:00:00.000Z', tracks: [] },
      { id: 2, role: 'user', content: '我又累了，这首太吵', createdAt: '2026-08-10T06:00:00.000Z', tracks: [] },
    ])

    const brief = loadCompanionResponseBrief('我又累了，这首太吵', new Date('2026-08-10T14:00:00+08:00'))
    const content = applyCompanionResponseStyle('好，我换一首轻一点的。', '我又累了，这首太吵', brief)

    expect(loadUserConversationsSince).toHaveBeenCalledTimes(1)
    expect(brief?.tone).toBe('playful_concern')
    expect(content).toContain('第2次喊累')
    expect(content).toContain('我换一首轻一点的')
  })
})
