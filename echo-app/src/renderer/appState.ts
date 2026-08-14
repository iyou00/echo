import { useReducer, type Dispatch } from 'react'
import type { ActiveScene, AppPageKey, CloseReadiness, ImportTaskSnapshot, PlaybackState, SceneDefinition, Settings, TasteProfile, Track, UiBoundarySnapshot } from '../types/ipc'

export type PageKey = AppPageKey

export interface AppPageProps {
  navigate: (page: PageKey) => void
}

export interface AppState {
  page: PageKey
  settings: Settings | null
  bootReady: boolean
  profile: TasteProfile | null
  queue: Track[]
  sceneDefinitions: SceneDefinition[]
  currentScene: ActiveScene | null
  importTask: ImportTaskSnapshot | null
  playbackNotice: string
  careMuteToast: boolean
  careMuteCountdown: number
  carePingId: number | null
  voiceAutoStartToken: number
  voiceContinuous: boolean
  closeDialogOpen: boolean
  closeReadiness: CloseReadiness | null
  rememberCloseChoice: boolean
  latestYinyiDate: string
  onboardingOpen: boolean
  firstRunWelcomeOpen: boolean
  settingsImportFocusToken: number
  settingsApiFocusToken: number
  playbackState: PlaybackState
  boundaries: UiBoundarySnapshot[]
}

export type AppStateAction = Partial<AppState> | ((state: AppState) => Partial<AppState>)

export function isVoiceContinuousActive(_page: PageKey, voiceContinuous: boolean): boolean {
  return voiceContinuous
}

export function voiceContinuousStatePatch(value: boolean): Partial<AppState> {
  return value
    ? { voiceContinuous: true, currentScene: null }
    : { voiceContinuous: false }
}

export function scenePlaybackStatePatch(scene: ActiveScene): Partial<AppState> {
  return { currentScene: scene, voiceContinuous: false }
}

function appStateReducer(state: AppState, action: AppStateAction): AppState {
  return { ...state, ...(typeof action === 'function' ? action(state) : action) }
}

function initialAppState(): AppState {
  return {
    page: 'chat',
    settings: null,
    bootReady: false,
    profile: null,
    queue: [],
    sceneDefinitions: [],
    currentScene: null,
    importTask: null,
    playbackNotice: '',
    careMuteToast: false,
    careMuteCountdown: 5,
    carePingId: null,
    voiceAutoStartToken: 0,
    voiceContinuous: false,
    closeDialogOpen: false,
    closeReadiness: null,
    rememberCloseChoice: false,
    latestYinyiDate: '',
    onboardingOpen: false,
    firstRunWelcomeOpen: false,
    settingsImportFocusToken: 0,
    settingsApiFocusToken: 0,
    playbackState: {
      current: null,
      position: 0,
      duration: 0,
      status: 'idle',
      volume: 100,
      queue: [],
      history: [],
    },
    boundaries: [],
  }
}

export function useAppState(): [AppState, Dispatch<AppStateAction>] {
  return useReducer(appStateReducer, undefined, initialAppState)
}
