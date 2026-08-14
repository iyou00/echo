import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  actionStatus: new Map<string, string>(),
  itemStatus: new Map<string, string>(),
  outcomes: [] as Array<Record<string, unknown>>,
  feedback: vi.fn(),
  createdActions: 0,
}))

vi.mock('electron', () => ({ BrowserWindow: { getAllWindows: () => [] } }))
vi.mock('./queue', () => ({ getQueue: vi.fn(() => []), markQueueStatus: vi.fn() }))
vi.mock('../netease/music', () => ({ refreshPlayableUrl: vi.fn(async (track) => track) }))
vi.mock('../db/feedback', () => ({ recordTrackFeedback: mocks.feedback }))
vi.mock('./memoryPolicy', () => ({ applyMemorySignal: vi.fn(async () => null) }))
vi.mock('./health', () => ({ recordHealth: vi.fn() }))
vi.mock('./sceneJourney', () => ({ sceneQueueAfterAdjustment: vi.fn((queue) => ({ kept: queue, replaced: [] })) }))
vi.mock('../domain/stageContext/repository', () => ({ loadActiveStageContext: vi.fn(() => null) }))
vi.mock('../db', () => ({ getDb: vi.fn(() => ({ transaction: (fn: () => unknown) => () => fn() })) }))
vi.mock('../domain/agentAction/repository', () => ({
  createAgentAction: vi.fn(() => {
    mocks.createdActions += 1
    mocks.actionStatus.set('action-1', 'planned')
    mocks.itemStatus.set('item-1', 'planned')
    return { id: 'action-1', status: 'planned', plannedAt: new Date().toISOString(), origin: 'playback', actionType: 'play', reasonCode: 'user_request', goalCode: 'none', items: [{ id: 'item-1', itemType: 'track', ordinal: 0, status: 'planned' }] }
  }),
  loadAgentActionStatus: vi.fn((id: string) => mocks.actionStatus.get(id) ?? null),
  loadAgentActionItemStatus: vi.fn((id: string) => mocks.itemStatus.get(id) ?? null),
  transitionAgentAction: vi.fn((id: string, status: string) => mocks.actionStatus.set(id, status)),
  transitionAgentActionItem: vi.fn((id: string, status: string) => mocks.itemStatus.set(id, status)),
  recordAgentActionOutcome: vi.fn((outcome: Record<string, unknown>) => {
    mocks.outcomes.push(outcome)
    return { inserted: true, id: mocks.outcomes.length }
  }),
}))

import { finishCurrent, heartbeat, next, play, resetPlaybackState } from './playback'

describe('playback agent attribution', () => {
  beforeEach(() => {
    mocks.actionStatus.clear()
    mocks.itemStatus.clear()
    mocks.outcomes = []
    mocks.createdActions = 0
    mocks.feedback.mockClear()
    resetPlaybackState()
  })

  it('rejects stale renderer callbacks and settles only the current playback instance', async () => {
    const started = await play({ id: '42', title: '主角', artist: '王菲', playUrl: 'mock://audio' })
    const instanceId = started.current?.playbackInstanceId
    expect(instanceId).toBeTruthy()

    const stale = heartbeat({ playbackInstanceId: 'old-instance', position: 50_000, duration: 100_000, status: 'playing' })
    expect(stale.position).toBe(0)
    expect(mocks.outcomes).toHaveLength(0)

    heartbeat({ playbackInstanceId: instanceId, position: 80_000, duration: 100_000, status: 'playing' })
    expect(mocks.outcomes[0]).toMatchObject({ outcomeType: 'playback_started' })
    expect((await finishCurrent('old-instance')).current).not.toBeNull()
    expect((await finishCurrent(instanceId)).current).toBeNull()
    expect(mocks.outcomes.at(-1)).toMatchObject({ outcomeType: 'completed' })
    expect(mocks.feedback).toHaveBeenCalledTimes(1)
  })

  it('keeps separate recommendation attribution when the same track is played twice', async () => {
    mocks.actionStatus.set('recommendation-a', 'succeeded')
    mocks.itemStatus.set('item-a', 'succeeded')
    mocks.actionStatus.set('recommendation-b', 'succeeded')
    mocks.itemStatus.set('item-b', 'succeeded')

    const first = await play({
      id: '42', title: '主角', artist: '王菲', playUrl: 'mock://audio',
      agentActionId: 'recommendation-a', agentActionItemId: 'item-a', sourceContext: 'chat',
    })
    heartbeat({ playbackInstanceId: first.current?.playbackInstanceId, position: 80_000, duration: 100_000, status: 'playing' })
    await finishCurrent(first.current?.playbackInstanceId)

    const second = await play({
      id: '42', title: '主角', artist: '王菲', playUrl: 'mock://audio',
      agentActionId: 'recommendation-b', agentActionItemId: 'item-b', sourceContext: 'chat',
    })
    heartbeat({ playbackInstanceId: second.current?.playbackInstanceId, position: 80_000, duration: 100_000, status: 'playing' })
    await finishCurrent(second.current?.playbackInstanceId)

    expect(mocks.createdActions).toBe(0)
    expect(mocks.outcomes.filter((outcome) => outcome.outcomeType === 'completed')).toEqual([
      expect.objectContaining({ actionId: 'recommendation-a', actionItemId: 'item-a' }),
      expect.objectContaining({ actionId: 'recommendation-b', actionItemId: 'item-b' }),
    ])
  })

  it('creates a fresh action for a manual play from favorites', async () => {
    mocks.actionStatus.set('old-recommendation', 'succeeded')
    mocks.itemStatus.set('old-item', 'succeeded')

    const started = await play({
      id: '42', title: '主角', artist: '王菲', playUrl: 'mock://audio', sourceContext: 'favorite',
      agentActionId: 'old-recommendation', agentActionItemId: 'old-item',
    })

    expect(mocks.createdActions).toBe(1)
    expect(started.current).toMatchObject({ agentActionId: 'action-1', agentActionItemId: 'item-1' })
  })

  it('creates a fresh playback action when the recommendation action already failed', async () => {
    mocks.actionStatus.set('failed-recommendation', 'failed')
    mocks.itemStatus.set('failed-item', 'failed')

    const started = await play({
      id: '42', title: '主角', artist: '王菲', playUrl: 'mock://audio', sourceContext: 'voice',
      agentActionId: 'failed-recommendation', agentActionItemId: 'failed-item',
    })

    expect(mocks.createdActions).toBe(1)
    expect(started.current).toMatchObject({ agentActionId: 'action-1', agentActionItemId: 'item-1' })
  })

  it('does not turn an ambiguous short listen into legacy negative preference', async () => {
    const started = await play({ id: '42', title: '主角', artist: '王菲', playUrl: 'mock://audio' })
    heartbeat({ playbackInstanceId: started.current?.playbackInstanceId, position: 35_000, duration: 200_000, status: 'playing' })

    await next({ playbackInstanceId: started.current?.playbackInstanceId })

    expect(mocks.outcomes.at(-1)).toMatchObject({ outcomeType: 'user_stop', polarity: 'neutral' })
    expect(mocks.feedback).not.toHaveBeenCalled()
  })
})
