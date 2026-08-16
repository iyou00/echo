import { describe, expect, it } from 'vitest'
import { deriveChatStageMode, deriveWindowFieldMode } from './stageMode'

describe('stage mode', () => {
  it('shows the listening stage while the view is open with a track', () => {
    expect(deriveWindowFieldMode({
      page: 'chat', voiceContinuous: false, currentScene: true,
      hasCurrentTrack: true, listeningViewOpen: true, chatStageMode: 'chat',
    })).toBe('listening')
  })

  it('keeps the listening stage open while paused (decoupled from transport)', () => {
    expect(deriveWindowFieldMode({
      page: 'chat', voiceContinuous: false, currentScene: false,
      hasCurrentTrack: true, listeningViewOpen: true, chatStageMode: 'chat',
    })).toBe('listening')
  })

  it('returns to the scene stage after the listening view closes', () => {
    expect(deriveWindowFieldMode({
      page: 'chat', voiceContinuous: false, currentScene: true,
      hasCurrentTrack: true, listeningViewOpen: false, chatStageMode: 'chat',
    })).toBe('scene')
  })

  it('falls back to the chat stage after the listening view closes', () => {
    expect(deriveWindowFieldMode({
      page: 'chat', voiceContinuous: false, currentScene: false,
      hasCurrentTrack: true, listeningViewOpen: false, chatStageMode: 'chat',
    })).toBe('chat')
  })

  it('ignores the view flag when no track is present', () => {
    expect(deriveWindowFieldMode({
      page: 'chat', voiceContinuous: false, currentScene: false,
      hasCurrentTrack: false, listeningViewOpen: true, chatStageMode: 'idle',
    })).toBe('idle')
  })

  it.each([
    ['recommendation', 'searching'],
    ['weather', 'searching'],
    ['stream', 'streaming'],
    ['intent', 'streaming'],
  ] as const)('maps a running %s phase to %s', (taskPhase, expected) => {
    expect(deriveChatStageMode({ hasDialogue: true, sending: true, taskPhase, hasError: false })).toBe(expected)
  })

  it('lets a visible failure override an in-flight state', () => {
    expect(deriveChatStageMode({ hasDialogue: true, sending: true, taskPhase: 'stream', hasError: true })).toBe('error')
  })

  it('keeps a restored runtime task visibly in flight', () => {
    expect(deriveChatStageMode({ hasDialogue: true, sending: true, taskPhase: 'recommendation', hasError: false })).toBe('searching')
  })
})
