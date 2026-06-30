import { describe, expect, it } from 'vitest'
import { isMeaningfulProfileTrackEvent, isMeaningfulTrackEvent, tracksTestHelpers } from '../../db/tracks'
import {
  evaluateCarePingReadiness,
  evaluateTasteStructuredReadiness,
  evaluateTastePortraitReadiness,
  evaluateYinyiReadiness,
  type ProductReadiness,
} from './readiness'

function readiness(patch: Partial<ProductReadiness> = {}): ProductReadiness {
  return {
    firstUseDate: '2026-06-12',
    onboardingCompleted: false,
    llmConfigured: true,
    musicLibraryReady: false,
    profileReady: false,
    memoryReady: false,
    ...patch,
  }
}

describe('scheduler product readiness boundaries', () => {
  it('does not generate yinyi before the first use date', () => {
    expect(evaluateYinyiReadiness(
      readiness({ onboardingCompleted: true }),
      '2026-06-11',
      { userConversation: true, listening: true },
    ).ready).toBe(false)
  })

  it('keeps scheduled jobs quiet until onboarding is completed', () => {
    expect(evaluateYinyiReadiness(
      readiness({ onboardingCompleted: false, llmConfigured: true, profileReady: true, memoryReady: true }),
      '2026-06-12',
      { userConversation: true, listening: true },
    )).toMatchObject({ ready: false })
    expect(evaluateTasteStructuredReadiness(readiness({ onboardingCompleted: false, profileReady: true })).ready).toBe(false)
    expect(evaluateTastePortraitReadiness(readiness({ onboardingCompleted: false, profileReady: true, llmConfigured: true })).ready).toBe(false)
    expect(evaluateCarePingReadiness(readiness({ onboardingCompleted: false, llmConfigured: true, memoryReady: true })).ready).toBe(false)
  })

  it('requires user-authored conversation or meaningful listening evidence', () => {
    expect(evaluateYinyiReadiness(
      readiness({ onboardingCompleted: true }),
      '2026-06-12',
      { userConversation: false, listening: false },
    ).ready).toBe(false)
    expect(evaluateYinyiReadiness(
      readiness({ onboardingCompleted: true }),
      '2026-06-12',
      { userConversation: true, listening: false },
    ).ready).toBe(true)
  })

  it('accepts derived onboarded readiness for existing configured users', () => {
    expect(evaluateYinyiReadiness(
      readiness({ onboardingCompleted: true, llmConfigured: true, profileReady: true, memoryReady: true }),
      '2026-06-12',
      { userConversation: true, listening: false },
    ).ready).toBe(true)
  })

  it('keeps yinyi pending while the model configuration is unavailable', () => {
    const result = evaluateYinyiReadiness(
      readiness({ onboardingCompleted: true, llmConfigured: false }),
      '2026-06-12',
      { userConversation: true, listening: false },
    )
    expect(result.ready).toBe(false)
    expect(result.reason).toContain('模型')
  })

  it('requires both profile and model for scheduled portrait writing', () => {
    expect(evaluateTastePortraitReadiness(readiness({ onboardingCompleted: true, profileReady: true, llmConfigured: false })).ready).toBe(false)
    expect(evaluateTastePortraitReadiness(readiness({ onboardingCompleted: true, profileReady: true, llmConfigured: true })).ready).toBe(true)
  })

  it('requires model and real memory evidence for proactive care', () => {
    expect(evaluateCarePingReadiness(readiness({ onboardingCompleted: true, llmConfigured: true, memoryReady: false })).ready).toBe(false)
    expect(evaluateCarePingReadiness(readiness({ onboardingCompleted: true, llmConfigured: true, memoryReady: true })).ready).toBe(true)
  })
})

describe('meaningful listening evidence', () => {
  it('excludes recommendations that only entered the queue', () => {
    expect(isMeaningfulTrackEvent({ source: 'recommended_by_echo', queueStatus: 'pending' })).toBe(false)
    expect(isMeaningfulTrackEvent({ source: 'recommended_by_echo', queueStatus: undefined })).toBe(false)
  })

  it('includes played recommendations and externally recorded listening', () => {
    expect(isMeaningfulTrackEvent({ source: undefined, queueStatus: undefined })).toBe(false)
    expect(isMeaningfulTrackEvent({ source: 'recommended_by_echo', queueStatus: 'playing' })).toBe(true)
    expect(isMeaningfulTrackEvent({ source: 'recommended_by_echo', queueStatus: 'completed' })).toBe(true)
    expect(isMeaningfulTrackEvent({ source: 'recommended_by_echo', queueStatus: 'skipped' })).toBe(true)
    expect(isMeaningfulTrackEvent({ source: 'recommended_by_echo', queueStatus: 'skipped', queueStatusReason: 'playback_skipped' })).toBe(true)
    expect(isMeaningfulTrackEvent({ source: 'recommended_by_echo', queueStatus: 'skipped', queueStatusReason: 'explicit_feedback' })).toBe(true)
    expect(isMeaningfulTrackEvent({ source: 'history', queueStatus: undefined })).toBe(true)
    expect(isMeaningfulTrackEvent({ source: 'manual_import', queueStatus: undefined })).toBe(false)
    expect(isMeaningfulTrackEvent({ source: 'Manual_Import', queueStatus: undefined })).toBe(false)
  })

  it('excludes skipped queue maintenance from listening evidence', () => {
    expect(isMeaningfulTrackEvent({ source: 'recommended_by_echo', queueStatus: 'skipped', queueStatusReason: 'queue_removed' })).toBe(false)
    expect(isMeaningfulTrackEvent({ source: 'recommended_by_echo', queueStatus: 'skipped', queueStatusReason: 'scene_replaced' })).toBe(false)
    expect(isMeaningfulTrackEvent({ source: 'recommended_by_echo', queueStatus: 'skipped', queueStatusReason: 'playback_failed' })).toBe(false)
  })

  it('keeps long-term recommendation cooldown tied to real listening evidence', () => {
    expect(tracksTestHelpers.isLongTermRecommendationCooldownTrack({ source: undefined, queueStatus: undefined })).toBe(false)
    expect(tracksTestHelpers.isLongTermRecommendationCooldownTrack({ source: 'recommended_by_echo', queueStatus: 'pending' })).toBe(false)
    expect(tracksTestHelpers.isLongTermRecommendationCooldownTrack({ source: 'recommended_by_echo', queueStatus: 'skipped', queueStatusReason: 'queue_removed' })).toBe(false)
    expect(tracksTestHelpers.isLongTermRecommendationCooldownTrack({ source: 'recommended_by_echo', queueStatus: 'skipped', queueStatusReason: 'scene_replaced' })).toBe(false)
    expect(tracksTestHelpers.isLongTermRecommendationCooldownTrack({ source: 'recommended_by_echo', queueStatus: 'skipped', queueStatusReason: 'playback_failed' })).toBe(false)
    expect(tracksTestHelpers.isLongTermRecommendationCooldownTrack({ source: 'recommended_by_echo', queueStatus: 'playing' })).toBe(true)
    expect(tracksTestHelpers.isLongTermRecommendationCooldownTrack({ source: 'recommended_by_echo', queueStatus: 'completed' })).toBe(true)
    expect(tracksTestHelpers.isLongTermRecommendationCooldownTrack({ source: 'recommended_by_echo', queueStatus: 'skipped', queueStatusReason: 'explicit_feedback' })).toBe(true)
    expect(tracksTestHelpers.isLongTermRecommendationCooldownTrack({ source: 'manual', queueStatus: undefined })).toBe(true)
    expect(tracksTestHelpers.isLongTermRecommendationCooldownTrack({ source: 'manual_import', queueStatus: undefined })).toBe(false)
  })

  it('keeps profile statistics stricter than same-day context', () => {
    expect(isMeaningfulProfileTrackEvent({ source: undefined, queueStatus: undefined })).toBe(false)
    expect(isMeaningfulProfileTrackEvent({ source: 'recommended_by_echo', queueStatus: 'pending' })).toBe(false)
    expect(isMeaningfulProfileTrackEvent({ source: 'recommended_by_echo', queueStatus: undefined })).toBe(false)
    expect(isMeaningfulProfileTrackEvent({ source: 'recommended_by_echo', queueStatus: 'playing' })).toBe(false)
    expect(isMeaningfulProfileTrackEvent({ source: 'recommended_by_echo', queueStatus: 'skipped' })).toBe(true)
    expect(isMeaningfulProfileTrackEvent({ source: 'recommended_by_echo', queueStatus: 'skipped', queueStatusReason: 'queue_removed' })).toBe(false)
    expect(isMeaningfulProfileTrackEvent({ source: 'recommended_by_echo', queueStatus: 'completed' })).toBe(true)
    expect(isMeaningfulProfileTrackEvent({ source: 'manual', queueStatus: undefined })).toBe(true)
    expect(isMeaningfulProfileTrackEvent({ source: 'manual_import', queueStatus: undefined })).toBe(false)
  })

  it('keeps real playback evidence when the same track is recommended again', () => {
    expect(tracksTestHelpers.mergeRecommendedQueueStatus(
      { queueStatus: 'completed', queueStatusReason: 'playback_completed' },
      { queueStatus: 'pending' },
    )).toEqual({ queueStatus: 'completed', queueStatusReason: 'playback_completed' })
    expect(tracksTestHelpers.mergeRecommendedQueueStatus(
      { queueStatus: 'skipped', queueStatusReason: 'playback_skipped' },
      undefined,
    )).toEqual({ queueStatus: 'skipped', queueStatusReason: 'playback_skipped' })
    expect(tracksTestHelpers.mergeRecommendedQueueStatus(
      { queueStatus: 'playing', queueStatusReason: 'playback_started' },
      { queueStatus: 'pending' },
    )).toEqual({ queueStatus: 'playing', queueStatusReason: 'playback_started' })
    expect(tracksTestHelpers.mergeRecommendedQueueStatus(
      { queueStatus: 'pending' },
      undefined,
    )).toEqual({ queueStatus: 'pending', queueStatusReason: undefined })
    expect(tracksTestHelpers.mergeRecommendedQueueStatus(
      { queueStatus: 'completed', queueStatusReason: 'playback_completed' },
      { queueStatus: 'playing', queueStatusReason: 'playback_started' },
    )).toEqual({ queueStatus: 'playing', queueStatusReason: 'playback_started' })
  })

  it('keeps completed and real skipped evidence during scene queue replacement', () => {
    expect(tracksTestHelpers.shouldMarkRecommendedTrackSkippedOnReplace(null)).toBe(false)
    expect(tracksTestHelpers.shouldMarkRecommendedTrackSkippedOnReplace({ queueStatus: 'completed' })).toBe(false)
    expect(tracksTestHelpers.shouldMarkRecommendedTrackSkippedOnReplace({ queueStatus: 'skipped' })).toBe(false)
    expect(tracksTestHelpers.shouldMarkRecommendedTrackSkippedOnReplace({ queueStatus: 'playing' })).toBe(true)
    expect(tracksTestHelpers.shouldMarkRecommendedTrackSkippedOnReplace({ queueStatus: 'pending' })).toBe(true)
    expect(tracksTestHelpers.shouldMarkRecommendedTrackSkippedOnReplace({ queueStatus: undefined })).toBe(true)
  })
})
