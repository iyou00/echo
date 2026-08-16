import { describe, expect, it } from 'vitest'
import type { MusicEntityResolution } from '../music/entityResolver'
import { chatIntentTestHelpers } from './chat'

const { buildGroundingEvidence, explainRouteRejection } = chatIntentTestHelpers

function resolution(overrides: Partial<MusicEntityResolution>): MusicEntityResolution {
  return {
    explicitCount: false,
    entities: [],
    ambiguity: 'none',
    confidence: 0.9,
    source: 'rules',
    ...overrides,
  } as MusicEntityResolution
}

describe('router grounding evidence', () => {
  it('states verified artists as positive facts with adoption guidance', () => {
    const evidence = buildGroundingEvidence(resolution({
      artistQuery: '陈默之',
      verifiedArtistName: '陈默之',
      verificationStatus: 'verified',
    }))
    expect(evidence).toContain('陈默之')
    expect(evidence).toContain('已核实存在')
    expect(evidence).toContain('采信')
  })

  it('lists both artist and track when both verify', () => {
    const evidence = buildGroundingEvidence(resolution({
      artistQuery: '王菲',
      seedTitle: '主角',
      verifiedArtistName: '王菲',
      verifiedTrackTitle: '主角',
      verificationStatus: 'verified',
    }))
    expect(evidence).toContain('歌手「王菲」')
    expect(evidence).toContain('《主角》')
  })

  it('returns null for unverified / auth_required / not_needed / canceled results', () => {
    expect(buildGroundingEvidence(resolution({ artistQuery: '某人', verificationStatus: 'unverified' }))).toBeNull()
    expect(buildGroundingEvidence(resolution({ artistQuery: '某人', verificationStatus: 'auth_required' }))).toBeNull()
    expect(buildGroundingEvidence(resolution({ verificationStatus: 'not_needed' }))).toBeNull()
    expect(buildGroundingEvidence(resolution({ verificationStatus: 'canceled' }))).toBeNull()
  })

  it('returns null when verification passed but produced no names', () => {
    expect(buildGroundingEvidence(resolution({ verificationStatus: 'verified' }))).toBeNull()
  })
})

describe('route rejection reasons', () => {
  type RouteArg = Parameters<typeof explainRouteRejection>[0]
  const safeRoute = {
    kind: 'casual_chat',
    confidence: 0.9,
    wantsMusic: false,
    companionSignals: [],
  } as unknown as RouteArg

  it('flags low-confidence routes first', () => {
    expect(explainRouteRejection({ ...safeRoute, confidence: 0.5 }, '来首歌', {})).toBe('confidence-below-threshold')
  })

  it('explains when a music-execution kind lacks an execution cue', () => {
    const route = { ...safeRoute, kind: 'artist_request', wantsMusic: true } as RouteArg
    expect(explainRouteRejection(route, '陈默之怎么样', {})).toBe('music-kind-without-execution-cue')
  })

  it('passes genuinely safe routes', () => {
    expect(explainRouteRejection(safeRoute, '今天真累啊', {})).toBeNull()
  })
})
