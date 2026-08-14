import { describe, expect, it } from 'vitest'
import type { AgentActionSummary, ChatMessage, QueueHistoryDay } from '../../types/ipc'
import { buildReviewTimeline } from './reviewTimeline'

describe('review timeline', () => {
  it('orders existing facts without turning a system failure into user feedback', () => {
    const messages: ChatMessage[] = [{ id: 1, role: 'user', content: '今天有点累', createdAt: '2026-08-14T08:00:00.000Z' }]
    const history: QueueHistoryDay[] = [{
      date: '2026-08-14',
      tracks: [{ title: '一首歌', artist: '某位歌手', queueStatus: 'completed', queueStatusAt: '2026-08-14T08:05:00.000Z' }],
    }]
    const actions: AgentActionSummary[] = [{
      id: 'failed-action',
      origin: 'scene',
      actionType: 'play',
      reasonCode: 'user_request',
      goalCode: 'recover',
      status: 'failed',
      plannedAt: '2026-08-14T08:10:00.000Z',
      outcomes: [{ type: 'system_failure', polarity: 'system', strength: 'weak', occurredAt: '2026-08-14T08:10:00.000Z' }],
    }]

    const timeline = buildReviewTimeline(messages, history, actions)

    expect(timeline.map((item) => item.kind)).toEqual(['agent', 'listening', 'conversation'])
    expect(timeline[0]).toMatchObject({ tone: 'system', detail: '这次没有执行完成，不会算作你的反馈。' })
    expect(timeline[1]).toMatchObject({ title: '一首歌', detail: '某位歌手 · 已听完' })
  })
})
