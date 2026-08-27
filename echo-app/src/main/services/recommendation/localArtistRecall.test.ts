import { describe, expect, it } from 'vitest'
import { localLibraryArtistTracks } from './recall'
import type { Track } from '../../../types/ipc'

const mockTracks: Track[] = [
  { id: '1', title: '夺舍', artist: '陈默之', year: 2024, playUrl: 'http://a.mp3' },
  { id: '2', title: '十二月的秘密', artist: '陈默之', year: 2023, playUrl: 'http://b.mp3' },
  { id: '3', title: '晴天', artist: '周杰伦', year: 2003, playUrl: 'http://c.mp3' },
  { id: '4', title: 'Lampshades on Fire', artist: 'Modest Mouse', year: 2015, playUrl: 'http://d.mp3' },
]

describe('local library artist recall', () => {
  it('finds tracks by exact artist name', () => {
    const tracks = localLibraryArtistTracks('陈默之', 3, mockTracks)
    expect(tracks.length).toBeGreaterThanOrEqual(2)
    expect(tracks.every((track) => track.artist.includes('陈默之'))).toBe(true)
  })

  it('finds tracks with partial artist name', () => {
    const tracks = localLibraryArtistTracks('陈默', 3, mockTracks)
    expect(tracks.length).toBeGreaterThanOrEqual(1)
  })

  it('returns empty for an artist not in the pool', () => {
    const tracks = localLibraryArtistTracks('不存在的歌手XYZ', 3, mockTracks)
    expect(tracks).toHaveLength(0)
  })

  it('sorts by recency (newest first)', () => {
    const tracks = localLibraryArtistTracks('陈默之', 10, mockTracks)
    expect(tracks[0].year).toBeGreaterThanOrEqual(tracks[tracks.length - 1].year ?? 0)
  })

  it('caps results at targetCount (minimum 5)', () => {
    const tracks = localLibraryArtistTracks('陈默之', 1, mockTracks)
    expect(tracks.length).toBeLessThanOrEqual(5)
  })
})
