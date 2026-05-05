import { describe, expect, it, vi } from 'vitest'
import type { TasteQuestion } from '../../types/ipc'
import { tasteQuestionSchedulerTestHelpers } from './tasteQuestionScheduler'

vi.mock('electron', () => ({
  app: {
    getPath: () => process.cwd(),
    getAppPath: () => process.cwd(),
  },
}))

const question: TasteQuestion = {
  id: 1,
  kind: 'recommendation_followup',
  content: '刚才我给你接了《Sunny》，我想确认一下：你更吃它的旋律、人声，还是这首歌的氛围？',
  status: 'pending',
  context: { title: 'Sunny', artist: 'Boney M.' },
}

describe('pending taste question reply classifier', () => {
  it('treats a direct answer as answer_only', () => {
    expect(tasteQuestionSchedulerTestHelpers.ruleClassifyPendingReply('我觉得这首歌的氛围可以')).toBe('answer_only')
    expect(tasteQuestionSchedulerTestHelpers.ruleClassifyPendingReply('对，就是这个感觉')).toBe('answer_only')
  })

  it('treats an extension request as extend_recommendation', () => {
    expect(tasteQuestionSchedulerTestHelpers.ruleClassifyPendingReply('这种感觉再来一首')).toBe('extend_recommendation')
    expect(tasteQuestionSchedulerTestHelpers.ruleClassifyPendingReply('按这个氛围继续')).toBe('extend_recommendation')
  })

  it('treats a fresh music request as none', () => {
    expect(tasteQuestionSchedulerTestHelpers.ruleClassifyPendingReply('来一首粤语慢歌')).toBe('none')
    expect(tasteQuestionSchedulerTestHelpers.ruleClassifyPendingReply('魔力红的歌来一首')).toBe('none')
  })

  it('keeps the seed track when extending a recommendation', () => {
    expect(tasteQuestionSchedulerTestHelpers.buildRecommendationTextFromAnswer('这种感觉再来一首', question)).toContain('Boney M.的《Sunny》')
  })
})
