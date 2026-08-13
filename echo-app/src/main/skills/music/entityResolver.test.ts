import { describe, expect, it } from 'vitest'
import { isMusicDescriptorPhrase, parseMusicRequestCount, resolveMusicEntitiesFromText } from './entityResolver'

describe('music entity descriptor validation', () => {
  it.each([
    '工作被骂了，来一首欢快歌给我听听吧',
    '找欢快类型的歌曲',
    '来5首欢快的歌曲给我听听',
    '找一首适合今天天气的韩国歌曲',
    '推荐几首法语歌曲',
  ])('keeps recommendation descriptors out of artist and title fields: %s', (text) => {
    const resolved = resolveMusicEntitiesFromText(text)

    expect(resolved.artistQuery).toBeUndefined()
    expect(resolved.seedTitle).toBeUndefined()
  })

  it('still extracts an explicitly named artist and title', () => {
    const resolved = resolveMusicEntitiesFromText('我要听王菲的主角')

    expect(resolved.artistQuery).toBe('王菲')
    expect(resolved.seedTitle).toBe('主角')
  })

  it('keeps a descriptor-looking title when the user marks it with book-title brackets', () => {
    const resolved = resolveMusicEntitiesFromText('我要听《欢快》')

    expect(resolved.seedTitle).toBe('欢快')
  })

  it('recognizes combined recommendation descriptors', () => {
    expect(isMusicDescriptorPhrase('找欢快类型的歌曲')).toBe(true)
    expect(isMusicDescriptorPhrase('王菲')).toBe(false)
  })

  it('keeps an explicit request for ten tracks instead of silently truncating to five', () => {
    expect(parseMusicRequestCount('再来10首陈默之的歌曲吧')).toEqual({
      requestedCount: 10,
      targetCount: 10,
      overLimit: false,
      explicit: true,
    })
    expect(resolveMusicEntitiesFromText('再来10首陈默之的歌曲吧')).toMatchObject({
      artistQuery: '陈默之',
      targetCount: 10,
    })
  })

  it('extracts the artist from a latest-tracks request', () => {
    const resolved = resolveMusicEntitiesFromText('听听陈默之的最新几首歌')

    expect(resolved.artistQuery).toBe('陈默之')
    expect(resolved.targetCount).toBe(3)
  })
})
