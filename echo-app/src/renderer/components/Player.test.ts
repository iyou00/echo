import { describe, expect, it } from 'vitest'
import type { ActiveScene, Track } from '../../types/ipc'
import { decidePlaybackCompletionAction } from './playerCompletion'

const scene: ActiveScene = {
  id: 7,
  key: 'focus',
  label: '专注',
  shortLabel: '专注',
  prompt: '专注',
  status: 'active',
  startedAt: '2026-06-17T08:00:00.000Z',
  expiresAt: '2026-06-17T10:00:00.000Z',
  targetCount: 1,
  moods: ['清醒'],
  scenes: ['下午工作'],
  energy: 'medium',
  tempo: 'medium',
  familiarity: 'balanced',
  line: '专注',
}

describe('playback completion priority', () => {
  it('keeps continuous voice above scene and auto play', () => {
    const current: Track = { title: '场景歌', artist: 'Echo', sceneSessionId: scene.id }

    expect(decidePlaybackCompletionAction({
      voiceContinuous: true,
      currentScene: scene,
      current,
      autoPlayNext: true,
    })).toBe('voice_continue')
  })

  it('keeps continuous voice above ordinary queue auto play', () => {
    const current: Track = { title: '普通歌', artist: 'Echo' }

    expect(decidePlaybackCompletionAction({
      voiceContinuous: true,
      currentScene: null,
      current,
      autoPlayNext: true,
    })).toBe('voice_continue')
  })

  it('finishes a voice-owned track instead of falling into global auto play', () => {
    const current: Track = { title: '回声歌', artist: 'Echo', sourceContext: 'voice' }

    expect(decidePlaybackCompletionAction({
      voiceContinuous: false,
      currentScene: null,
      current,
      autoPlayNext: true,
    })).toBe('finish')
  })

  it('continues the active scene before global auto play', () => {
    const current: Track = { title: '场景歌', artist: 'Echo', sceneSessionId: scene.id }

    expect(decidePlaybackCompletionAction({
      voiceContinuous: false,
      currentScene: scene,
      current,
      autoPlayNext: true,
    })).toBe('scene_continue')
  })

  it('plays a buffered scene track before asking for more recommendations', () => {
    const current: Track = { title: '场景歌', artist: 'Echo', sceneSessionId: scene.id }
    const buffered: Track = { title: '下一首', artist: 'Echo', sceneSessionId: scene.id }

    expect(decidePlaybackCompletionAction({
      voiceContinuous: false,
      currentScene: scene,
      current,
      queue: [buffered],
      autoPlayNext: true,
    })).toBe('scene_next')
  })

  it('does not let an unrelated queue item inherit scene continuation', () => {
    const current: Track = { title: '场景歌', artist: 'Echo', sceneSessionId: scene.id }
    const ordinary: Track = { title: '普通下一首', artist: 'Echo' }
    const buffered: Track = { title: '稍后的场景歌', artist: 'Echo', sceneSessionId: scene.id }

    expect(decidePlaybackCompletionAction({ voiceContinuous: false, currentScene: scene, current, queue: [ordinary, buffered], autoPlayNext: true })).toBe('scene_continue')
  })

  it('uses auto play for ordinary playback when no higher mode owns the track', () => {
    const current: Track = { title: '普通歌', artist: 'Echo' }

    expect(decidePlaybackCompletionAction({
      voiceContinuous: false,
      currentScene: scene,
      current,
      autoPlayNext: true,
    })).toBe('auto_next')
  })

  it('finishes ordinary playback when auto play is disabled', () => {
    const current: Track = { title: '普通歌', artist: 'Echo' }

    expect(decidePlaybackCompletionAction({
      voiceContinuous: false,
      currentScene: null,
      current,
      autoPlayNext: false,
    })).toBe('finish')
  })
})
