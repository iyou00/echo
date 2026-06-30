import { describe, expect, it } from 'vitest'
import { enforceAssistantTrackBinding } from './pipelineContract'
import type { Track } from '../../../types/ipc'

const candidate: Track = {
  id: 'real',
  title: '真正候选',
  artist: '候选歌手',
  source: 'netease',
}

const otherCandidate: Track = {
  id: 'other',
  title: '另一首',
  artist: '另一位',
  source: 'netease',
}

describe('chat pipeline track binding contract', () => {
  it('guards every assistant reply path from promising playback without a track card', () => {
    const content = '这首《沉溺》，前奏轻，旋律顺，先听，不合适再换。'

    expect(enforceAssistantTrackBinding(content, [], true)).toBe('我刚才没拿到能播放的版本，这次先不乱报歌名。你再让我挑一次，我直接把歌放出来。')
  })

  it('guards descriptive playback promises without a concrete title', () => {
    const content = '行，这首前奏一出来就挺有冲击力的，先听听看合不合你现在的感觉。'

    expect(enforceAssistantTrackBinding(content, [], true)).toBe('我刚才没拿到能播放的版本，这次先不乱报歌名。你再让我挑一次，我直接把歌放出来。')
  })

  it('keeps companion talk that mentions songs without playback commitment', () => {
    const content = '你刚才提到《主角》，我记住这个偏好。'

    expect(enforceAssistantTrackBinding(content, [], false)).toBe(content)
  })

  it('keeps non-action companion text that uses recommendation as a topic', () => {
    const content = '推荐这件事可以慢慢来，你先说说现在的心情。'

    expect(enforceAssistantTrackBinding(content, [], false)).toBe(content)
  })

  it('guards unquoted latin track playback claims', () => {
    const content = 'Part Time Lover 可以先听，前奏很快就进来。'

    expect(enforceAssistantTrackBinding(content, [], true)).toBe('我刚才没拿到能播放的版本，这次先不乱报歌名。你再让我挑一次，我直接把歌放出来。')
  })

  it('keeps ordinary companion listening language', () => {
    const content = '你可以先听听自己的感觉，急着换也没关系。'

    expect(enforceAssistantTrackBinding(content, [], false)).toBe(content)
  })

  it('rewrites playback text that mentions a quoted title outside the bound card', () => {
    const content = '这首《沉溺》，前奏轻，先听一下。'

    expect(enforceAssistantTrackBinding(content, [candidate], true)).toBe('行，先放候选歌手的《真正候选》。先听开头。')
  })

  it('keeps quoted rejected tracks when the playback card is bound to the replacement', () => {
    const content = '懂了，旧歌手的《旧歌》这个方向我先收一收。换成候选歌手的《真正候选》。'

    expect(enforceAssistantTrackBinding(content, [candidate], true)).toBe(content)
  })

  it('keeps playback text when every quoted title belongs to the bound cards', () => {
    const content = '先听候选歌手的《真正候选》，不合适再换。'

    expect(enforceAssistantTrackBinding(content, [candidate], true)).toBe(content)
  })

  it('rewrites multi-card playback text when it includes an extra hallucinated title', () => {
    const content = '先从《真正候选》开始，后面可以接《不存在的歌》。'

    expect(enforceAssistantTrackBinding(content, [candidate, otherCandidate], true)).toBe('行，我先挑这几首：候选歌手的《真正候选》、另一位的《另一首》。先从第一首开始。')
  })
})
