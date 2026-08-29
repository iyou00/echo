import { describe, expect, it } from 'vitest'
import { isMusicDescriptorPhrase, parseMusicRequestCount, resolveMusicEntitiesFromText } from './entityResolver'
import { isConversationalFragment } from './identity'

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

describe('conversational fragment guard', () => {
  // 2026-08-29 真机失败：「腰疼，心里不舒服，你看有没有什么歌适合我」被名词前置
  // 模式捕获 + normalize 剥尾，剩「你看有没」当歌手送去网易云校准，触发「确认拼写」追问。
  // 守卫：剥离口语功能字后不剩实质字的候选是句子碎片，不是名字。
  it('rejects interrogative fragments as entities', () => {
    const resolved = resolveMusicEntitiesFromText('腰疼，心里不舒服，你看有没有什么歌适合我')
    expect(resolved.artistQuery).toBeUndefined()
    expect(resolved.seedTitle).toBeUndefined()
  })

  it.each([
    '你看有没',
    '有没有什么',
    '你看有没有',
  ])('isConversationalFragment rejects: %s', (value) => {
    expect(isConversationalFragment(value)).toBe(true)
  })

  it.each([
    '晴天',
    '好想你',
    '你的样子',
    '说好的幸福呢',
    '说散就散',
    '陈默之',
    '苏星婕',
    'Taylor Swift',
    '我们没有在一起',
    '后来',
  ])('isConversationalFragment keeps real names: %s', (value) => {
    expect(isConversationalFragment(value)).toBe(false)
  })

  it('still extracts real songs whose titles contain function characters', () => {
    const resolved = resolveMusicEntitiesFromText('放一首好想你')
    expect(resolved.seedTitle).toBe('好想你')
  })
})
