import { describe, expect, it } from 'vitest'
import type { Track } from '../../types/ipc'
import { neteaseMusicTestHelpers, normalizeNeteaseTrack } from './music'

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

describe('netease track normalization', () => {
  it('keeps a valid publish time for latest-song ordering', () => {
    const normalized = normalizeNeteaseTrack({
      id: 1,
      name: '新歌',
      ar: [{ name: '陈默之' }],
      publishTime: Date.UTC(2026, 7, 1),
    })

    expect(normalized).toMatchObject({
      year: 2026,
      publishedAt: '2026-08-01T00:00:00.000Z',
    })
  })

  it('keeps album artwork for the sound object', () => {
    const normalized = normalizeNeteaseTrack({
      id: 2,
      name: '有封面的歌',
      ar: [{ name: '陈默之' }],
      al: { name: '此刻', picUrl: 'https://example.com/cover.jpg' },
    })

    expect(normalized).toMatchObject({
      album: '此刻',
      artworkUrl: 'https://example.com/cover.jpg',
    })
  })

  it.each([Number.POSITIVE_INFINITY, Number.NaN, 9e15, -1])(
    'ignores an invalid publish time without rejecting the track: %s',
    (publishTime) => {
      const normalized = normalizeNeteaseTrack({
        id: 1,
        name: '时间未知的歌',
        ar: [{ name: '陈默之' }],
        publishTime,
      })

      expect(normalized).toMatchObject({ title: '时间未知的歌', artist: '陈默之' })
      expect(normalized?.year).toBeUndefined()
      expect(normalized?.publishedAt).toBeUndefined()
    },
  )
})
