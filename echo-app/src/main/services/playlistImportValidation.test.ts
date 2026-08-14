import { describe, expect, it } from 'vitest'
import { normalizePlaylist, PlaylistValidationError } from './playlistImportValidation'

describe('playlist import validation', () => {
  it('keeps valid songs and reports skipped fields without rejecting the import', () => {
    const result = normalizePlaylist({
      name: '测试歌单',
      tracks: [
        { title: '能听的歌', artist: '歌手' },
        { title: '', artist: '缺歌名' },
        { title: '缺歌手' },
      ],
    })

    expect(result.payload.tracks).toHaveLength(1)
    expect(result.boundary?.code).toBe('import_invalid')
    expect(result.boundary?.details).toEqual({
      invalidFields: ['title', 'artist'],
      invalidItems: 2,
      totalItems: 3,
    })
  })

  it('rejects an empty tracks array with a controlled field summary', () => {
    expect(() => normalizePlaylist({ tracks: [] })).toThrowError(PlaylistValidationError)
    try {
      normalizePlaylist({ tracks: [] })
    } catch (error) {
      expect(error).toMatchObject({ invalidFields: ['tracks'], invalidItems: 0, totalItems: 0 })
    }
  })

  it('rejects a playlist whose songs all miss required fields', () => {
    try {
      normalizePlaylist({ tracks: [{ title: '没有歌手' }, { artist: '没有歌名' }] })
    } catch (error) {
      expect(error).toMatchObject({ invalidFields: ['artist', 'title'], invalidItems: 2, totalItems: 2 })
    }
  })
})
