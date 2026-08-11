import { beforeEach, describe, expect, it } from 'vitest'
import { emitRuntimeEvent, onRuntimeEvent, setRuntimeBroadcaster } from './eventBus'
import {
  clearRuntimeTasks,
  finishTask,
  getRecentTasks,
  startTask,
} from './taskRegistry'

describe('runtime visibility boundaries', () => {
  beforeEach(() => {
    clearRuntimeTasks()
    setRuntimeBroadcaster(null)
  })

  it('keeps separate recent-task budgets for user and internal work', () => {
    const user = startTask({ kind: 'chat-send', visibility: 'user' })
    finishTask(user.snapshot.id, 'succeeded')

    for (let index = 0; index < 60; index += 1) {
      const internal = startTask({ kind: 'taste-refresh', visibility: 'internal' })
      finishTask(internal.snapshot.id, 'succeeded')
    }

    expect(getRecentTasks('user').map((task) => task.id)).toContain(user.snapshot.id)
    expect(getRecentTasks('internal')).toHaveLength(50)
  })

  it('keeps internal events inside the main process', () => {
    const broadcasts: string[] = []
    const localEvents: string[] = []
    setRuntimeBroadcaster((channel) => broadcasts.push(channel))
    const off = onRuntimeEvent((event) => localEvents.push(event.channel))

    emitRuntimeEvent({
      kind: 'taste-refresh',
      channel: 'internal:progress',
      payload: {},
      visibility: 'internal',
    })
    emitRuntimeEvent({
      kind: 'chat-send',
      channel: 'chat:visible',
      payload: {},
      visibility: 'user',
    })

    off()
    expect(localEvents).toEqual(['internal:progress', 'chat:visible'])
    expect(broadcasts).toEqual(['runtime:event', 'chat:visible'])
  })
})
