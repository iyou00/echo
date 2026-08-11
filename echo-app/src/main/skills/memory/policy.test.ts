import { describe, expect, it } from 'vitest'
import { decideMemorySignal } from './policy'

describe('memory policy decisions', () => {
  it('treats explicit track likes as positive memory', () => {
    const decision = decideMemorySignal({
      kind: 'like_track',
      source: 'explicit_feedback',
      payload: {
        artist: '王菲',
        title: '主角',
        target: '王菲 / 主角',
      },
    })

    expect(decision.apply).toBe(true)
    expect(decision.refreshReason).toBe('explicit_like')
    expect(decision.payload.strength).toBeGreaterThanOrEqual(0.08)
    expect(decision.note).toContain('克制写入')
  })

  it('keeps broader explicit likes weaker than track likes', () => {
    const artist = decideMemorySignal({
      kind: 'like_artist',
      source: 'explicit_feedback',
      payload: {
        artist: '王菲',
        target: '王菲',
        strength: 0.04,
      },
    })
    const genre = decideMemorySignal({
      kind: 'like_genre',
      source: 'explicit_feedback',
      payload: {
        target: '华语流行',
        strength: 0.04,
      },
    })

    expect(artist.payload.strength).toBe(0.04)
    expect(genre.payload.strength).toBe(0.04)
  })

  it('caps inferred vibe reinforcement from a single explicit feedback action', () => {
    const decision = decideMemorySignal({
      kind: 'reinforce_vibe',
      source: 'explicit_feedback',
      payload: {
        target: '安静',
        strength: 0.1,
      },
    })

    expect(decision.payload.strength).toBe(0.075)
  })

  it('keeps replacement direction strong enough to guide the next recommendation', () => {
    const decision = decideMemorySignal({
      kind: 'reinforce_vibe',
      source: 'explicit_feedback',
      payload: {
        target: '热烈',
        strength: 0.055,
      },
    })

    expect(decision.payload.strength).toBe(0.055)
  })

  it('keeps explicit track misses as negative memory', () => {
    const decision = decideMemorySignal({
      kind: 'unlike_track',
      source: 'explicit_feedback',
      payload: {
        artist: '王菲',
        title: '主角',
        target: '王菲 / 主角',
      },
    })

    expect(decision.apply).toBe(true)
    expect(decision.refreshReason).toBe('explicit_miss')
    expect(decision.payload.strength).toBe(0.04)
  })

  it('keeps a single skip as a recorded fact before it enters durable memory', () => {
    const decision = decideMemorySignal({
      kind: 'skipped',
      source: 'playback',
      payload: {
        artist: '王菲',
        title: '主角',
        completionRate: 0.12,
      },
      feedback: {
        trackKey: 'name:主角::王菲',
        track: { title: '主角', artist: '王菲' },
        score: -0.5,
        playCount: 0,
        skipCount: 1,
        loopCount: 0,
        favoriteCount: 0,
        explicitLikeCount: 0,
        explicitMissCount: 0,
      },
    })

    expect(decision.apply).toBe(false)
    expect(decision.refreshReason).toBe('skipped')
    expect(decision.note).toContain('单次跳过')
  })

  it('turns repeated skips into a durable negative memory signal', () => {
    const decision = decideMemorySignal({
      kind: 'skipped',
      source: 'playback',
      payload: {
        artist: '王菲',
        title: '主角',
        completionRate: 0.12,
      },
      feedback: {
        trackKey: 'name:主角::王菲',
        track: { title: '主角', artist: '王菲' },
        score: -1.5,
        playCount: 0,
        skipCount: 3,
        loopCount: 0,
        favoriteCount: 0,
        explicitLikeCount: 0,
        explicitMissCount: 0,
      },
    })

    expect(decision.apply).toBe(true)
    expect(decision.refreshReason).toBe('skipped')
    expect(decision.payload.strength).toBe(0.015)
    expect(decision.note).toContain('重复跳过')
  })

  it('keeps completed playback as weak positive evidence before repeated listening', () => {
    const decision = decideMemorySignal({
      kind: 'played',
      source: 'playback',
      payload: {
        artist: '王菲',
        title: '主角',
        completionRate: 0.92,
      },
      feedback: {
        trackKey: 'name:主角::王菲',
        track: { title: '主角', artist: '王菲' },
        score: 0.5,
        playCount: 1,
        skipCount: 0,
        loopCount: 0,
        favoriteCount: 0,
        explicitLikeCount: 0,
        explicitMissCount: 0,
      },
    })

    expect(decision.apply).toBe(true)
    expect(decision.refreshReason).toBe('played')
    expect(decision.payload.strength).toBe(0.02)
    expect(decision.note).toContain('弱正向信号')
  })

  it('strengthens completed playback only after repeated listening', () => {
    const decision = decideMemorySignal({
      kind: 'played',
      source: 'playback',
      payload: {
        artist: '王菲',
        title: '主角',
        completionRate: 0.92,
      },
      feedback: {
        trackKey: 'name:主角::王菲',
        track: { title: '主角', artist: '王菲' },
        score: 1.5,
        playCount: 3,
        skipCount: 0,
        loopCount: 0,
        favoriteCount: 0,
        explicitLikeCount: 0,
        explicitMissCount: 0,
      },
    })

    expect(decision.apply).toBe(true)
    expect(decision.refreshReason).toBe('played_repeated')
    expect(decision.payload.strength).toBe(0.04)
    expect(decision.note).toContain('中期偏好')
  })
})
