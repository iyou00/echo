import { describe, expect, it } from 'vitest'
import type { Track } from '../../../types/ipc'
import { buildExplicitTrackFeedbackSignals } from './feedback'

describe('explicit track feedback memory signals', () => {
  function semanticTrack(): Track {
    return {
      title: '冷夜',
      artist: '陈默之',
      semantic: {
        language: '华语',
        genres: ['民谣'],
        moods: ['安静'],
        scenes: ['夜晚'],
        energy: 0.35,
        tempo: 'slow',
        familiarity: 'safe',
        confidence: 0.8,
      },
    }
  }

  it('uses the semantic genre as the target for like_genre signals', () => {
    const track: Track = {
      title: '主角',
      artist: '王菲',
      semantic: {
        language: '华语',
        genres: ['华语流行'],
        moods: ['安静'],
        scenes: ['夜晚'],
        energy: 0.42,
        tempo: 'medium',
        familiarity: 'safe',
        confidence: 0.8,
      },
    }

    const genreSignal = buildExplicitTrackFeedbackSignals(track, 'more_like_this', '这类多来一点')
      .find((signal) => signal.kind === 'like_genre')

    expect(genreSignal?.payload).toMatchObject({
      target: '华语流行',
      genre: '华语流行',
      artist: '王菲',
    })
  })

  it('records an explicit track-like signal before broader more-like-this memory', () => {
    const track: Track = {
      id: 'track-1',
      title: '主角',
      artist: '王菲',
    }

    const signals = buildExplicitTrackFeedbackSignals(track, 'more_like_this', '这类多来一点')

    expect(signals[0]).toMatchObject({
      kind: 'like_track',
      refreshReason: 'explicit_like',
      payload: {
        artist: '王菲',
        title: '主角',
        target: '王菲 / 主角',
        reason: '你对这首点过“多来这种”，Echo 会把它当作明确偏好线索。',
      },
    })
    expect(signals).toEqual(expect.arrayContaining([
      expect.objectContaining({ kind: 'like_artist' }),
    ]))
  })

  it('keeps the rejected track negative while learning the requested replacement direction', () => {
    const track = semanticTrack()
    const signals = buildExplicitTrackFeedbackSignals(track, 'not_right', '这首歌不好听，换一首激情一点的')

    expect(signals).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'unlike_track',
        refreshReason: 'explicit_miss',
        payload: expect.objectContaining({ title: '冷夜', artist: '陈默之' }),
      }),
      expect.objectContaining({
        kind: 'reinforce_vibe',
        refreshReason: 'explicit_like',
        payload: expect.objectContaining({ target: '热烈' }),
      }),
    ]))
    expect(signals.some((signal) => signal.kind === 'soften_vibe')).toBe(false)
    expect(signals.some((signal) => signal.kind === 'soften_genre')).toBe(false)
  })

  it('keeps a plain rejected current track scoped to the track only', () => {
    const signals = buildExplicitTrackFeedbackSignals(semanticTrack(), 'not_right', '这首歌不好听')

    expect(signals.map((signal) => signal.kind)).toEqual(['unlike_track'])
  })

  it('learns a replacement direction even when the user omits the change verb', () => {
    const signals = buildExplicitTrackFeedbackSignals(semanticTrack(), 'not_right', '这首不太对，激情一点')

    expect(signals).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'unlike_track',
        refreshReason: 'explicit_miss',
      }),
      expect.objectContaining({
        kind: 'reinforce_vibe',
        refreshReason: 'explicit_like',
        payload: expect.objectContaining({ target: '热烈' }),
      }),
    ]))
  })

  it('softens the rejected vibe only when the user names the mismatch reason', () => {
    const signals = buildExplicitTrackFeedbackSignals(semanticTrack(), 'not_right', '这首太慢了，没劲')

    expect(signals).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'unlike_track',
      }),
      expect.objectContaining({
        kind: 'soften_vibe',
        payload: expect.objectContaining({ target: '安静' }),
      }),
    ]))
    expect(signals.some((signal) => signal.kind === 'soften_genre')).toBe(false)
  })

  it('softens genre only when the user explicitly rejects this class of music', () => {
    const signals = buildExplicitTrackFeedbackSignals(semanticTrack(), 'not_right', '这类民谣有点腻了，少推')

    expect(signals).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'soften_genre',
        payload: expect.objectContaining({ target: '民谣' }),
      }),
    ]))
  })

  it('learns genre direction from a rejected current track replacement request', () => {
    const track: Track = {
      title: '旧歌',
      artist: '旧歌手',
      semantic: {
        language: '华语',
        genres: ['流行'],
        moods: ['安静'],
        scenes: ['夜晚'],
        energy: 0.35,
        tempo: 'slow',
        familiarity: 'safe',
        confidence: 0.8,
      },
    }
    const signals = buildExplicitTrackFeedbackSignals(track, 'not_right', '这首不太对，换一首摇滚一点的')

    expect(signals).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'unlike_track',
        refreshReason: 'explicit_miss',
      }),
      expect.objectContaining({
        kind: 'like_genre',
        refreshReason: 'explicit_like',
        payload: expect.objectContaining({
          target: '摇滚',
          genre: '摇滚',
        }),
      }),
    ]))
  })

  it('does not learn high energy from a request to avoid noisy intense songs', () => {
    const track: Track = {
      title: 'Wake Up',
      artist: 'Arcade Fire',
      semantic: {
        language: '英语',
        genres: ['摇滚'],
        moods: ['热烈'],
        scenes: ['早晨'],
        energy: 0.86,
        tempo: 'fast',
        familiarity: 'explore',
        confidence: 0.8,
      },
    }
    const signals = buildExplicitTrackFeedbackSignals(track, 'not_right', '这首太炸了，换一首别太吵的')

    expect(signals.some((signal) => signal.kind === 'reinforce_vibe' && signal.payload.target === '热烈')).toBe(false)
  })

  it('does not learn high energy from a terse intense-song rejection', () => {
    const signals = buildExplicitTrackFeedbackSignals(semanticTrack(), 'not_right', '这首太激情了')

    expect(signals.some((signal) => signal.kind === 'reinforce_vibe' && signal.payload.target === '热烈')).toBe(false)
  })

  it('treats overly high-energy wording as a rejected vibe without reinforcing heat', () => {
    const track: Track = {
      title: 'Wake Up',
      artist: 'Arcade Fire',
      semantic: {
        language: '英语',
        genres: ['摇滚'],
        moods: ['热烈'],
        scenes: ['早晨'],
        energy: 0.86,
        tempo: 'fast',
        familiarity: 'explore',
        confidence: 0.8,
      },
    }

    const signals = buildExplicitTrackFeedbackSignals(track, 'not_right', '这首太情绪高昂了，换一首安静点')

    expect(signals).toEqual(expect.arrayContaining([
      expect.objectContaining({
        kind: 'unlike_track',
        refreshReason: 'explicit_miss',
      }),
      expect.objectContaining({
        kind: 'soften_vibe',
        refreshReason: 'explicit_miss',
        payload: expect.objectContaining({ target: '热烈' }),
      }),
      expect.objectContaining({
        kind: 'reinforce_vibe',
        refreshReason: 'explicit_like',
        payload: expect.objectContaining({ target: '放松' }),
      }),
    ]))
    expect(signals.some((signal) => signal.kind === 'reinforce_vibe' && signal.payload.target === '热烈')).toBe(false)
  })

  it('does not learn calm from a terse quiet-song rejection', () => {
    const signals = buildExplicitTrackFeedbackSignals(semanticTrack(), 'not_right', '这首太安静了')

    expect(signals.some((signal) => signal.kind === 'reinforce_vibe' && signal.payload.target === '放松')).toBe(false)
  })
})
