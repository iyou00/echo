import { describe, expect, it } from 'vitest'
import { isMusicDescriptorPhrase, resolveMusicEntitiesFromText } from './entityResolver'

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
})
