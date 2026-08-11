import { describe, expect, it } from 'vitest'
import type { Settings } from '../types/ipc'
import {
  getOnboardingDisplayState,
  hasConfiguredLlm,
  isOnboardingComplete,
  onboardingCompletionPatchesIfReady,
  onboardingPatchesAfterImport,
  onboardingPatchesAfterLlmReady,
} from './onboardingPolicy'

function settings(llmConfigured: boolean, completed = false): Settings {
  return {
    llm: {
      baseUrl: llmConfigured ? 'https://example.com/v1' : '',
      apiKey: llmConfigured ? 'key' : '',
      model: llmConfigured ? 'model' : '',
    },
    tts: {
      baseUrl: '',
      voice: '',
      speed: 1,
      pitch: '0%',
    },
    user: { city: '' },
    playback: { autoPlayNext: false },
    yinyi: { generateAt: '22:00', openWithRandom: false },
    carePings: { enabled: false, frequency: 'normal', detectFullscreen: true },
    chat: { restoreOnStart: true },
    ui: { closeBehavior: 'ask' },
    window: { closeHintShown: false },
    meta: {
      schemaVersion: 1,
      firstUsedAt: '2026-06-12T00:00:00.000Z',
      onboardingStep: completed ? 'done' : 'api',
      onboardingCompletedAt: completed ? '2026-06-12T00:00:00.000Z' : undefined,
    },
  }
}

function withFirstRunDone(value: Settings): Settings {
  return {
    ...value,
    meta: {
      ...value.meta,
      firstRunWelcomeCompletedAt: '2026-06-12T00:00:00.000Z',
    },
  }
}

describe('onboarding policy', () => {
  it('requires every LLM field', () => {
    expect(hasConfiguredLlm(settings(true))).toBe(true)
    expect(hasConfiguredLlm(settings(false))).toBe(false)
  })

  it('keeps import-first users on the API step', () => {
    expect(onboardingPatchesAfterImport(settings(false))).toEqual([
      { path: 'meta.onboardingStep', value: 'api' },
    ])
  })

  it('completes import when the model is ready', () => {
    expect(onboardingPatchesAfterImport(settings(true)).map((patch) => patch.path)).toEqual([
      'meta.onboardingStep',
      'meta.onboardingCompletedAt',
    ])
  })

  it('finishes after model setup when imported profile data already exists', () => {
    expect(onboardingPatchesAfterLlmReady(true).map((patch) => patch.path)).toEqual([
      'meta.onboardingStep',
      'meta.onboardingCompletedAt',
    ])
    expect(isOnboardingComplete(settings(true), true)).toBe(true)
  })

  it('backfills completion metadata for existing configured users', () => {
    expect(onboardingCompletionPatchesIfReady(settings(true), true).map((patch) => patch.path)).toEqual([
      'meta.onboardingStep',
      'meta.onboardingCompletedAt',
    ])
    expect(onboardingCompletionPatchesIfReady(settings(true, true), true)).toEqual([])
    expect(onboardingCompletionPatchesIfReady(settings(true), false)).toEqual([])
  })

  it('advances model-first users to playlist import', () => {
    expect(onboardingPatchesAfterLlmReady(false)).toEqual([
      { path: 'meta.onboardingStep', value: 'playlist' },
    ])
  })

  it('shows the first-run welcome for a fresh local state', () => {
    expect(getOnboardingDisplayState(settings(false), false)).toEqual({
      firstRunWelcomeOpen: true,
      onboardingOpen: false,
    })
  })

  it('shows setup onboarding after the first-run welcome is completed', () => {
    expect(getOnboardingDisplayState(withFirstRunDone(settings(false)), false)).toEqual({
      firstRunWelcomeOpen: false,
      onboardingOpen: true,
    })
  })

  it('keeps existing configured users out of first-run screens', () => {
    expect(getOnboardingDisplayState(settings(true), true)).toEqual({
      firstRunWelcomeOpen: false,
      onboardingOpen: false,
    })
  })
})
