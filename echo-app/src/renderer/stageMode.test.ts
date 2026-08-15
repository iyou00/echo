import { describe, expect, it } from 'vitest'
import { deriveChatStageMode, deriveWindowFieldMode } from './stageMode'

describe('stage mode', () => {
  it('shows the listening stage while a scene track is actually playing', () => {
    expect(deriveWindowFieldMode({
      page: 'chat', voiceContinuous: false, currentScene: true,
      playbackStatus: 'paused', localPlaybackActive: true, chatStageMode: 'chat',
    })).toBe('listening')
  })

  it('keeps a paused scene in its scene stage', () => {
    expect(deriveWindowFieldMode({
      page: 'chat', voiceContinuous: false, currentScene: true,
      playbackStatus: 'paused', localPlaybackActive: false, chatStageMode: 'chat',
    })).toBe('scene')
  })

  it('falls back to the chat stage after the listening stage is dismissed', () => {
    expect(deriveWindowFieldMode({
      page: 'chat', voiceContinuous: false, currentScene: false,
      playbackStatus: 'playing', localPlaybackActive: true, chatStageMode: 'chat',
      listeningDismissed: true,
    })).toBe('chat')
  })

  it('returns to the listening stage when dismissal is cleared', () => {
    expect(deriveWindowFieldMode({
      page: 'chat', voiceContinuous: false, currentScene: false,
      playbackStatus: 'playing', localPlaybackActive: true, chatStageMode: 'chat',
      listeningDismissed: false,
    })).toBe('listening')
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
