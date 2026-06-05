import { describe, expect, it } from 'vitest'
import { ruleClassifyPendingReply } from './pendingReply'

describe('pending taste reply classifier', () => {
  it('treats meta questions as fresh topics', () => {
    expect(ruleClassifyPendingReply('你的设定是什么呀')).toBe('none')
  })

  it('keeps music follow-up extensions active', () => {
    expect(ruleClassifyPendingReply('这种感觉再来一首')).toBe('extend_recommendation')
  })
})
