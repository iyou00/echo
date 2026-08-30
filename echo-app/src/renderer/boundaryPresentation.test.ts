import { describe, expect, it } from 'vitest'
import type { UiBoundaryCode } from '../types/ipc'
import { boundaryPresentation } from './boundaryPresentation'

describe('boundary presentation', () => {
  it('does not frame a system failure as dislike feedback', () => {
    const copy = boundaryPresentation({
      code: 'task_failed',
      scope: 'inline',
      retryable: true,
      preserved: ['userData'],
      occurredAt: '2026-08-14T00:00:00.000Z',
    })

    expect(copy.body).toContain('系统失败')
    expect(copy.body).toContain('不会记成你的负反馈')
  })

  it('adds controlled import field labels without exposing parser errors', () => {
    const copy = boundaryPresentation({
      code: 'import_invalid',
      scope: 'inline',
      retryable: true,
      preserved: [],
      occurredAt: '2026-08-14T00:00:00.000Z',
      details: { invalidFields: ['title', 'artist'], invalidItems: 2, totalItems: 2 },
    })

    expect(copy.body).toContain('歌名 title')
    expect(copy.body).toContain('歌手 artist')
    expect(copy.body).not.toContain('undefined')
  })

  it('has copy for every controlled code', () => {
    const codes: UiBoundaryCode[] = [
      'startup_failed', 'startup_degraded', 'model_missing', 'model_invalid', 'music_empty', 'queue_empty', 'taste_empty',
      'context_empty', 'offline', 'no_playable', 'playback_recovering', 'mic_denied', 'tts_fallback',
      'yinyi_empty', 'yinyi_failed', 'task_failed', 'import_invalid', 'close_busy',
    ]
    for (const code of codes) {
      const copy = boundaryPresentation({ code, scope: 'surface', retryable: true, preserved: [], occurredAt: '' })
      expect(copy.title.length).toBeGreaterThan(0)
      expect(copy.body.length).toBeGreaterThan(0)
    }
  })
})
