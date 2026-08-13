import { describe, expect, it } from 'vitest'
import { attributeTracksToAgentAction } from './service'

describe('agent action track attribution', () => {
  it('binds each selected track to its own action item', () => {
    const tracks = attributeTracksToAgentAction({
      id: 'action-1',
      origin: 'chat',
      actionType: 'reply',
      reasonCode: 'user_request',
      goalCode: 'none',
      stageContextId: 'context-1',
      status: 'planned',
      plannedAt: '2026-08-13T10:00:00.000Z',
      items: [
        { id: 'message-1', itemType: 'message', ordinal: 0, status: 'planned' },
        { id: 'track-1', itemType: 'track', ordinal: 1, status: 'planned' },
        { id: 'track-2', itemType: 'track', ordinal: 2, status: 'planned' },
      ],
    }, [
      { title: '第一首', artist: '歌手甲' },
      { title: '第二首', artist: '歌手乙' },
    ])

    expect(tracks).toEqual([
      expect.objectContaining({ agentActionId: 'action-1', agentActionItemId: 'track-1', stageContextId: 'context-1' }),
      expect.objectContaining({ agentActionId: 'action-1', agentActionItemId: 'track-2', stageContextId: 'context-1' }),
    ])
  })
})
