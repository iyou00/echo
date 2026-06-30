import { describe, expect, it } from 'vitest'
import type { RuntimeTaskSnapshot } from '../../types/ipc'
import { runtimeTaskNeedsAttention } from './useRuntimeTasks'

function task(status: RuntimeTaskSnapshot['status']): RuntimeTaskSnapshot {
  return {
    id: `task-${status}`,
    kind: 'scheduler-catchup',
    status,
    phase: 'done',
    current: 1,
    total: 1,
    startedAt: '2026-06-19T00:00:00.000Z',
    updatedAt: '2026-06-19T00:00:00.000Z',
    cancellable: false,
    visibility: 'user',
  }
}

describe('runtime task display attention filter', () => {
  it('keeps running and failed tasks visible', () => {
    expect(runtimeTaskNeedsAttention(task('running'))).toBe(true)
    expect(runtimeTaskNeedsAttention(task('failed'))).toBe(true)
  })

  it('hides completed task history from the settings task panel', () => {
    expect(runtimeTaskNeedsAttention(task('succeeded'))).toBe(false)
    expect(runtimeTaskNeedsAttention(task('canceled'))).toBe(false)
  })
})
