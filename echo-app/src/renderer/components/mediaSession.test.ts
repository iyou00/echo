import { describe, expect, it, vi } from 'vitest'
import { installMediaSessionActions } from './mediaSession'

describe('player media session actions', () => {
  it('routes system playback and seek actions to the current player callbacks', () => {
    const handlers = new Map<MediaSessionAction, MediaSessionActionHandler | null>()
    const mediaSession = {
      setActionHandler(action: MediaSessionAction, handler: MediaSessionActionHandler | null) {
        handlers.set(action, handler)
      },
    }
    const actions = {
      play: vi.fn(),
      pause: vi.fn(),
      previous: vi.fn(),
      next: vi.fn(),
      seek: vi.fn(),
    }
    const cleanup = installMediaSessionActions(mediaSession, actions)

    handlers.get('play')?.({ action: 'play' })
    handlers.get('pause')?.({ action: 'pause' })
    handlers.get('previoustrack')?.({ action: 'previoustrack' })
    handlers.get('nexttrack')?.({ action: 'nexttrack' })
    handlers.get('seekto')?.({ action: 'seekto', seekTime: 42 })

    expect(actions.play).toHaveBeenCalledOnce()
    expect(actions.pause).toHaveBeenCalledOnce()
    expect(actions.previous).toHaveBeenCalledOnce()
    expect(actions.next).toHaveBeenCalledOnce()
    expect(actions.seek).toHaveBeenCalledWith({ action: 'seekto', seekTime: 42 })

    cleanup()
    expect(Array.from(handlers.values()).every((handler) => handler === null)).toBe(true)
  })

  it('keeps supported actions active when Chromium rejects an optional action', () => {
    const installed: MediaSessionAction[] = []
    const mediaSession = {
      setActionHandler(action: MediaSessionAction) {
        if (action === 'seekforward') throw new Error('unsupported')
        installed.push(action)
      },
    }
    const noop = () => undefined

    expect(() => installMediaSessionActions(mediaSession, {
      play: noop,
      pause: noop,
      previous: noop,
      next: noop,
      seek: noop,
    })).not.toThrow()
    expect(installed).toContain('play')
    expect(installed).toContain('seekbackward')
  })
})
