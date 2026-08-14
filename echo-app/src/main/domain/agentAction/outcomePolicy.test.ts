import { describe, expect, it } from 'vitest'
import { classifyPlaybackOutcome } from './outcomePolicy'

const base = { playbackInstanceId: 'play-1', actionId: 'action-1', durationMs: 100_000 } as const

describe('playback outcome policy', () => {
  it('keeps a real system failure out of negative user feedback', () => {
    expect(classifyPlaybackOutcome({ ...base, positionMs: 2_000, reason: 'system_failure' })).toMatchObject({
      outcomeType: 'system_failure', polarity: 'system', sourceEventKey: 'playback_final:play-1',
    })
  })

  it('uses explicit boundary rules for skips, effective listens and completion', () => {
    expect(classifyPlaybackOutcome({ ...base, positionMs: 29_000, reason: 'next' }).outcomeType).toBe('quick_skip')
    expect(classifyPlaybackOutcome({ ...base, positionMs: 30_000, reason: 'next' }).outcomeType).toBe('effective_listen')
    expect(classifyPlaybackOutcome({ ...base, durationMs: 200_000, positionMs: 35_000, reason: 'next' }).outcomeType).toBe('user_stop')
    expect(classifyPlaybackOutcome({ ...base, durationMs: 200_000, positionMs: 60_000, reason: 'next' }).outcomeType).toBe('effective_listen')
    expect(classifyPlaybackOutcome({ ...base, positionMs: 80_000, reason: 'ended' }).outcomeType).toBe('completed')
  })
})
