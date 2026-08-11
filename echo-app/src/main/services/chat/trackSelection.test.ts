import { describe, expect, it } from 'vitest'
import type { Track } from '../../../types/ipc'
import { selectTracksForChatResponse } from './trackSelection'

const candidate: Track = {
  id: 'candidate-1',
  title: '真正候选',
  artist: '候选歌手',
  source: 'netease',
}

const otherCandidate: Track = {
  id: 'candidate-2',
  title: '另一首',
  artist: '另一位',
  source: 'netease',
}

describe('chat track selection', () => {
  it('does not resolve hallucinated LLM song names outside the candidate pool', async () => {
    const selected = await selectTracksForChatResponse({
      content: '这首《沉溺》，前奏轻，先听。',
      candidates: [candidate, otherCandidate],
      targetCount: 1,
      explicit: false,
      authRequired: false,
    })

    expect(selected).toEqual([])
  })

  it('selects tracks only when the reply names an actual candidate', async () => {
    const selected = await selectTracksForChatResponse({
      content: '先听候选歌手的《真正候选》。',
      candidates: [candidate],
      targetCount: 1,
      explicit: false,
      authRequired: false,
    })

    expect(selected).toEqual([candidate])
  })

  it('prefers the mentioned artist when duplicate song titles exist', async () => {
    const wrongArtist: Track = {
      id: 'wrong',
      title: 'Part-Time Lover',
      artist: 'Dabin / Claire Ridgely',
      source: 'netease',
    }
    const rightArtist: Track = {
      id: 'right',
      title: 'Part-Time Lover',
      artist: 'Nicky Youre',
      source: 'netease',
    }

    const selected = await selectTracksForChatResponse({
      content: '这次放 Nicky Youre 的《Part-Time Lover》。',
      candidates: [wrongArtist, rightArtist],
      targetCount: 1,
      explicit: false,
      authRequired: false,
    })

    expect(selected).toEqual([rightArtist])
  })
})
