import { describe, expect, it } from 'vitest'
import type { ActiveScene } from '../types/ipc'
import { isVoiceContinuousActive, scenePlaybackStatePatch, voiceContinuousStatePatch } from './appState'

const scene: ActiveScene = {
  id: 3,
  key: 'relax',
  label: '松口气',
  shortLabel: '松口气',
  line: '松口气',
  prompt: '松口气',
  status: 'active',
  startedAt: '2026-06-17T08:00:00.000Z',
  expiresAt: '2026-06-17T10:00:00.000Z',
  targetCount: 1,
  moods: ['放松'],
  scenes: ['休息'],
  energy: 'low',
  tempo: 'slow',
  familiarity: 'balanced',
}

describe('voice continuous app boundaries', () => {
  it('keeps continuous voice ownership active until the user turns it off', () => {
    expect(isVoiceContinuousActive('voice', true)).toBe(true)
    expect(isVoiceContinuousActive('chat', true)).toBe(true)
    expect(isVoiceContinuousActive('queue', true)).toBe(true)
    expect(isVoiceContinuousActive('voice', false)).toBe(false)
  })

  it('clears active scene ownership when continuous voice starts', () => {
    expect(voiceContinuousStatePatch(true)).toEqual({ voiceContinuous: true, currentScene: null })
  })

  it('keeps scene ownership untouched when continuous voice stops', () => {
    expect(voiceContinuousStatePatch(false)).toEqual({ voiceContinuous: false })
  })

  it('makes scene playback own the mode explicitly', () => {
    expect(scenePlaybackStatePatch(scene)).toEqual({ currentScene: scene, voiceContinuous: false })
  })
})
