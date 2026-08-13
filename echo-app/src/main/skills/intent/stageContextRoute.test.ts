import { describe, expect, it } from 'vitest'
import { chatIntentTestHelpers } from './chat'

describe('chat stage context proposal parsing', () => {
  it('accepts a bounded proposal tied to the current conversation only', () => {
    const route = chatIntentTestHelpers.parseChatRouteContent(JSON.stringify({
      kind: 'casual_chat',
      wantsMusic: false,
      confidence: 0.95,
      responseStrategy: { mode: 'warm_care' },
      stageContextProposal: {
        operation: 'create',
        kind: 'work',
        summary: '今晚在加班',
        statePatch: { emotion: 'tired', energy: 'low', interactionPreference: 'music', safety: 'normal' },
        goal: 'focus',
        confidence: 0.92,
        ttlClass: 'day',
        evidenceConversationIds: [41, 42],
      },
    }), '今晚要加班，有点累', { currentConversationId: 42 })

    expect(route?.stageContextProposal).toMatchObject({
      operation: 'create', kind: 'work', goal: 'focus', evidenceConversationIds: [42],
    })
  })

  it('does not invent durable state when the optional field is absent', () => {
    const route = chatIntentTestHelpers.parseChatRouteContent(JSON.stringify({
      kind: 'casual_chat', wantsMusic: false, confidence: 0.9, responseStrategy: { mode: 'practical' },
    }), '讲个最近的趣事', { currentConversationId: 7 })
    expect(route?.stageContextProposal).toBeUndefined()
  })
})
