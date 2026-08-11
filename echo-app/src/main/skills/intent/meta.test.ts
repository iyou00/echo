import { describe, expect, it } from 'vitest'
import { isEchoIdentityQuestion, looksLikeFreshNonAnswerTopic } from './meta'

describe('meta intent boundaries', () => {
  it('recognizes flexible Echo identity and setup questions', () => {
    expect(isEchoIdentityQuestion('你的设定是什么呀')).toBe(true)
    expect(isEchoIdentityQuestion('Echo 你到底是什么设定？')).toBe(true)
    expect(isEchoIdentityQuestion('你作为音乐伴侣能做什么')).toBe(true)
  })

  it('keeps meta questions out of pending taste answers', () => {
    expect(looksLikeFreshNonAnswerTopic('你的设定是什么？')).toBe(true)
    expect(looksLikeFreshNonAnswerTopic('今天几度？')).toBe(true)
  })
})
