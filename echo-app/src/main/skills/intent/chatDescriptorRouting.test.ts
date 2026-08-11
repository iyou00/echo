import { describe, expect, it } from 'vitest'
import { chatIntentTestHelpers } from './chat'
import { createDefaultCompanionProfile } from '../../services/chat/companionTypes'

describe('LLM chat route descriptor validation', () => {
  it('downgrades a hallucinated descriptor artist to a mood request', () => {
    const text = '找欢快类型的歌曲'
    const route = chatIntentTestHelpers.parseChatRouteContent(JSON.stringify({
      kind: 'artist_request',
      wantsMusic: true,
      confidence: 0.98,
      artistQuery: '欢快类型',
      seedTitle: null,
      targetCount: 1,
      moods: ['轻快'],
    }), text, {})

    expect(route?.kind).toBe('mood_request')
    expect(route?.override?.artistQuery).toBeUndefined()
    expect(route?.override?.clearArtistQuery).toBe(true)
    expect(route?.override?.moods).toContain('轻快')
  })

  it('downgrades a hallucinated descriptor title to a mood request', () => {
    const text = '工作被骂了，来一首欢快歌给我听听吧'
    const route = chatIntentTestHelpers.parseChatRouteContent(JSON.stringify({
      kind: 'direct_song',
      wantsMusic: true,
      confidence: 0.98,
      artistQuery: null,
      seedTitle: '欢快儿歌',
      targetCount: 1,
      moods: ['轻快'],
    }), text, {})

    expect(route?.kind).toBe('mood_request')
    expect(route?.override?.seedTitle).toBeUndefined()
    expect(route?.override?.clearSeedTitle).toBe(true)
  })

  it('keeps an explicitly marked descriptor-looking song title', () => {
    const text = '我要听《欢快》'
    const route = chatIntentTestHelpers.parseChatRouteContent(JSON.stringify({
      kind: 'direct_song',
      wantsMusic: true,
      confidence: 0.98,
      artistQuery: null,
      seedTitle: '欢快',
      targetCount: 1,
    }), text, {})

    expect(route?.kind).toBe('direct_song')
    expect(route?.override?.seedTitle).toBe('欢快')
  })

  it('calibrates an unsafe playful LLM strategy against the relationship profile', () => {
    const profile = createDefaultCompanionProfile()
    profile.playfulness = { value: 0.08, confidence: 0.92, evidenceCount: 4, updatedAt: profile.updatedAt }
    const route = chatIntentTestHelpers.parseChatRouteContent(JSON.stringify({
      kind: 'casual_chat',
      wantsMusic: false,
      confidence: 0.96,
      responseStrategy: {
        mode: 'playful_tease',
        warmth: 0.5,
        playfulness: 0.9,
        directness: 0.6,
        initiative: 'reply_only',
        verbosity: 'short',
        vulnerability: 'low',
        reasonCodes: ['repeated_fatigue'],
      },
    }), '我今天又累了', { companionProfile: profile })

    expect(route?.responseStrategy.mode).toBe('warm_care')
    expect(route?.responseStrategy.playfulness).toBeLessThanOrEqual(0.05)
  })

  it('returns grounded relationship signals from the first LLM stage', () => {
    const route = chatIntentTestHelpers.parseChatRouteContent(JSON.stringify({
      kind: 'casual_chat',
      wantsMusic: false,
      confidence: 0.96,
      companionSignals: [
        { dimension: 'directness', direction: 'more', confidence: 0.96, explicit: true, evidence: '直接点' },
        { dimension: 'playfulness', direction: 'more', confidence: 0.9, explicit: true, evidence: '并不存在的证据' },
      ],
    }), '以后跟我说话直接点', {})

    expect(route?.companionSignals).toEqual([
      expect.objectContaining({ dimension: 'directness', direction: 'more', explicit: true }),
    ])
  })
})
