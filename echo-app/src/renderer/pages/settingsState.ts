import { useMemo, useReducer, type Dispatch } from 'react'
import type { CareFrequency, NeteaseLoginState, NeteasePlaylistSummary, NeteaseQrLogin, ServiceHealth } from '../../types/ipc'

type AsyncState = 'idle' | 'working' | 'ok' | 'err'
type TestState = 'idle' | 'testing' | 'ok' | 'fail'
type TaskState = 'idle' | 'importing' | 'ok' | 'fail'

interface SettingsPageState {
  provider: string
  baseUrl: string
  apiKey: string
  model: string
  generateAt: string
  openWithRandom: boolean
  restoreOnStart: boolean
  city: string
  ttsBaseUrl: string
  ttsVoice: string
  ttsSpeed: number
  ttsTestStatus: string
  ttsTestState: TestState
  careEnabled: boolean
  careFrequency: CareFrequency
  careDetectFullscreen: boolean
  careQuietEnabled: boolean
  careQuietStart: string
  careQuietEnd: string
  careStatus: string
  modelStatus: string
  yinyiStatus: string
  chatStatus: string
  voiceSettingsStatus: string
  dataStatus: string
  dataState: AsyncState
  testState: TestState
  importStatus: string
  importState: TaskState
  profileStatus: string
  profileState: TaskState
  templateStatus: string
  templateState: Exclude<AsyncState, 'err'> | 'fail'
  neteaseState: NeteaseLoginState
  neteaseQr: NeteaseQrLogin | null
  neteaseQrStatus: string
  neteaseLoginStatus: string
  neteaseLoginStatusState: AsyncState
  neteasePlaylists: NeteasePlaylistSummary[]
  neteasePlaylistStatus: string
  importingNeteaseId: string
  neteaseBusy: boolean
  health: ServiceHealth[]
  healthChecking: boolean
  busy: boolean
  showResetConfirm: boolean
  resetConfirmChecked: boolean
}

type SettingsPageAction = Partial<SettingsPageState>
type Setter<T> = (value: T) => void

const initialSettingsPageState: SettingsPageState = {
  provider: 'deepseek',
  baseUrl: '',
  apiKey: '',
  model: '',
  generateAt: '22:00',
  openWithRandom: false,
  restoreOnStart: true,
  city: '',
  ttsBaseUrl: '',
  ttsVoice: 'zh-CN-XiaochenNeural',
  ttsSpeed: 1,
  ttsTestStatus: '',
  ttsTestState: 'idle',
  careEnabled: false,
  careFrequency: 'normal',
  careDetectFullscreen: true,
  careQuietEnabled: true,
  careQuietStart: '22:30',
  careQuietEnd: '08:30',
  careStatus: '',
  modelStatus: '',
  yinyiStatus: '',
  chatStatus: '',
  voiceSettingsStatus: '',
  dataStatus: '',
  dataState: 'idle',
  testState: 'idle',
  importStatus: '',
  importState: 'idle',
  profileStatus: '',
  profileState: 'idle',
  templateStatus: '',
  templateState: 'idle',
  neteaseState: { loggedIn: false, message: '正在检查网易云状态...' },
  neteaseQr: null,
  neteaseQrStatus: '',
  neteaseLoginStatus: '',
  neteaseLoginStatusState: 'idle',
  neteasePlaylists: [],
  neteasePlaylistStatus: '',
  importingNeteaseId: '',
  neteaseBusy: false,
  health: [],
  healthChecking: false,
  busy: false,
  showResetConfirm: false,
  resetConfirmChecked: false,
}

function reducer(state: SettingsPageState, action: SettingsPageAction): SettingsPageState {
  return { ...state, ...action }
}

function setter<K extends keyof SettingsPageState>(
  dispatch: Dispatch<SettingsPageAction>,
  key: K,
): Setter<SettingsPageState[K]> {
  return (value) => dispatch({ [key]: value } as Pick<SettingsPageState, K>)
}

export function useSettingsPageState() {
  const [state, dispatch] = useReducer(reducer, initialSettingsPageState)

  const actions = useMemo(() => ({
    patchSettingsPageState: (patch: SettingsPageAction) => dispatch(patch),
    setProvider: setter(dispatch, 'provider'),
    setBaseUrl: setter(dispatch, 'baseUrl'),
    setApiKey: setter(dispatch, 'apiKey'),
    setModel: setter(dispatch, 'model'),
    setGenerateAt: setter(dispatch, 'generateAt'),
    setOpenWithRandom: setter(dispatch, 'openWithRandom'),
    setRestoreOnStart: setter(dispatch, 'restoreOnStart'),
    setCity: setter(dispatch, 'city'),
    setTtsBaseUrl: setter(dispatch, 'ttsBaseUrl'),
    setTtsVoice: setter(dispatch, 'ttsVoice'),
    setTtsSpeed: setter(dispatch, 'ttsSpeed'),
    setTtsTestStatus: setter(dispatch, 'ttsTestStatus'),
    setTtsTestState: setter(dispatch, 'ttsTestState'),
    setCareEnabled: setter(dispatch, 'careEnabled'),
    setCareFrequency: setter(dispatch, 'careFrequency'),
    setCareDetectFullscreen: setter(dispatch, 'careDetectFullscreen'),
    setCareQuietEnabled: setter(dispatch, 'careQuietEnabled'),
    setCareQuietStart: setter(dispatch, 'careQuietStart'),
    setCareQuietEnd: setter(dispatch, 'careQuietEnd'),
    setCareStatus: setter(dispatch, 'careStatus'),
    setModelStatus: setter(dispatch, 'modelStatus'),
    setYinyiStatus: setter(dispatch, 'yinyiStatus'),
    setChatStatus: setter(dispatch, 'chatStatus'),
    setVoiceSettingsStatus: setter(dispatch, 'voiceSettingsStatus'),
    setDataStatus: setter(dispatch, 'dataStatus'),
    setDataState: setter(dispatch, 'dataState'),
    setTestState: setter(dispatch, 'testState'),
    setImportStatus: setter(dispatch, 'importStatus'),
    setImportState: setter(dispatch, 'importState'),
    setProfileStatus: setter(dispatch, 'profileStatus'),
    setProfileState: setter(dispatch, 'profileState'),
    setTemplateStatus: setter(dispatch, 'templateStatus'),
    setTemplateState: setter(dispatch, 'templateState'),
    setNeteaseState: setter(dispatch, 'neteaseState'),
    setNeteaseQr: setter(dispatch, 'neteaseQr'),
    setNeteaseQrStatus: setter(dispatch, 'neteaseQrStatus'),
    setNeteaseLoginStatus: setter(dispatch, 'neteaseLoginStatus'),
    setNeteaseLoginStatusState: setter(dispatch, 'neteaseLoginStatusState'),
    setNeteasePlaylists: setter(dispatch, 'neteasePlaylists'),
    setNeteasePlaylistStatus: setter(dispatch, 'neteasePlaylistStatus'),
    setImportingNeteaseId: setter(dispatch, 'importingNeteaseId'),
    setNeteaseBusy: setter(dispatch, 'neteaseBusy'),
    setHealth: setter(dispatch, 'health'),
    setHealthChecking: setter(dispatch, 'healthChecking'),
    setBusy: setter(dispatch, 'busy'),
    setShowResetConfirm: setter(dispatch, 'showResetConfirm'),
    setResetConfirmChecked: setter(dispatch, 'resetConfirmChecked'),
  }), [])

  return { ...state, ...actions }
}
