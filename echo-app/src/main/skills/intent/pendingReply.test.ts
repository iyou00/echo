import { describe, expect, it } from 'vitest'
import type { TasteQuestion } from '../../../types/ipc'
import { reconcilePreclassifiedPendingReply, ruleClassifyPendingReply } from './pendingReply'

const pendingQuestion = {
  id: 1,
  kind: 'recommendation_followup',
  content: '这首打中你的是旋律还是人声？',
  context: {},
  status: 'pending',
} as TasteQuestion

describe('pending taste reply classifier', () => {
  it('treats meta questions as fresh topics', () => {
    expect(ruleClassifyPendingReply('你的设定是什么呀')).toBe('none')
  })

  it('keeps music follow-up extensions active', () => {
    expect(ruleClassifyPendingReply('这种感觉再来一首')).toBe('extend_recommendation')
    expect(ruleClassifyPendingReply('这种感觉你帮我挑一首')).toBe('extend_recommendation')
  })

  it('treats a named similarity reference as a fresh music request', () => {
    expect(ruleClassifyPendingReply('类似大鱼海棠这首歌的歌曲推荐下')).toBe('none')
  })

  it('blocks an LLM pending classification when the user starts a fresh music request', () => {
    expect(reconcilePreclassifiedPendingReply(
      '推荐一首陈奕迅的歌',
      pendingQuestion,
      'answer_only',
    )).toBe('none')
    expect(reconcilePreclassifiedPendingReply(
      '你帮我挑一首',
      pendingQuestion,
      'answer_only',
    )).toBe('none')
    expect(reconcilePreclassifiedPendingReply(
      '随便选一首吧',
      pendingQuestion,
      'answer_only',
    )).toBe('none')
  })

  it('keeps deterministic extension semantics over a weaker LLM action', () => {
    expect(reconcilePreclassifiedPendingReply(
      '这种感觉再来一首',
      pendingQuestion,
      'answer_only',
    )).toBe('extend_recommendation')
  })
})
