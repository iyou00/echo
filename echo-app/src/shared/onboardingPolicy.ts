import type { SettingUpdatePatch, Settings } from '../types/ipc'

export interface OnboardingDisplayState {
  firstRunWelcomeOpen: boolean
  onboardingOpen: boolean
}

export function hasConfiguredLlm(settings: Pick<Settings, 'llm'> | null): boolean {
  return Boolean(
    settings?.llm.baseUrl.trim()
    && settings.llm.apiKey.trim()
    && settings.llm.model.trim(),
  )
}

export function isOnboardingComplete(settings: Settings, profileReady: boolean): boolean {
  return Boolean(settings.meta.onboardingCompletedAt)
    || (profileReady && hasConfiguredLlm(settings))
}

export function onboardingCompletionPatchesIfReady(settings: Settings, profileReady: boolean): SettingUpdatePatch[] {
  if (settings.meta.onboardingCompletedAt) return []
  if (!isOnboardingComplete(settings, profileReady)) return []
  return [
    { path: 'meta.onboardingStep', value: 'done' },
    { path: 'meta.onboardingCompletedAt', value: new Date().toISOString() },
  ]
}

export function getOnboardingDisplayState(settings: Settings, profileReady: boolean): OnboardingDisplayState {
  const onboardingComplete = isOnboardingComplete(settings, profileReady)
  const firstRunDone = Boolean(settings.meta.firstRunWelcomeCompletedAt)
  return {
    firstRunWelcomeOpen: !onboardingComplete && !firstRunDone,
    onboardingOpen: !onboardingComplete && firstRunDone,
  }
}

export function onboardingPatchesAfterImport(settings: Settings): SettingUpdatePatch[] {
  if (settings.meta.onboardingCompletedAt) return []
  return hasConfiguredLlm(settings)
    ? [
        { path: 'meta.onboardingStep', value: 'done' },
        { path: 'meta.onboardingCompletedAt', value: new Date().toISOString() },
      ]
    : [{ path: 'meta.onboardingStep', value: 'api' }]
}

export function onboardingPatchesAfterLlmReady(profileReady: boolean): SettingUpdatePatch[] {
  return profileReady
    ? [
        { path: 'meta.onboardingStep', value: 'done' },
        { path: 'meta.onboardingCompletedAt', value: new Date().toISOString() },
      ]
    : [{ path: 'meta.onboardingStep', value: 'playlist' }]
}
