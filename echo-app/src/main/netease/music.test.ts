import { describe, expect, it } from 'vitest'
import type { Track } from '../../types/ipc'
import { neteaseMusicTestHelpers } from './music'

function track(id: string): Track {
  return {
    id,
    title: `歌曲${id}`,
    artist: `歌手${id}`,
    source: 'netease',
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

describe('netease playable filtering', () => {
  it('keeps candidate order even when later playable lookups finish first', async () => {
    const candidates = [track('1'), track('2'), track('3')]
    const result = await neteaseMusicTestHelpers.collectPlayableTracksInOrder(
      candidates,
      2,
      undefined,
      async (candidate) => {
        if (candidate.id === '1') await delay(25)
        if (candidate.id === '2') await delay(1)
        return { ...candidate, playUrl: `https://example.com/${candidate.id}.mp3` }
      },
    )

    expect(result.tracks.map((item) => item.id)).toEqual(['1', '2'])
    expect(result.attemptedCount).toBe(3)
    expect(result.failCount).toBe(0)
  })

  it('skips failed candidates while preserving the order of successful ones', async () => {
    const candidates = [track('1'), track('2'), track('3')]
    const result = await neteaseMusicTestHelpers.collectPlayableTracksInOrder(
      candidates,
      2,
      undefined,
      async (candidate) => (candidate.id === '2'
        ? null
        : { ...candidate, playUrl: `https://example.com/${candidate.id}.mp3` }),
    )

    expect(result.tracks.map((item) => item.id)).toEqual(['1', '3'])
    expect(result.failCount).toBe(1)
  })
})
