import { describe, expect, it } from 'vitest'
import { createDefaultCompanionProfile } from './chat/companionTypes'
import { buildListeningPlan, formatListeningPlan } from './listeningPlan'
import type { ListeningSegmentRecord, ListeningSessionRecord } from './listeningTypes'

function session(segmentCount: number, startedAt = '2026-08-10T12:00:00.000Z'): ListeningSessionRecord {
  return {
    id: 3,
    status: 'active',
    startedAt,
    lastActiveAt: startedAt,
    segmentCount,
    companionMode: null,
    consumedEventKeys: [],
  }
}

function segment(id: number, move: ListeningSegmentRecord['move']): ListeningSegmentRecord {
  return {
    id,
    sessionId: 3,
    trackKey: '',
    track: null,
    text: '测试段落',
    delivery: 'spoken',
    density: 'micro',
    move,
    sentenceForm: 'observation',
    topicSource: 'session',
    signature: '',
    generatedAt: '2026-08-10T12:00:00.000Z',
  }
}

describe('continuous listening plan', () => {
  it('always gives a manual request a spoken response', () => {
    const plan = buildListeningPlan({
      session: session(9),
      recentSegments: [],
      automatic: false,
      hasFreshConversation: false,
      hasActiveContext: false,
      emotionContext: false,
      hasWeather: true,
      companionProfile: createDefaultCompanionProfile(),
      now: new Date('2026-08-10T12:35:00.000Z'),
    })

    expect(plan.delivery).toBe('spoken')
    expect(plan.density).toBe('brief')
    expect(plan.reason).toBe('manual_request')
  })

  it('uses micro copy for ordinary automatic continuation', () => {
    const plan = buildListeningPlan({
      session: session(5),
      recentSegments: [],
      automatic: true,
      hasFreshConversation: false,
      hasActiveContext: false,
      emotionContext: false,
      hasWeather: true,
      companionProfile: createDefaultCompanionProfile(),
      now: new Date('2026-08-10T12:10:00.000Z'),
    })

    expect(plan.density).toBe('micro')
    expect(plan.maxChars).toBeLessThanOrEqual(68)
  })

  it('creates breathing room during long automatic sessions', () => {
    const plan = buildListeningPlan({
      session: session(10),
      recentSegments: [],
      automatic: true,
      hasFreshConversation: false,
      hasActiveContext: false,
      emotionContext: false,
      hasWeather: true,
      companionProfile: createDefaultCompanionProfile(),
      now: new Date('2026-08-10T12:30:00.000Z'),
    })

    expect(plan.delivery).toBe('silent')
    expect(plan.move).toBe('quiet_company')
  })

  it('keeps fresh emotional context in a full spoken segment', () => {
    const plan = buildListeningPlan({
      session: session(7),
      recentSegments: [],
      automatic: true,
      hasFreshConversation: true,
      hasActiveContext: false,
      emotionContext: true,
      hasWeather: true,
      companionProfile: createDefaultCompanionProfile(),
      companionMode: 'warm_care',
      now: new Date('2026-08-10T12:30:00.000Z'),
    })

    expect(plan.density).toBe('full')
    expect(plan.topicSource).toBe('conversation')
  })

  it('keeps serious spoken segments on a spoken sentence form', () => {
    const plan = buildListeningPlan({
      session: session(3),
      recentSegments: [],
      automatic: true,
      hasFreshConversation: true,
      hasActiveContext: false,
      emotionContext: true,
      hasWeather: false,
      companionProfile: createDefaultCompanionProfile(),
      companionMode: 'serious_care',
      now: new Date('2026-08-10T12:10:00.000Z'),
    })

    expect(plan.delivery).toBe('spoken')
    expect(plan.move).not.toBe('quiet_company')
    expect(plan.sentenceForm).not.toBe('silence')
  })

  it('serializes plan fields without patch markers', () => {
    const plan = buildListeningPlan({
      session: session(1),
      recentSegments: [],
      automatic: true,
      hasFreshConversation: false,
      hasActiveContext: false,
      emotionContext: false,
      hasWeather: false,
      companionProfile: createDefaultCompanionProfile(),
      now: new Date('2026-08-10T12:05:00.000Z'),
    })

    const formatted = formatListeningPlan(plan)
    expect(formatted).toContain('\ndensity: micro')
    expect(formatted).not.toContain('\n+density:')
  })

  it('cools down recently used moves', () => {
    const recentSegments = [segment(3, 'self_talk'), segment(2, 'reversal'), segment(1, 'shared_moment')]
    const plan = buildListeningPlan({
      session: session(5),
      recentSegments,
      automatic: true,
      hasFreshConversation: false,
      hasActiveContext: false,
      emotionContext: false,
      hasWeather: false,
      companionProfile: createDefaultCompanionProfile(),
      now: new Date('2026-08-10T12:10:00.000Z'),
    })

    expect(recentSegments.map((item) => item.move)).not.toContain(plan.move)
  })
})
