import { describe, expect, it } from 'vitest'
import { createUiBoundary } from '../../shared/uiBoundary'

describe('ui boundary contract', () => {
  it('preserves the active listening state during system recovery', () => {
    const snapshot = createUiBoundary('playback_recovering')

    expect(snapshot.scope).toBe('inline')
    expect(snapshot.retryable).toBe(true)
    expect(snapshot.preserved).toEqual(expect.arrayContaining(['currentTrack', 'position', 'queue']))
  })

  it('keeps task failures in the system path instead of user feedback', () => {
    const snapshot = createUiBoundary('task_failed', { sourceId: 'task-7' })

    expect(snapshot.code).toBe('task_failed')
    expect(snapshot.sourceId).toBe('task-7')
    expect(snapshot.preserved).toContain('userData')
  })

  it('supports controlled field summaries for invalid imports', () => {
    const snapshot = createUiBoundary('import_invalid', {
      details: { invalidFields: ['title', 'artist'], invalidItems: 3, totalItems: 3 },
    })

    expect(snapshot.details).toEqual({ invalidFields: ['title', 'artist'], invalidItems: 3, totalItems: 3 })
    expect(snapshot.preserved).toEqual(expect.arrayContaining(['existingLibrary', 'tasteProfile']))
  })
})
