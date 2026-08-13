import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  actionStatus: new Map<string, string>(),
  itemStatus: new Map<string, string>(),
  outcomes: [] as Array<Record<string, unknown>>,
  feedback: vi.fn(),
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

import { finishCurrent, heartbeat, play, resetPlaybackState } from './playback'

describe('playback agent attribution', () => {
  beforeEach(() => {
    mocks.actionStatus.clear()
    mocks.itemStatus.clear()
    mocks.outcomes = []
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
})
