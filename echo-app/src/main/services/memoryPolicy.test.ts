import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  applySignal: vi.fn(async () => ({})),
  maybeRefreshStructuredProfile: vi.fn(),
  getTrackFeedback: vi.fn(() => null),
}))

vi.mock('../db/feedback', () => ({
  getTrackFeedback: mocks.getTrackFeedback,
}))

vi.mock('./taste', () => ({
  applySignal: mocks.applySignal,
  maybeRefreshStructuredProfile: mocks.maybeRefreshStructuredProfile,
}))

import { applyMemorySignal, applyMemorySignals } from './memoryPolicy'

describe('memory policy service boundaries', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('keeps short-term context events out of structured profile refresh', async () => {
    await expect(applyMemorySignal('event_started', {
      target: '觉得有点冷',
      strength: 0.08,
      weight: 0.32,
    }, { source: 'chat' })).resolves.toBe(true)

    expect(mocks.applySignal).toHaveBeenCalledWith('event_started', expect.objectContaining({
      target: '觉得有点冷',
    }))
    expect(mocks.maybeRefreshStructuredProfile).not.toHaveBeenCalled()
  })

  it('still refreshes structured profile for durable chat preference signals', async () => {
    await expect(applyMemorySignal('like_artist', {
      artist: '王菲',
      target: '王菲',
      strength: 0.08,
    }, { source: 'chat' })).resolves.toBe(true)

    expect(mocks.applySignal).toHaveBeenCalledWith('like_artist', expect.objectContaining({
      target: '王菲',
    }))
    expect(mocks.maybeRefreshStructuredProfile).toHaveBeenCalledWith('chat_signal')
  })

  it('refreshes structured profile once for a batch of durable memory signals', async () => {
    await expect(applyMemorySignals([
      { kind: 'unlike_track', payload: { title: '主角', artist: '王菲' }, refreshReason: 'explicit_miss' },
      { kind: 'soften_vibe', payload: { target: '安静' }, refreshReason: 'explicit_miss' },
      { kind: 'reinforce_vibe', payload: { target: '热烈' }, refreshReason: 'explicit_like' },
    ], { source: 'explicit_feedback' })).resolves.toBe(true)

    expect(mocks.applySignal).toHaveBeenCalledTimes(3)
    expect(mocks.applySignal).toHaveBeenNthCalledWith(2, 'soften_vibe', expect.objectContaining({
      target: '安静',
      strength: 0.04,
    }))
    expect(mocks.applySignal).toHaveBeenNthCalledWith(3, 'reinforce_vibe', expect.objectContaining({
      target: '热烈',
      strength: 0.055,
    }))
    expect(mocks.maybeRefreshStructuredProfile).toHaveBeenCalledTimes(1)
    expect(mocks.maybeRefreshStructuredProfile).toHaveBeenCalledWith('explicit_miss')
  })

  it('does not refresh structured profile for a batch that only contains short-term context events', async () => {
    await expect(applyMemorySignals([
      { kind: 'event_started', payload: { target: '觉得有点冷' }, refreshReason: 'chat_signal' },
      { kind: 'event_ended', payload: { target: '冷' }, refreshReason: 'chat_signal' },
    ], { source: 'chat' })).resolves.toBe(true)

    expect(mocks.applySignal).toHaveBeenCalledTimes(2)
    expect(mocks.maybeRefreshStructuredProfile).not.toHaveBeenCalled()
  })
})
