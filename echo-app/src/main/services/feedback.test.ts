import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { Track } from '../../types/ipc'
import type { TasteSignalDraft } from '../skills/memory/feedback'

const mocked = vi.hoisted(() => ({
  recordExplicitTrackFeedback: vi.fn(),
  recordTrackFeedback: vi.fn(),
  buildExplicitTrackFeedbackSignals: vi.fn(() => [] as TasteSignalDraft[]),
  applyMemorySignal: vi.fn(),
  applyMemorySignals: vi.fn(),
}))

vi.mock('../db/feedback', () => ({
  recordExplicitTrackFeedback: mocked.recordExplicitTrackFeedback,
  recordTrackFeedback: mocked.recordTrackFeedback,
}))

vi.mock('../skills/memory/feedback', () => ({
  explicitFeedbackMessages: {
    more_like_this: 'more',
    not_right: 'miss',
  },
  buildExplicitTrackFeedbackSignals: mocked.buildExplicitTrackFeedbackSignals,
}))

vi.mock('./memoryPolicy', () => ({
  applyMemorySignal: mocked.applyMemorySignal,
  applyMemorySignals: mocked.applyMemorySignals,
}))

import { recordFeedback, recordSkippedFeedback } from './feedback'

const track: Track = {
  id: 'track-1',
  title: '主角',
  artist: '王菲',
  source: 'netease',
}

describe('feedback service boundaries', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocked.buildExplicitTrackFeedbackSignals.mockReturnValue([])
  })

  it('rejects unknown feedback actions before writing memory data', async () => {
    await expect(recordFeedback(track, 'bad_action' as never)).rejects.toThrow('未知的反馈动作')

    expect(mocked.recordExplicitTrackFeedback).not.toHaveBeenCalled()
    expect(mocked.buildExplicitTrackFeedbackSignals).not.toHaveBeenCalled()
    expect(mocked.applyMemorySignal).not.toHaveBeenCalled()
  })

  it('applies generated explicit feedback memory signals as one batch', async () => {
    const signals = [
      { kind: 'unlike_track', payload: { title: '主角' }, refreshReason: 'explicit_miss' },
      { kind: 'soften_vibe', payload: { target: '安静' }, refreshReason: 'explicit_miss' },
    ] satisfies TasteSignalDraft[]
    mocked.buildExplicitTrackFeedbackSignals.mockReturnValueOnce(signals)

    await recordFeedback(track, 'not_right', '这首不太对')

    expect(mocked.recordExplicitTrackFeedback).toHaveBeenCalledOnce()
    expect(mocked.applyMemorySignal).not.toHaveBeenCalled()
    expect(mocked.applyMemorySignals).toHaveBeenCalledOnce()
    expect(mocked.applyMemorySignals).toHaveBeenCalledWith(signals, {
      source: 'explicit_feedback',
      track,
    })
  })

  it('records chat skip feedback without writing explicit miss events', async () => {
    await recordSkippedFeedback(track, '下一首')

    expect(mocked.recordExplicitTrackFeedback).not.toHaveBeenCalled()
    expect(mocked.recordTrackFeedback).toHaveBeenCalledWith('skipped', track, 0)
    expect(mocked.applyMemorySignal).toHaveBeenCalledWith('skipped', {
      artist: '王菲',
      trackId: 'track-1',
      title: '主角',
      completionRate: 0,
      context: '下一首',
    }, { source: 'chat', track })
  })
})
