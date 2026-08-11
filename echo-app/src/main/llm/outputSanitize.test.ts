import { describe, expect, it } from 'vitest'
import { stripKnownSystemBlocks } from './outputSanitize'

describe('output system block sanitization', () => {
  it('removes profile memory blocks when a model echoes internal context', () => {
    const clean = stripKnownSystemBlocks('可以。\n<profile_memory>{"top_artists":["陈奕迅"]}</profile_memory>\n这首先放着。')

    expect(clean).toContain('可以。')
    expect(clean).toContain('这首先放着。')
    expect(clean).not.toContain('profile_memory')
    expect(clean).not.toContain('陈奕迅')
  })

  it('removes yinyi and voice evidence blocks when they leak into output', () => {
    const clean = stripKnownSystemBlocks([
      '先听这首。',
      '<dismissed_tracks>- 09:00 A / B · explicit_feedback</dismissed_tracks>',
      '<voice_moment>state: continuation</voice_moment>',
      '声音开小一点。',
    ].join('\n'))

    expect(clean).toContain('先听这首。')
    expect(clean).toContain('声音开小一点。')
    expect(clean).not.toContain('dismissed_tracks')
    expect(clean).not.toContain('voice_moment')
    expect(clean).not.toContain('explicit_feedback')
    expect(clean).not.toContain('continuation')
  })
})
