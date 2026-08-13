import { describe, expect, it } from 'vitest'
import { artistMatchesConstraint, filterTracksByMusicEntity } from './verifier'

describe('strict artist attribution', () => {
  it('accepts the requested artist alone or in a collaboration', () => {
    expect(artistMatchesConstraint('陈默之', '陈默之', true)).toBe(true)
    expect(artistMatchesConstraint('陈默之 / 另一位歌手', '陈默之', true)).toBe(true)
  })

  it('rejects partial and similarly named artists in strict mode', () => {
    expect(artistMatchesConstraint('陈默', '陈默之', true)).toBe(false)
    expect(artistMatchesConstraint('陈默之乐队', '陈默之', true)).toBe(false)

    const filtered = filterTracksByMusicEntity([
      { title: '正确', artist: '陈默之' },
      { title: '错误', artist: '陈默' },
    ], { artistQuery: '陈默之' }, { strictArtist: true })
    expect(filtered.map((track) => track.title)).toEqual(['正确'])
  })
})
