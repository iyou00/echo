import { describe, expect, it } from 'vitest'
import type { Track } from '../../types/ipc'
import { nextVoiceFailureAction, shouldAcceptVoiceContinuousTrigger, shouldTriggerNextVoiceSegment } from './voiceContinuous'

describe('voice continuous playback boundaries', () => {
  it('continues after a text-only segment when no background music started', () => {
    expect(shouldTriggerNextVoiceSegment({
      isActive: true,
      voiceContinuous: true,
      status: 'text-only-done',
      musicStarted: false,
      baselinePlaybackKey: '',
      current: null,
    })).toBe(true)
  })

  it('continues after a text-only segment while the pre-existing baseline keeps playing', () => {
    const current: Track = { id: 'baseline', title: '原来的歌', artist: 'Echo' }

    expect(shouldTriggerNextVoiceSegment({
      isActive: true,
      voiceContinuous: true,
      status: 'text-only-done',
      musicStarted: false,
      baselinePlaybackKey: 'id:baseline',
      current,
    })).toBe(true)
  })

  it('lets new ordinary playback take over after a text-only segment', () => {
    const current: Track = { id: 'other', title: '新点的歌', artist: 'Echo' }

    expect(shouldTriggerNextVoiceSegment({
      isActive: true,
      voiceContinuous: true,
      status: 'text-only-done',
      musicStarted: false,
      baselinePlaybackKey: 'id:baseline',
      current,
    })).toBe(false)
  })

  it('waits while the voice-owned background track is still playing', () => {
    const current: Track = { title: '回声歌', artist: 'Echo', sourceContext: 'voice' }

    expect(shouldTriggerNextVoiceSegment({
      isActive: true,
      voiceContinuous: true,
      status: 'done',
      musicStarted: true,
      baselinePlaybackKey: '',
      current,
    })).toBe(false)
  })

  it('waits while a text-only segment has started voice-owned music', () => {
    const current: Track = { title: '只有文字时的歌', artist: 'Echo', sourceContext: 'voice' }

    expect(shouldTriggerNextVoiceSegment({
      isActive: true,
      voiceContinuous: true,
      status: 'text-only-done',
      musicStarted: true,
      baselinePlaybackKey: '',
      current,
    })).toBe(false)
  })

  it('continues when the voice-owned background track has ended', () => {
    expect(shouldTriggerNextVoiceSegment({
      isActive: true,
      voiceContinuous: true,
      status: 'done',
      musicStarted: true,
      baselinePlaybackKey: '',
      current: null,
    })).toBe(true)
  })

  it('waits while the pre-existing baseline track is still playing', () => {
    const current: Track = { id: 'baseline', title: '原来的歌', artist: 'Echo' }

    expect(shouldTriggerNextVoiceSegment({
      isActive: true,
      voiceContinuous: true,
      status: 'done',
      musicStarted: true,
      baselinePlaybackKey: 'id:baseline',
      current,
    })).toBe(false)
  })

  it('lets ordinary playback take over when another track replaces the voice background', () => {
    const current: Track = { id: 'other', title: '别的歌', artist: 'Echo' }

    expect(shouldTriggerNextVoiceSegment({
      isActive: true,
      voiceContinuous: true,
      status: 'done',
      musicStarted: true,
      baselinePlaybackKey: 'id:baseline',
      current,
    })).toBe(false)
  })

  it('stays quiet when the voice page is inactive or continuous mode is off', () => {
    expect(shouldTriggerNextVoiceSegment({
      isActive: false,
      voiceContinuous: true,
      status: 'done',
      musicStarted: false,
      baselinePlaybackKey: '',
      current: null,
    })).toBe(false)
    expect(shouldTriggerNextVoiceSegment({
      isActive: true,
      voiceContinuous: false,
      status: 'done',
      musicStarted: false,
      baselinePlaybackKey: '',
      current: null,
    })).toBe(false)
  })

  it('debounces duplicate continuous triggers from playback and page effects', () => {
    expect(shouldAcceptVoiceContinuousTrigger(0, 1000)).toBe(true)
    expect(shouldAcceptVoiceContinuousTrigger(1000, 1800)).toBe(false)
    expect(shouldAcceptVoiceContinuousTrigger(1000, 2600)).toBe(true)
  })

  it('retries one automatic failure and stops after the second', () => {
    expect(nextVoiceFailureAction({ automatic: true, continuous: true, previousFailures: 0 })).toEqual({
      action: 'retry',
      failureCount: 1,
    })
    expect(nextVoiceFailureAction({ automatic: true, continuous: true, previousFailures: 1 })).toEqual({
      action: 'stop',
      failureCount: 2,
    })
    expect(nextVoiceFailureAction({ automatic: false, continuous: true, previousFailures: 0 }).action).toBe('error')
  })
})
