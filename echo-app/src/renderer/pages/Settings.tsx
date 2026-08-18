import { FormEvent, useCallback, useEffect, useRef, useState } from 'react'
import { Download, Upload } from 'lucide-react'
import type { AgentActionSummary, CareFrequency, EchoApi, ImportProgressPayload, ImportTaskSnapshot, LearnedCaseView, SemanticSummary, Settings, StageContext, Track, UiBoundarySnapshot, WindowSizePreset } from '../../types/ipc'
import type { AppPageProps } from '../appState'
import { EmptyState, Section } from '../components'
import { RuntimeTaskList } from '../components/RuntimeTaskNotice'
import { BoundaryState } from '../components/BoundaryState'
import { latestRunningRuntimeTask, runtimeTaskNeedsAttention, useRuntimeTasks } from '../hooks/useRuntimeTasks'
import { pageLabels } from '../labels'
import { friendlyOperationError, serviceHealthLabel, serviceRecoveryHint } from '../../shared/runtimeRecovery'
import { useSettingsPageState } from './settingsState'
import { formatImportResultStatus, shouldAutoClearNeteaseImportStatus } from './settingsImportStatus'
import {
  refreshProfileAfterSemanticUpdateAction,
  semanticBackfillResultStatus,
  shouldRefreshProfileAfterSemanticBackfill,
  shouldRefreshProfileForSemanticTask,
} from './settingsSemanticRefresh'

type SettingsSectionKey = 'music' | 'yinyi' | 'chat' | 'stage' | 'learned' | 'voice' | 'care' | 'window' | 'llm' | 'data' | 'tasks'

const SECTION_META: Record<SettingsSectionKey, { group: string; title: string; desc: string }> = {
  music: { group: '连 接 与 来 源', title: '音乐来源', desc: '登录信息只保存在本机。登录网易云后 Echo 才能替你找歌、放歌，歌单也可以从文件导入。' },
  llm: { group: '连 接 与 来 源', title: 'AI 模型', desc: '密钥只保存在本机，保存后可测试连接。' },
  voice: { group: '连 接 与 来 源', title: '天气与语音', desc: '更改会自动保存。' },
  yinyi: { group: '相 处 方 式', title: '风信生成', desc: '更改会自动保存。' },
  chat: { group: '相 处 方 式', title: '絮语与启动', desc: '更改会自动保存。' },
  stage: { group: '相 处 方 式', title: '此刻的理解', desc: '更改会自动保存。' },
  learned: { group: '相 处 方 式', title: 'Echo 学到了什么', desc: '每天夜里 Echo 会复盘当天的对话，把被你纠正过的地方记下来。这里能看到它学到的每一条，随时可以删除。' },
  care: { group: '相 处 方 式', title: '主动关心', desc: '更改会自动保存。' },
  tasks: { group: '系 统', title: '运行任务', desc: '任务在后台继续，不需要守着。' },
  window: { group: '系 统', title: '窗口与关闭', desc: '更改会自动保存。' },
  data: { group: '系 统', title: '本地数据', desc: '清空前需要再次确认。' },
}

interface SettingsPageProps extends AppPageProps {
  echo: EchoApi
  settings: Settings | null
  setSettings: (settings: Settings) => void
  reloadSettings: () => Promise<void>
  hasLlmConfig: boolean
  refreshProfile: () => Promise<void>
  refreshQueue: () => Promise<Track[]>
  importFocusToken?: number
  apiFocusToken?: number
  learnedFocusToken?: number
  importTask: ImportTaskSnapshot | null
  onOnboardingLlmReady?: () => Promise<void>
  onRestartOnboarding?: () => void
  onDataReset?: (settings: Settings) => void
}

const providerPresets: Record<string, { label: string; baseUrl: string; keyHint: string; modelPlaceholder: string; docsUrl: string }> = {
  deepseek: {
    label: 'DeepSeek · 深度求索',
    baseUrl: 'https://api.deepseek.com/v1',
    keyHint: '本地加密存储。DeepSeek 后台 → API Keys。',
    modelPlaceholder: 'deepseek-v4-pro',
    docsUrl: 'https://platform.deepseek.com/api-docs/models',
  },
  moonshot: {
    label: 'Moonshot · Kimi',
    baseUrl: 'https://api.moonshot.cn/v1',
    keyHint: '本地加密存储。Kimi 开放平台 → API Key 管理。',
    modelPlaceholder: 'kimi-k2.5',
    docsUrl: 'https://platform.moonshot.cn/docs/intro',
  },
  zhipu: {
    label: '智谱 · GLM',
    baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
    keyHint: '本地加密存储。智谱开放平台 → API Keys。',
    modelPlaceholder: 'glm-5.1',
    docsUrl: 'https://open.bigmodel.cn/dev/howto/model',
  },
  qwen: {
    label: '通义千问 · Qwen',
    baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
    keyHint: '本地加密存储。阿里云百炼 → API Key。',
    modelPlaceholder: 'qwen3.6-max-preview',
    docsUrl: 'https://help.aliyun.com/zh/model-studio/getting-started/models',
  },
  openai: {
    label: 'OpenAI',
    baseUrl: 'https://api.openai.com/v1',
    keyHint: '本地加密存储。OpenAI → API Keys。',
    modelPlaceholder: 'gpt-5.5',
    docsUrl: 'https://platform.openai.com/docs/models',
  },
  custom: {
    label: '自定义',
    baseUrl: '',
    keyHint: '本地加密存储。',
    modelPlaceholder: '模型名',
    docsUrl: '',
  },
}

function detectProvider(baseUrl: string): string {
  for (const [key, preset] of Object.entries(providerPresets)) {
    if (key !== 'custom' && preset.baseUrl && baseUrl === preset.baseUrl) return key
  }
  return 'custom'
}

const defaultTtsBaseUrl = 'https://tts.wangwangit.com'
const drawerExitMs = 360
const semanticSummaryUnavailable = '语义统计暂时没有读出来。'
const importResultStatusTtlMs = 8000
const stageKindLabels: Record<StageContext['kind'], string> = {
  work: '工作', rest: '休息', commute: '通勤', sleep: '睡眠', exercise: '运动', emotional_support: '需要陪伴', other: '当下',
}
const stageGoalLabels: Record<StageContext['goal'], string> = {
  focus: '专注', recover: '恢复', settle: '缓下来', energize: '提神', companionship: '陪伴', sleep: '入睡', none: '陪着',
}
const actionOriginLabels: Record<AgentActionSummary['origin'], string> = {
  chat: '絮语', listening: '连续回声', scene: '场景', care: '主动关心', playback: '播放',
}
const actionTypeLabels: Record<AgentActionSummary['actionType'], string> = {
  reply: '回应', clarify: '确认', play: '播放', adjust_music: '调整音乐', speak_then_play: '说完再播', silent_play: '安静播放', stay_silent: '没有打扰', safety_guidance: '安全提醒',
}
const actionOutcomeLabels: Record<AgentActionSummary['outcomes'][number]['type'], string> = {
  playback_started: '已开始播放', quick_skip: '很快切走', effective_listen: '听了一会儿', completed: '听完了', favorite: '已收藏', explicit_like: '明确喜欢', explicit_miss: '明确不合适', replay: '又听了一次', opened: '点开了', system_failure: '执行失败', user_stop: '主动停止', app_closed: '随应用结束', dismissed: '已收起', ignored: '没有回应',
}
const proactiveDecisionLabels: Record<string, string> = {
  eligible: '当时适合轻轻出现',
  disabled: '主动关心已关闭',
  paused: '正在按你的设置暂停',
  muted_today: '今天先不打扰',
  quiet_hours: '现在是安静时段',
  daily_budget_exhausted: '今天出现的次数已经够了',
  cooldown: '离上次出现还太近',
  recent_negative_feedback: '最近几次没有得到回应，先安静一阵',
  recent_user_activity: '你刚和 Echo 聊过，先不额外打扰',
  active_session: '正在陪伴中，不重复打扰',
  fullscreen_blocked: '检测到全屏，先不打扰',
  stage_prefers_quiet: '此刻更适合安静陪着',
  safety_caution: '此刻需要更谨慎地陪伴',
  insufficient_evidence: '还在积累足够的相处线索',
}

function careActionExplanation(action: AgentActionSummary): string {
  const decision = action.decisionCode ? proactiveDecisionLabels[action.decisionCode] : ''
  const outcome = action.outcomes[0] ? actionOutcomeLabels[action.outcomes[0].type] : ''
  if (decision && outcome) return `${decision} · ${outcome}`
  return decision || outcome || (action.status === 'failed' ? '这次没有完成' : '已经完成')
}

function formatSemanticSummary(summary: SemanticSummary | null): string {
  if (!summary) return '正在读取语义统计...'
  if (summary.total <= 0) return '还没有歌曲语义记录'
  const moodCount = summary.moods.length
  return `已整理 ${summary.total} 首语义${moodCount > 0 ? ` · 情绪维度 ${moodCount} 类` : ''}`
}

function shouldShowServiceHealth(item: { service: string; status: string }): boolean {
  if (!item.service.startsWith('scheduler')) return true
  return item.status === 'degraded' || item.status === 'error'
}

function asyncStatusClass(state: string): 'ok' | 'err' | 'idle' {
  if (state === 'ok') return 'ok'
  if (state === 'err') return 'err'
  return 'idle'
}

function qrStatusClass(message: string): 'err' | 'idle' {
  return /失败|过期|异常|没有生成|失效/i.test(message) ? 'err' : 'idle'
}

function playlistStatusClass(message: string): 'err' | 'idle' {
  return /失败|没有读出来|暂时没有读出来|登录.*失效/i.test(message) ? 'err' : 'idle'
}

const ttsVoices = [
  ['zh-CN-XiaochenNeural', '晓辰 · 知性'],
  ['zh-CN-XiaoxiaoNeural', '晓晓 · 温柔'],
  ['zh-CN-XiaoyiNeural', '晓伊 · 明亮'],
  ['zh-CN-XiaohanNeural', '晓涵 · 轻柔'],
  ['zh-CN-XiaomengNeural', '晓梦 · 亲和'],
  ['zh-CN-XiaomoNeural', '晓墨 · 沉稳'],
  ['zh-CN-XiaoqiuNeural', '晓秋 · 清亮'],
  ['zh-CN-XiaorouNeural', '晓柔 · 柔和'],
  ['zh-CN-XiaoruiNeural', '晓睿 · 成熟'],
  ['zh-CN-XiaoshuangNeural', '晓双 · 童声'],
  ['zh-CN-XiaoxuanNeural', '晓萱 · 自然'],
  ['zh-CN-XiaoyanNeural', '晓颜 · 标准'],
  ['zh-CN-XiaoyouNeural', '晓悠 · 少年'],
  ['zh-CN-XiaozhenNeural', '晓甄 · 明快'],
  ['zh-CN-YunfengNeural', '云枫 · 干净'],
  ['zh-CN-YunhaoNeural', '云皓 · 朗读'],
  ['zh-CN-YunjianNeural', '云健 · 稳重'],
  ['zh-CN-YunxiNeural', '云希 · 清爽'],
  ['zh-CN-YunxiaNeural', '云夏 · 少年'],
  ['zh-CN-YunyangNeural', '云扬 · 播报'],
  ['zh-CN-YunyeNeural', '云野 · 温厚'],
  ['zh-CN-YunzeNeural', '云泽 · 平实'],
]

export function SettingsPage({
  navigate,
  echo,
  settings,
  setSettings,
  reloadSettings,
  hasLlmConfig,
  refreshProfile,
  refreshQueue,
  importFocusToken = 0,
  apiFocusToken = 0,
  learnedFocusToken = 0,
  importTask,
  onOnboardingLlmReady,
  onRestartOnboarding,
  onDataReset,
}: SettingsPageProps) {
  const {
    patchSettingsPageState,
    provider,
    baseUrl,
    setBaseUrl,
    apiKey,
    setApiKey,
    model,
    setModel,
    generateAt,
    setGenerateAt,
    openWithRandom,
    setOpenWithRandom,
    restoreOnStart,
    setRestoreOnStart,
    city,
    setCity,
    ttsBaseUrl,
    setTtsBaseUrl,
    ttsVoice,
    setTtsVoice,
    ttsSpeed,
    setTtsSpeed,
    ttsTestStatus,
    setTtsTestStatus,
    ttsTestState,
    setTtsTestState,
    careEnabled,
    setCareEnabled,
    careFrequency,
    setCareFrequency,
    careDetectFullscreen,
    setCareDetectFullscreen,
    careQuietEnabled,
    setCareQuietEnabled,
    careQuietStart,
    setCareQuietStart,
    careQuietEnd,
    setCareQuietEnd,
    careStatus,
    setCareStatus,
    modelStatus,
    setModelStatus,
    yinyiStatus,
    setYinyiStatus,
    chatStatus,
    setChatStatus,
    voiceSettingsStatus,
    setVoiceSettingsStatus,
    dataStatus,
    setDataStatus,
    dataState,
    setDataState,
    testState,
    setTestState,
    importStatus,
    setImportStatus,
    importState,
    setImportState,
    profileStatus,
    setProfileStatus,
    profileState,
    setProfileState,
    templateStatus,
    setTemplateStatus,
    templateState,
    setTemplateState,
    neteaseState,
    setNeteaseState,
    neteaseQr,
    setNeteaseQr,
    neteaseQrStatus,
    setNeteaseQrStatus,
    neteaseLoginStatus,
    setNeteaseLoginStatus,
    neteaseLoginStatusState,
    setNeteaseLoginStatusState,
    neteasePlaylists,
    setNeteasePlaylists,
    neteasePlaylistStatus,
    setNeteasePlaylistStatus,
    importingNeteaseId,
    setImportingNeteaseId,
    neteaseBusy,
    setNeteaseBusy,
    health,
    setHealth,
    healthChecking,
    setHealthChecking,
    busy,
    setBusy,
    showResetConfirm,
    setShowResetConfirm,
    resetConfirmChecked,
    setResetConfirmChecked,
  } = useSettingsPageState()

  const [activeTab, setActiveTab] = useState<'sync' | 'pref' | 'sys'>(hasLlmConfig ? 'sync' : 'sys')
  const [settingsView, setSettingsView] = useState<'overview' | 'connections' | 'tasks' | 'details'>('details')
  const [detailTarget, setDetailTarget] = useState<SettingsSectionKey>(hasLlmConfig ? 'music' : 'llm')
  const [detailParent, setDetailParent] = useState<'overview' | 'connections'>('overview')

  const [showNeteaseDrawer, setShowNeteaseDrawer] = useState(false)
  const [renderNeteaseDrawer, setRenderNeteaseDrawer] = useState(false)
  const [ttsEditingCustom, setTtsEditingCustom] = useState(false)
  const [semanticSummary, setSemanticSummary] = useState<SemanticSummary | null>(null)
  const [semanticSummaryStatus, setSemanticSummaryStatus] = useState('')
  const [neteasePhone, setNeteasePhone] = useState('')
  const [neteaseCaptcha, setNeteaseCaptcha] = useState('')
  const [neteaseCaptchaCooldown, setNeteaseCaptchaCooldown] = useState(0)
  const [neteaseCookieInput, setNeteaseCookieInput] = useState('')
  const [stageContext, setStageContext] = useState<StageContext | null>(null)
  const [recentAgentActions, setRecentAgentActions] = useState<AgentActionSummary[]>([])
  const [recentCareActions, setRecentCareActions] = useState<AgentActionSummary[]>([])
  const [stageContextStatus, setStageContextStatus] = useState('')
  const [learnedCases, setLearnedCases] = useState<LearnedCaseView[]>([])
  const [learnedStatus, setLearnedStatus] = useState('')
  const [dreamTimeDraft, setDreamTimeDraft] = useState('')
  const [windowSizeStatus, setWindowSizeStatus] = useState('')
  const [windowSizeBusy, setWindowSizeBusy] = useState(false)
  const [importBoundary, setImportBoundary] = useState<UiBoundarySnapshot | null>(null)

  function switchProvider(key: string) {
    const preset = providerPresets[key]
    patchSettingsPageState({
      provider: key,
      baseUrl: preset?.baseUrl ? preset.baseUrl : baseUrl,
      testState: 'idle',
      modelStatus: '',
    })
  }
  const skipHydrateRef = useRef(false)
  const importSectionRef = useRef<HTMLDivElement | null>(null)
  const apiSectionRef = useRef<HTMLDivElement | null>(null)
  const ttsSpeedSaveKeyRef = useRef('')
  const ttsBaseUrlInputRef = useRef<HTMLInputElement | null>(null)
  const neteasePlaylistButtonRef = useRef<HTMLButtonElement | null>(null)
  const drawerSheetRef = useRef<HTMLDivElement | null>(null)
  const drawerCloseButtonRef = useRef<HTMLButtonElement | null>(null)
  const drawerReturnFocusRef = useRef<HTMLElement | null>(null)
  const drawerOpenFrameRef = useRef<number | null>(null)
  const drawerCloseTimerRef = useRef<number | null>(null)
  const semanticImportHandledRef = useRef<Set<string>>(new Set())
  const semanticRuntimeHandledRef = useRef<Set<string>>(new Set())
  const semanticBackfillPromiseRef = useRef<Promise<boolean> | null>(null)
  const semanticProfileRefreshPromiseRef = useRef<Promise<boolean> | null>(null)
  const mountedAtMsRef = useRef(Date.now())
  const runtimeTasks = useRuntimeTasks(echo)

  function commitSettings(next: Settings) {
    skipHydrateRef.current = true
    setSettings(next)
  }

  async function updateWindowSize(preset: WindowSizePreset) {
    if (!settings || windowSizeBusy) return
    const previous = settings.ui.windowSize ?? 'standard'
    if (previous === preset) return
    setWindowSizeBusy(true)
    setWindowSizeStatus('正在调整窗口...')
    try {
      await echo.window.setSizePreset(preset)
      const next = await echo.settings.update('ui.windowSize', preset)
      commitSettings(next)
      setWindowSizeStatus('窗口尺寸已保存')
    } catch (error) {
      if (previous !== preset) {
        await echo.window.setSizePreset(previous).catch((rollbackError) => {
          console.warn('[settings] window size rollback failed', rollbackError)
        })
      }
      setWindowSizeStatus(friendlyOperationError(error, '窗口尺寸没有调整成功，请重试。'))
    } finally {
      setWindowSizeBusy(false)
    }
  }

  async function updateOverviewSetting(path: 'playback.autoPlayNext' | 'ui.closeBehavior', value: boolean | NonNullable<Settings['ui']['closeBehavior']>) {
    if (!settings) return
    try {
      const next = path === 'playback.autoPlayNext'
        ? await echo.settings.update(path, value as boolean)
        : await echo.settings.update(path, value as NonNullable<Settings['ui']['closeBehavior']>)
      commitSettings(next)
    } catch (error) {
      setWindowSizeStatus(friendlyOperationError(error, '设置没有保存成功，请重试。'))
    }
  }

  function openDetails(tab: 'sync' | 'pref' | 'sys', target: typeof detailTarget, parent: typeof detailParent = 'overview') {
    setActiveTab(tab)
    setDetailTarget(target)
    setDetailParent(parent)
    setSettingsView('details')
  }

  const refreshSemanticSummary = useCallback(async (): Promise<SemanticSummary | null> => {
    try {
      const next = await echo.semantics.getSummary()
      setSemanticSummary(next)
      setSemanticSummaryStatus('')
      return next
    } catch (error) {
      console.warn('[settings] semantic summary failed', error)
      setSemanticSummaryStatus(semanticSummaryUnavailable)
      return null
    }
  }, [echo])

  const restoreDrawerFocus = useCallback(() => {
    const target = drawerReturnFocusRef.current
    if (target?.isConnected) target.focus()
    drawerReturnFocusRef.current = null
  }, [])

  const finishNeteaseDrawerClose = useCallback(() => {
    if (drawerCloseTimerRef.current) {
      window.clearTimeout(drawerCloseTimerRef.current)
      drawerCloseTimerRef.current = null
    }
    setRenderNeteaseDrawer(false)
    restoreDrawerFocus()
  }, [restoreDrawerFocus])

  const openNeteaseDrawer = useCallback((trigger?: HTMLElement | null) => {
    if (drawerCloseTimerRef.current) {
      window.clearTimeout(drawerCloseTimerRef.current)
      drawerCloseTimerRef.current = null
    }
    if (drawerOpenFrameRef.current) {
      window.cancelAnimationFrame(drawerOpenFrameRef.current)
    }
    const activeElement = document.activeElement instanceof HTMLElement ? document.activeElement : null
    drawerReturnFocusRef.current = trigger ?? neteasePlaylistButtonRef.current ?? activeElement
    setRenderNeteaseDrawer(true)
    drawerOpenFrameRef.current = window.requestAnimationFrame(() => {
      drawerOpenFrameRef.current = null
      setShowNeteaseDrawer(true)
    })
  }, [])

  const refreshNeteasePlaylistsAfterLogin = useCallback(async (loginMessage = '登录成功') => {
    setNeteasePlaylistStatus('正在读取网易云歌单...')
    try {
      const playlists = await echo.netease.listPlaylists()
      setNeteasePlaylists(playlists)
      if (playlists.length > 0) {
        setNeteasePlaylistStatus(`${loginMessage}，读到 ${playlists.length} 个歌单`)
        openNeteaseDrawer()
        return
      }
      setNeteasePlaylistStatus(`${loginMessage}，暂时没有读到歌单`)
    } catch (error) {
      setNeteasePlaylistStatus(`${loginMessage}，歌单暂时没有读出来。`)
      console.warn('[settings] load netease playlists after login failed', error)
    }
  }, [echo, openNeteaseDrawer, setNeteasePlaylistStatus, setNeteasePlaylists])

  const closeNeteaseDrawer = useCallback(() => {
    setShowNeteaseDrawer(false)
    if (drawerOpenFrameRef.current) {
      window.cancelAnimationFrame(drawerOpenFrameRef.current)
      drawerOpenFrameRef.current = null
    }
    if (drawerCloseTimerRef.current) window.clearTimeout(drawerCloseTimerRef.current)
    drawerCloseTimerRef.current = window.setTimeout(finishNeteaseDrawerClose, drawerExitMs)
  }, [finishNeteaseDrawerClose])

  useEffect(() => {
    if (!settings) return
    if (skipHydrateRef.current) {
      skipHydrateRef.current = false
      return
    }
    patchSettingsPageState({
      baseUrl: settings.llm.baseUrl,
      provider: detectProvider(settings.llm.baseUrl),
      apiKey: settings.llm.apiKey,
      model: settings.llm.model,
      generateAt: settings.yinyi.generateAt,
      openWithRandom: settings.yinyi.openWithRandom,
      restoreOnStart: settings.chat.restoreOnStart,
      city: settings.user.city,
      ttsBaseUrl: settings.tts.baseUrl,
      ttsVoice: settings.tts.voice,
      ttsSpeed: settings.tts.speed,
      careEnabled: settings.carePings.enabled,
      careFrequency: settings.carePings.frequency,
      careDetectFullscreen: settings.carePings.detectFullscreen,
      careQuietEnabled: settings.carePings.quietHours.enabled,
      careQuietStart: settings.carePings.quietHours.start,
      careQuietEnd: settings.carePings.quietHours.end,
    })
    setTtsEditingCustom(false)
  }, [patchSettingsPageState, settings])

  useEffect(() => () => {
    if (drawerOpenFrameRef.current) window.cancelAnimationFrame(drawerOpenFrameRef.current)
    if (drawerCloseTimerRef.current) window.clearTimeout(drawerCloseTimerRef.current)
  }, [])

  useEffect(() => {
    let alive = true
    echo.netease.getLoginState().then((state) => {
      if (alive) setNeteaseState(state)
    }).catch(() => {
      if (alive) setNeteaseState({ loggedIn: false, message: '网易云状态检查失败' })
    })
    return () => {
      alive = false
    }
  }, [echo, setNeteaseState])

  useEffect(() => {
    let alive = true
    echo.health.get().then((items) => {
      if (alive) setHealth(items)
    }).catch(() => {
      if (alive) setHealth([])
    })
    return () => {
      alive = false
    }
  }, [echo, setHealth])

  useEffect(() => {
    void refreshSemanticSummary()
  }, [refreshSemanticSummary])

  const refreshAgentContext = useCallback(async () => {
    try {
      const [context, actions, careActions] = await Promise.all([
        echo.stageContext.getActive(),
        echo.stageContext.recentActions(8),
        echo.stageContext.recentActions(3, 'care'),
      ])
      setStageContext(context)
      setRecentAgentActions(actions)
      setRecentCareActions(careActions)
    } catch (error) {
      console.warn('[settings] agent context failed', error)
    }
  }, [echo])

  useEffect(() => {
    void refreshAgentContext()
  }, [refreshAgentContext])

  const refreshLearnedCases = useCallback(async () => {
    try {
      setLearnedCases(await echo.learnedCases.list())
    } catch (error) {
      console.warn('[settings] learned cases failed', error)
    }
  }, [echo])

  useEffect(() => {
    void refreshLearnedCases()
  }, [refreshLearnedCases])

  async function deleteLearnedCase(id: string) {
    try {
      await echo.learnedCases.delete(id)
      setLearnedStatus('已删除。')
      await refreshLearnedCases()
    } catch {
      setLearnedStatus('删除没成功，稍后再试。')
    }
  }

  const learnedKindLabels: Record<LearnedCaseView['kind'], string> = { entity_correction: '实体纠正', phrasing_precedent: '措辞先例', artist_alias: '歌手称呼' }
  const learnedStatusLabels: Record<LearnedCaseView['status'], string> = { active: '生效中', pending: '待印证', retired: '已淡忘' }

  function summarizeLearnedCase(item: LearnedCaseView): string {
    const artist = typeof item.learned.expectArtistQuery === 'string' ? item.learned.expectArtistQuery : ''
    const title = typeof item.learned.expectSeedTitle === 'string' ? item.learned.expectSeedTitle : ''
    const alias = typeof item.learned.alias === 'string' ? item.learned.alias : ''
    const expectedKind = typeof item.learned.expectedKind === 'string' ? item.learned.expectedKind : ''
    if (item.kind === 'artist_alias' && alias && artist) return `「${alias}」指的是 ${artist}`
    if (artist && title) return `指 ${artist} 的《${title}》`
    if (artist) return `指歌手 ${artist} 的歌`
    if (title) return `指歌曲《${title}》`
    if (expectedKind) return `应按 ${expectedKind} 理解`
    return '记住了这条说法'
  }

  async function updateDreamSetting(path: 'dream.enabled' | 'dream.reviewAt', value: boolean | string) {
    try {
      const next = await echo.settings.update(path, value)
      setSettings(next)
      setDreamTimeDraft('')
    } catch {
      setLearnedStatus('保存没成功，稍后再试。')
    }
  }

  async function endCurrentStageContext() {
    await echo.stageContext.end()
    setStageContextStatus('当前阶段已结束')
    await refreshAgentContext()
  }

  async function deleteCurrentStageContext() {
    if (!stageContext) return
    await echo.stageContext.delete(stageContext.id)
    setStageContextStatus('这条理解已删除')
    await refreshAgentContext()
  }

  useEffect(() => {
    if (importTask?.status !== 'succeeded') return
    if (semanticImportHandledRef.current.has(importTask.id)) return
    semanticImportHandledRef.current.add(importTask.id)
    void refreshSemanticSummary()
  }, [importTask, refreshSemanticSummary])

  const refreshProfileAfterSemanticUpdate = useCallback(async (): Promise<boolean> => {
    if (semanticProfileRefreshPromiseRef.current) return semanticProfileRefreshPromiseRef.current
    const task = (async () => {
      try {
        return await refreshProfileAfterSemanticUpdateAction({
          refreshStructuredProfile: () => echo.taste.refreshStructuredProfile(),
          regeneratePortrait: () => echo.taste.regeneratePortrait(),
          refreshProfile,
          setProfileState,
          setProfileStatus,
          friendlyError: friendlyOperationError,
        })
      } finally {
        semanticProfileRefreshPromiseRef.current = null
      }
    })()
    semanticProfileRefreshPromiseRef.current = task
    return task
  }, [echo, refreshProfile, setProfileState, setProfileStatus])

  useEffect(() => {
    const completedSemanticTask = runtimeTasks.find((task) => shouldRefreshProfileForSemanticTask(task, mountedAtMsRef.current))
    if (!completedSemanticTask || semanticRuntimeHandledRef.current.has(completedSemanticTask.id)) return
    semanticRuntimeHandledRef.current.add(completedSemanticTask.id)
    if (semanticBackfillPromiseRef.current) return
    void refreshSemanticSummary()
    void refreshProfileAfterSemanticUpdate()
  }, [refreshProfileAfterSemanticUpdate, refreshSemanticSummary, runtimeTasks])

  useEffect(() => {
    if (importState !== 'ok' || !importStatus) return
    const timer = window.setTimeout(() => {
      setImportStatus('')
      setImportState('idle')
    }, importResultStatusTtlMs)
    return () => window.clearTimeout(timer)
  }, [importState, importStatus, setImportState, setImportStatus])

  useEffect(() => {
    if (profileState !== 'ok' || !profileStatus) return
    const timer = window.setTimeout(() => {
      setProfileStatus('')
      setProfileState('idle')
    }, importResultStatusTtlMs)
    return () => window.clearTimeout(timer)
  }, [profileState, profileStatus, setProfileState, setProfileStatus])

  useEffect(() => {
    if (!shouldAutoClearNeteaseImportStatus(neteasePlaylistStatus)) return
    const timer = window.setTimeout(() => {
      setNeteasePlaylistStatus('')
    }, importResultStatusTtlMs)
    return () => window.clearTimeout(timer)
  }, [neteasePlaylistStatus, setNeteasePlaylistStatus])

  useEffect(() => {
    if (neteaseCaptchaCooldown <= 0) return undefined
    const timer = window.setInterval(() => {
      setNeteaseCaptchaCooldown((current) => Math.max(0, current - 1))
    }, 1000)
    return () => window.clearInterval(timer)
  }, [neteaseCaptchaCooldown])

  useEffect(() => {
    if (!importFocusToken) return
    setSettingsView('details')
    setDetailTarget('music')
    setDetailParent('overview')
    setActiveTab('sync')
    window.setTimeout(() => {
      importSectionRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' })
    }, 120)
  }, [importFocusToken])

  useEffect(() => {
    if (!apiFocusToken) return
    setSettingsView('details')
    setDetailTarget('llm')
    setDetailParent('connections')
    setActiveTab('sys')
    window.setTimeout(() => {
      apiSectionRef.current?.scrollIntoView({ block: 'start', behavior: 'smooth' })
    }, 120)
  }, [apiFocusToken])

  const learnedFocusRef = useRef(() => {})
  learnedFocusRef.current = () => {
    void refreshLearnedCases()
    openDetails('pref', 'learned')
  }

  useEffect(() => {
    if (!learnedFocusToken) return
    learnedFocusRef.current()
  }, [learnedFocusToken])

  useEffect(() => {
    if (!showNeteaseDrawer) return
    const focusTimer = window.setTimeout(() => {
      drawerCloseButtonRef.current?.focus()
    }, 0)

    function handleKeyDown(event: KeyboardEvent) {
      if (event.key === 'Escape') {
        event.preventDefault()
        closeNeteaseDrawer()
        return
      }
      if (event.key !== 'Tab') return
      const drawer = drawerSheetRef.current
      if (!drawer) return
      const focusable = Array.from(
        drawer.querySelectorAll<HTMLElement>(
          'button:not(:disabled), [href], input:not(:disabled), select:not(:disabled), textarea:not(:disabled), [tabindex]:not([tabindex="-1"])',
        ),
      )
      if (focusable.length === 0) return
      const first = focusable[0]
      const last = focusable[focusable.length - 1]
      if (event.shiftKey && document.activeElement === first) {
        event.preventDefault()
        last.focus()
      } else if (!event.shiftKey && document.activeElement === last) {
        event.preventDefault()
        first.focus()
      }
    }

    document.addEventListener('keydown', handleKeyDown)
    return () => {
      window.clearTimeout(focusTimer)
      document.removeEventListener('keydown', handleKeyDown)
    }
  }, [closeNeteaseDrawer, showNeteaseDrawer])

  useEffect(() => {
    if (!neteaseQr) return
    let stopped = false
    const timer = window.setInterval(async () => {
      try {
        const result = await echo.netease.checkQrLogin(neteaseQr.key)
        if (stopped) return
        setNeteaseQrStatus(result.message)
        if (result.status === 'authorized' && result.state) {
          setNeteaseState(result.state)
          setNeteaseQr(null)
          setNeteaseLoginStatus('')
          setNeteaseLoginStatusState('idle')
          window.clearInterval(timer)
          await refreshNeteasePlaylistsAfterLogin(result.message)
        }
        if (result.status === 'expired' || result.status === 'failed') {
          setNeteaseQr(null)
          window.clearInterval(timer)
        }
      } catch (error) {
        if (!stopped) setNeteaseQrStatus(friendlyOperationError(error, '登录状态检查失败，请重新登录。'))
      }
    }, 1800)
    return () => {
      stopped = true
      window.clearInterval(timer)
    }
  }, [echo, neteaseQr, refreshNeteasePlaylistsAfterLogin, setNeteaseLoginStatus, setNeteaseLoginStatusState, setNeteaseQr, setNeteaseQrStatus, setNeteaseState])

  async function save(event?: FormEvent): Promise<boolean> {
    event?.preventDefault()
    setBusy(true)
    setTestState('idle')
    try {
      const next = await echo.settings.updateBatch([
        { path: 'llm.baseUrl', value: baseUrl.trim() },
        { path: 'llm.apiKey', value: apiKey.trim() },
        { path: 'llm.model', value: model.trim() },
        { path: 'yinyi.generateAt', value: generateAt },
        { path: 'yinyi.openWithRandom', value: openWithRandom },
        { path: 'chat.restoreOnStart', value: restoreOnStart },
        { path: 'user.city', value: city.trim() },
        { path: 'tts.baseUrl', value: ttsBaseUrl.trim() || defaultTtsBaseUrl },
        { path: 'tts.voice', value: ttsVoice },
        { path: 'tts.speed', value: ttsSpeed },
        { path: 'carePings.enabled', value: careEnabled },
        { path: 'carePings.frequency', value: careFrequency },
        { path: 'carePings.detectFullscreen', value: careDetectFullscreen },
        { path: 'carePings.quietHours.enabled', value: careQuietEnabled },
        { path: 'carePings.quietHours.start', value: careQuietStart },
        { path: 'carePings.quietHours.end', value: careQuietEnd },
      ])
      commitSettings(next)
      setHealth(await echo.health.get().catch(() => health))
      setModelStatus('已保存')
      setTestState('ok')
      return true
    } catch (error) {
      setModelStatus(friendlyOperationError(error, '设置没有保存，请检查后再试。'))
      setTestState('fail')
      setHealth(await echo.health.get().catch(() => health))
      return false
    } finally {
      setBusy(false)
    }
  }

  async function backfillSemanticsAfterModelReady(): Promise<boolean> {
    if (semanticBackfillPromiseRef.current) return semanticBackfillPromiseRef.current
    const task = (async () => {
      setSemanticSummaryStatus('正在补齐歌曲语义...')
      try {
        const result = await echo.semantics.buildForImportedTracks()
        await refreshSemanticSummary()
        if (shouldRefreshProfileAfterSemanticBackfill(result)) {
          await refreshProfileAfterSemanticUpdate()
        } else {
          setSemanticSummaryStatus(semanticBackfillResultStatus(result))
        }
        return true
      } catch (error) {
        console.warn('[settings] semantic backfill failed', error)
        setSemanticSummaryStatus(friendlyOperationError(error, '语义补齐没有完成，稍后再试。'))
        return false
      } finally {
        semanticBackfillPromiseRef.current = null
      }
    })()
    semanticBackfillPromiseRef.current = task
    return task
  }

  async function openFeedback() {
    try {
      await echo.app.openFeedback()
    } catch (error) {
      console.warn('[settings] open feedback failed', error)
    }
  }

  async function updateRestoreOnStart(value: boolean) {
    const previous = restoreOnStart
    setRestoreOnStart(value)
    setChatStatus('')
    try {
      const next = await echo.settings.update('chat.restoreOnStart', value)
      commitSettings(next)
      setChatStatus('已保存')
    } catch (error) {
      setRestoreOnStart(previous)
      setChatStatus(friendlyOperationError(error, '设置没有保存，请稍后再试。'))
    }
  }

  async function updateYinyiGenerateAt(value: string) {
    const previous = generateAt
    if (!/^\d{2}:\d{2}$/.test(value)) {
      setYinyiStatus('时间格式不对')
      return
    }
    setGenerateAt(value)
    setYinyiStatus('')
    try {
      const next = await echo.settings.update('yinyi.generateAt', value)
      commitSettings(next)
      setYinyiStatus('已保存')
    } catch (error) {
      setGenerateAt(previous)
      setYinyiStatus(friendlyOperationError(error, '生成时间没有保存，请稍后再试。'))
    }
  }

  async function updateYinyiOpenWithRandom(value: boolean) {
    const previous = openWithRandom
    setOpenWithRandom(value)
    setYinyiStatus('')
    try {
      const next = await echo.settings.update('yinyi.openWithRandom', value)
      commitSettings(next)
      setYinyiStatus('已保存')
    } catch (error) {
      setOpenWithRandom(previous)
      setYinyiStatus(friendlyOperationError(error, '设置没有保存，请稍后再试。'))
    }
  }

  async function testLlm() {
    if (!(await save())) return
    setBusy(true)
    setTestState('testing')
    setModelStatus('正在测试连接...')
    try {
      const result = await echo.settings.testLlm()
      setTestState(result.ok ? 'ok' : 'fail')
      setModelStatus(result.ok ? result.message || `连接正常 · ${result.latencyMs ?? '-'} ms` : result.message)
      setHealth(await echo.health.get())
      if (result.ok) {
        const backfilled = await backfillSemanticsAfterModelReady()
        if (backfilled) {
          await onOnboardingLlmReady?.().catch((error) => {
            console.warn('[settings] onboarding progression failed', error)
          })
        }
      }
    } catch (error) {
      setTestState('fail')
      setModelStatus(friendlyOperationError(error, '模型连接失败，请检查设置。'))
    } finally {
      setBusy(false)
    }
  }

  async function importPlaylist() {
    setBusy(true)
    setImportBoundary(null)
    setImportState('importing')
    setImportStatus('正在读取通用歌单 JSON、写入本地数据库，并生成你的初始画像...')
    try {
      const result = await echo.settings.importPlaylist()
      setImportBoundary(result.boundary ?? null)
      const summary = result.imported ? await refreshSemanticSummary() : semanticSummary
      setImportState(result.imported ? 'ok' : result.count === 0 && result.message === '导入已取消' ? 'idle' : 'fail')
      setImportStatus(formatImportResultStatus(result, summary))
    } catch (error) {
      setImportState('fail')
      setImportStatus(friendlyOperationError(error, '这次导入没有完成，请稍后再试。'))
    } finally {
      setBusy(false)
    }
  }

  async function downloadTemplate() {
    setTemplateState('working')
    setTemplateStatus('正在准备模板...')
    try {
      const result = await echo.settings.downloadPlaylistTemplate()
      setTemplateState(result.ok ? 'ok' : 'idle')
      setTemplateStatus(result.message)
    } catch (error) {
      setTemplateState('fail')
      setTemplateStatus(friendlyOperationError(error, '模板没有保存，请稍后再试。'))
    }
  }

  function importProgressLine(progress: ImportProgressPayload): string {
    if (progress.phase === 'semantics') {
      const total = Math.max(1, Math.ceil(progress.total / 25))
      const current = Math.min(total, Math.ceil(progress.current / 25))
      return `正在整理歌曲 ${current}/${total} 批 · ${progress.current}/${progress.total} 首`
    }
    if (progress.phase === 'profile') return '正在更新画像...'
    return '导入完成'
  }

  function importProgressPercent(progress: ImportProgressPayload): number {
    if (progress.phase === 'done') return 100
    if (progress.phase === 'profile') return 95
    if (progress.total <= 0) return 0
    return Math.min(90, Math.round((progress.current / progress.total) * 90))
  }

  async function regenerateProfile() {
    if (profileRefreshRunning) return
    setBusy(true)
    setProfileState('importing')
    setProfileStatus('Echo 正在重新整理你的画像...')
    try {
      await echo.taste.regeneratePortrait()
      await refreshProfile()
      setProfileState('ok')
      setProfileStatus('画像已重新生成')
    } catch (error) {
      try {
        await refreshProfile()
      } catch {
        // Keep the original generation error as the visible status; profile refresh is a recovery attempt.
      }
      setProfileState('fail')
      const message = error instanceof Error ? error.message : String(error)
      setProfileStatus(
        /API.?key|鉴权|401|403|配置/i.test(message)
          ? '我这会儿连不上模型，检查一下 API 设置。'
          : /超时|网络|fetch|ECONN|ENOTFOUND|服务端/i.test(message)
            ? '刚才连接不太顺，稍后再试一次。'
            : '我刚才没写顺，原来的画像还在。',
      )
    } finally {
      setBusy(false)
    }
  }

  function requestResetData() {
    if (anyRuntimeTaskRunning) {
      setDataState('err')
      setDataStatus('运行任务还在进行，完成后再清空数据。')
      return
    }
    setResetConfirmChecked(false)
    setShowResetConfirm(true)
  }

  async function resetData() {
    if (!resetConfirmChecked) return
    setBusy(true)
    setDataState('working')
    try {
      setShowResetConfirm(false)
      await echo.settings.resetData()
      const next = await echo.settings.get()
      setSettings(next)
      onDataReset?.(next)
      await Promise.all([
        refreshProfile().catch((error) => console.warn('[settings] refresh profile after reset failed', error)),
        refreshQueue().catch((error) => console.warn('[settings] refresh queue after reset failed', error)),
      ])
      setNeteaseState(await echo.netease.getLoginState().catch(() => ({ loggedIn: false, message: '网易云状态检查失败' })))
      setHealth(await echo.health.get().catch(() => []))
      patchSettingsPageState({
        neteaseQr: null,
        neteaseQrStatus: '',
        neteaseLoginStatus: '',
        neteaseLoginStatusState: 'idle',
        neteasePlaylists: [],
        neteasePlaylistStatus: '',
        importStatus: '',
        profileStatus: '',
        profileState: 'idle',
        dataStatus: '数据已清空',
        dataState: 'ok',
      })
      setSemanticSummary(null)
      setSemanticSummaryStatus('')
    } catch (error) {
      setDataStatus(friendlyOperationError(error, '数据清空失败，请重新打开 Echo 后再试。'))
      setDataState('err')
    } finally {
      setBusy(false)
      setResetConfirmChecked(false)
    }
  }

  async function saveVoiceSettings(overrides: Partial<{ city: string; ttsBaseUrl: string; ttsVoice: string; ttsSpeed: number }> = {}) {
    const nextCity = overrides.city ?? city
    const nextBaseUrl = overrides.ttsBaseUrl ?? ttsBaseUrl
    const nextVoice = overrides.ttsVoice ?? ttsVoice
    const nextSpeed = overrides.ttsSpeed ?? ttsSpeed
    setVoiceSettingsStatus('')
    const normalizedBaseUrl = nextBaseUrl.trim()
    if (normalizedBaseUrl === 'https://' || normalizedBaseUrl === 'http://') {
      setVoiceSettingsStatus('请填写完整的 TTS 服务地址')
      return false
    }
    try {
      const next = await echo.settings.updateBatch([
        { path: 'user.city', value: nextCity.trim() },
        { path: 'tts.baseUrl', value: normalizedBaseUrl || defaultTtsBaseUrl },
        { path: 'tts.voice', value: nextVoice },
        { path: 'tts.speed', value: Math.max(0.5, Math.min(1.5, nextSpeed)) },
      ])
      commitSettings(next)
      setTtsEditingCustom(Boolean(normalizedBaseUrl && normalizedBaseUrl !== defaultTtsBaseUrl))
      setVoiceSettingsStatus('已保存')
      return true
    } catch (error) {
      setVoiceSettingsStatus(friendlyOperationError(error, '语音设置没有保存，请稍后再试。'))
      return false
    }
  }

  function saveTtsSpeedOnce(value: number) {
    const key = value.toFixed(1)
    if (ttsSpeedSaveKeyRef.current === key) return
    ttsSpeedSaveKeyRef.current = key
    void saveVoiceSettings({ ttsSpeed: value }).finally(() => {
      window.setTimeout(() => {
        if (ttsSpeedSaveKeyRef.current === key) ttsSpeedSaveKeyRef.current = ''
      }, 250)
    })
  }

  async function testTtsConnection() {
    if (!(await saveVoiceSettings())) return
    setTtsTestState('testing')
    setTtsTestStatus('正在让 Echo 试一句...')
    try {
      const result = await echo.tts.test()
      setTtsTestState(result.ok ? 'ok' : 'fail')
      setTtsTestStatus(result.message)
      setHealth(await echo.health.get().catch(() => health))
    } catch (error) {
      setTtsTestState('fail')
      setTtsTestStatus(friendlyOperationError(error, '语音服务暂时没有接通。'))
    }
  }

  async function testCarePing() {
    if (carePingRunning) return
    setCareStatus('正在发一条测试通知...')
    try {
      const result = await echo.carePings.test()
      setCareStatus(result.message)
    } catch (error) {
      setCareStatus(friendlyOperationError(error, '测试通知没有发出来。'))
    }
  }

  async function updateCareEnabled(value: boolean) {
    const previous = careEnabled
    setCareEnabled(value)
    setCareStatus('')
    try {
      const next = await echo.settings.update('carePings.enabled', value)
      commitSettings(next)
      setCareStatus('已保存')
    } catch (error) {
      setCareEnabled(previous)
      setCareStatus(friendlyOperationError(error, '设置没有保存，请稍后再试。'))
    }
  }

  async function updateCareFrequency(value: CareFrequency) {
    const previous = careFrequency
    setCareFrequency(value)
    setCareStatus('')
    try {
      const next = await echo.settings.update('carePings.frequency', value)
      commitSettings(next)
      setCareStatus('已保存')
    } catch (error) {
      setCareFrequency(previous)
      setCareStatus(friendlyOperationError(error, '设置没有保存，请稍后再试。'))
    }
  }

  async function updateCareDetectFullscreen(value: boolean) {
    const previous = careDetectFullscreen
    setCareDetectFullscreen(value)
    try {
      commitSettings(await echo.settings.update('carePings.detectFullscreen', value))
      setCareStatus('已保存')
    } catch (error) {
      setCareDetectFullscreen(previous)
      setCareStatus(friendlyOperationError(error, '设置没有保存，请稍后再试。'))
    }
  }

  async function updateCareQuietEnabled(value: boolean) {
    const previous = careQuietEnabled
    setCareQuietEnabled(value)
    try {
      commitSettings(await echo.settings.update('carePings.quietHours.enabled', value))
      setCareStatus('已保存')
    } catch (error) {
      setCareQuietEnabled(previous)
      setCareStatus(friendlyOperationError(error, '设置没有保存，请稍后再试。'))
    }
  }

  async function saveCareQuietTime(path: 'carePings.quietHours.start' | 'carePings.quietHours.end', value: string) {
    const previousStart = settings?.carePings.quietHours.start ?? careQuietStart
    const previousEnd = settings?.carePings.quietHours.end ?? careQuietEnd
    try {
      commitSettings(await echo.settings.update(path, value))
      setCareStatus('已保存')
    } catch (error) {
      setCareQuietStart(previousStart)
      setCareQuietEnd(previousEnd)
      setCareStatus(friendlyOperationError(error, '安静时段没有保存，请检查时间。'))
    }
  }

  async function updateCarePause(mode: 'today' | 'week' | 'resume') {
    try {
      const result = await echo.carePings.pause(mode)
      commitSettings(result.settings)
      setCareStatus(result.message)
      await refreshAgentContext()
    } catch (error) {
      setCareStatus(friendlyOperationError(error, '暂停设置没有保存，请稍后再试。'))
    }
  }

  async function startNeteaseLogin() {
    setNeteaseBusy(true)
    setNeteaseQrStatus('正在生成二维码...')
    setNeteaseLoginStatus('')
    setNeteaseLoginStatusState('idle')
    try {
      const qr = await echo.netease.createQrLogin()
      setNeteaseQr(qr)
      setNeteaseQrStatus(qr.message)
    } catch (error) {
      setNeteaseQr(null)
      setNeteaseQrStatus(friendlyOperationError(error, '二维码没有生成，请稍后再试。'))
    } finally {
      setNeteaseBusy(false)
    }
  }

  async function sendNeteaseCaptcha() {
    setNeteaseBusy(true)
    setNeteasePlaylistStatus('')
    setNeteaseLoginStatus('正在发送验证码...')
    setNeteaseLoginStatusState('working')
    try {
      const result = await echo.netease.sendCaptcha(neteasePhone)
      setNeteaseLoginStatus(result.message)
      setNeteaseLoginStatusState(result.ok ? 'ok' : 'err')
      if (result.ok) setNeteaseCaptchaCooldown(60)
    } catch (error) {
      setNeteaseLoginStatus(friendlyOperationError(error, '验证码没有发出去，请稍后再试。'))
      setNeteaseLoginStatusState('err')
    } finally {
      setNeteaseBusy(false)
    }
  }

  async function loginNeteaseWithCaptcha() {
    setNeteaseBusy(true)
    setNeteaseLoginStatus('正在登录网易云...')
    setNeteaseLoginStatusState('working')
    try {
      const state = await echo.netease.loginWithCaptcha(neteasePhone, neteaseCaptcha)
      setNeteaseState(state)
      if (state.loggedIn) {
        setNeteaseQr(null)
        setNeteaseQrStatus('')
        setNeteaseCaptcha('')
        setNeteaseLoginStatusState('ok')
        await refreshNeteasePlaylistsAfterLogin(state.message)
      } else {
        setNeteaseLoginStatusState('err')
      }
      setNeteaseLoginStatus(state.message)
      setHealth(await echo.health.get().catch(() => health))
    } catch (error) {
      setNeteaseLoginStatus(friendlyOperationError(error, '验证码登录失败，请稍后再试。'))
      setNeteaseLoginStatusState('err')
    } finally {
      setNeteaseBusy(false)
    }
  }

  async function importNeteaseCookie() {
    setNeteaseBusy(true)
    setNeteaseLoginStatus('正在验证 Cookie...')
    setNeteaseLoginStatusState('working')
    try {
      const state = await echo.netease.importCookie(neteaseCookieInput)
      setNeteaseState(state)
      if (state.loggedIn) {
        setNeteaseQr(null)
        setNeteaseQrStatus('')
        setNeteaseCookieInput('')
        setNeteaseLoginStatusState('ok')
        await refreshNeteasePlaylistsAfterLogin(state.message)
      } else {
        setNeteaseLoginStatusState('err')
      }
      setNeteaseLoginStatus(state.message)
      setHealth(await echo.health.get().catch(() => health))
    } catch (error) {
      setNeteaseLoginStatus(friendlyOperationError(error, 'Cookie 登录失败，请检查 MUSIC_U。'))
      setNeteaseLoginStatusState('err')
    } finally {
      setNeteaseBusy(false)
    }
  }

  async function refreshNeteaseStatus() {
    setNeteaseBusy(true)
    try {
      setNeteaseState(await echo.netease.getLoginState())
      setHealth(await echo.health.get())
    } catch (error) {
      setNeteaseState({ loggedIn: false, message: friendlyOperationError(error, '网易云状态检查失败。') })
    } finally {
      setNeteaseBusy(false)
    }
  }

  async function logoutNetease() {
    setNeteaseBusy(true)
    try {
      setNeteaseState(await echo.netease.logout())
      setHealth(await echo.health.get())
      patchSettingsPageState({
        neteaseQr: null,
        neteaseQrStatus: '',
        neteaseLoginStatus: '',
        neteaseLoginStatusState: 'idle',
        neteasePlaylists: [],
        neteasePlaylistStatus: '',
      })
    } catch (error) {
      setNeteasePlaylistStatus(friendlyOperationError(error, '退出登录失败，请稍后再试。'))
    } finally {
      setNeteaseBusy(false)
    }
  }

  async function loadNeteasePlaylists() {
    setNeteaseBusy(true)
    setNeteasePlaylistStatus('正在读取网易云歌单...')
    try {
      const playlists = await echo.netease.listPlaylists()
      setNeteasePlaylists(playlists)
      setNeteasePlaylistStatus(playlists.length > 0 ? `读到 ${playlists.length} 个歌单` : '没有读到歌单')
      if (playlists.length > 0) {
        openNeteaseDrawer()
      }
    } catch (error) {
      setNeteasePlaylistStatus(friendlyOperationError(error, '歌单暂时没有读出来。'))
    } finally {
      setNeteaseBusy(false)
    }
  }

  async function cancelRuntimeTask(id: string) {
    await echo.runtime.cancelTask(id).catch(() => ({ ok: false }))
  }

  async function checkAllHealth() {
    setHealthChecking(true)
    try {
      setHealth(await echo.health.check())
    } finally {
      setHealthChecking(false)
    }
  }

  async function importNeteasePlaylist(id: string) {
    setImportingNeteaseId(id)
    setNeteasePlaylistStatus('正在导入网易云歌单，并重新生成画像...')
    try {
      const result = await echo.netease.importPlaylist(id)
      const summary = result.imported ? await refreshSemanticSummary() : semanticSummary
      setNeteasePlaylistStatus(formatImportResultStatus(result, summary))
    } catch (error) {
      setNeteasePlaylistStatus(friendlyOperationError(error, '这次导入没有完成，请稍后再试。'))
    } finally {
      setImportingNeteaseId('')
    }
  }

  if (!settings) {
    return (
      <div className="phone-surface settings-page settings-page-fallback">
        <EmptyState
          title="设置读取失败"
          body="本地配置读取超时或数据库正忙。"
          action={<button className="primary-button" type="button" onClick={() => { void reloadSettings() }}>重新读取设置</button>}
        />
      </div>
    )
  }

  const storageHealth = health.find((item) => item.service === 'storage')
  const storageDegraded = storageHealth && storageHealth.status !== 'ok' && storageHealth.status !== 'unknown'
  const storageCannotSave = storageHealth?.status === 'error'
    && /未启用加密存储|加密存储检查失败|无法保存|safeStorage unavailable/i.test(`${storageHealth.message} ${storageHealth.technical ?? ''}`)
  const apiKeySaved = settings.llm.apiKey === apiKey.trim()
  const modelSaved = settings.llm.baseUrl === baseUrl.trim() && settings.llm.model === model.trim() && apiKeySaved
  const modelReady = Boolean(baseUrl.trim() && apiKey.trim() && model.trim())
  const settingsSaved =
    modelSaved &&
    settings.yinyi.generateAt === generateAt &&
    settings.yinyi.openWithRandom === openWithRandom &&
    settings.chat.restoreOnStart === restoreOnStart &&
    settings.user.city === city.trim() &&
    settings.tts.baseUrl === (ttsBaseUrl.trim() || defaultTtsBaseUrl) &&
    settings.tts.voice === ttsVoice &&
    settings.tts.speed === ttsSpeed &&
    settings.carePings.enabled === careEnabled &&
    settings.carePings.frequency === careFrequency &&
    settings.carePings.detectFullscreen === careDetectFullscreen &&
    settings.carePings.quietHours.enabled === careQuietEnabled &&
    settings.carePings.quietHours.start === careQuietStart &&
    settings.carePings.quietHours.end === careQuietEnd
  const modelStatusText = testState === 'testing'
    ? '正在测试连接...'
    : modelStatus
      ? modelStatus
      : modelSaved && modelReady
        ? '已保存'
        : ''
  const modelStatusState = testState === 'fail'
    ? 'err'
    : testState === 'testing'
      ? 'idle'
      : modelStatusText === '已保存' || testState === 'ok'
        ? 'ok'
        : 'idle'
  const profileRefreshTask = latestRunningRuntimeTask(runtimeTasks, ['taste-refresh'], { includeChildren: false })
  const carePingTask = latestRunningRuntimeTask(runtimeTasks, ['care-ping'], { includeChildren: false })
  const schedulerCatchupTask = latestRunningRuntimeTask(runtimeTasks, ['scheduler-catchup'], { includeChildren: false })
  const semanticAnalysisTask = latestRunningRuntimeTask(runtimeTasks, ['semantic-analysis'], { includeChildren: false })
  const profileRefreshRunning = Boolean(profileRefreshTask)
  const carePingRunning = Boolean(carePingTask)
  const schedulerCatchupRunning = Boolean(schedulerCatchupTask)
  const anyRuntimeTaskRunning = runtimeTasks.some((task) => task.status === 'running')
  const visibleRuntimeTasks = runtimeTasks.filter(runtimeTaskNeedsAttention)
  const visibleHealth = health.filter(shouldShowServiceHealth)
  const activeImportTask = importTask?.status === 'running'
  const importProgress: ImportProgressPayload | null = activeImportTask && importTask && (importTask.phase === 'semantics' || importTask.phase === 'profile' || importTask.phase === 'done')
    ? {
      phase: importTask.phase,
      current: importTask.current,
      total: importTask.total,
      startedAt: importTask.startedAt,
    }
    : null
  const semanticProgress: ImportProgressPayload | null = semanticAnalysisTask
    ? {
      phase: 'semantics',
      current: semanticAnalysisTask.current,
      total: semanticAnalysisTask.total,
      startedAt: semanticAnalysisTask.startedAt,
    }
    : null
  const visibleImportProgress = importProgress ?? semanticProgress
  const globalImportStatus = activeImportTask
    ? importTask.sourceName ? `正在处理 ${importTask.sourceName}` : '导入任务正在进行'
    : semanticAnalysisTask
      ? '正在补齐歌曲语义'
      : ''
  const neteaseCaptchaSent = neteaseCaptchaCooldown > 0 || (neteaseLoginStatusState === 'ok' && /验证码|发送/.test(neteaseLoginStatus))
  const carePausedUntil = settings.carePings.pausedUntil && Date.parse(settings.carePings.pausedUntil) > Date.now()
    ? new Date(settings.carePings.pausedUntil)
    : null
  const railActive = (key: string) => `d2-rail-item${settingsView === 'details' && detailTarget === key ? ' on' : ''}`
  return (
    <div className="phone-surface settings-page">
      <aside className="d2-settings-rail" aria-label="设置分区">
        <div className="d2-rail-group">
          <small>连 接 与 来 源</small>
          <button type="button" data-testid="settings-rail-music" className={railActive('music')} onClick={() => openDetails('sync', 'music')}>音乐来源</button>
          <button type="button" data-testid="settings-rail-llm" className={railActive('llm')} onClick={() => openDetails('sys', 'llm')}>AI 模型</button>
          <button type="button" data-testid="settings-rail-voice" className={railActive('voice')} onClick={() => openDetails('pref', 'voice')}>天气与语音</button>
        </div>
        <div className="d2-rail-group">
          <small>相 处 方 式</small>
          <button type="button" data-testid="settings-rail-yinyi" className={railActive('yinyi')} onClick={() => openDetails('pref', 'yinyi')}>风信生成</button>
          <button type="button" data-testid="settings-rail-chat" className={railActive('chat')} onClick={() => openDetails('pref', 'chat')}>絮语与启动</button>
          <button type="button" data-testid="settings-rail-stage" className={railActive('stage')} onClick={() => openDetails('pref', 'stage')}>此刻的理解</button>
          <button type="button" data-testid="settings-rail-learned" className={railActive('learned')} onClick={() => { void refreshLearnedCases(); openDetails('pref', 'learned') }}>
            Echo 学到了什么{learnedCases.length > 0 ? <span className="d2-rail-cnt">{learnedCases.filter((item) => item.status === 'active').length}</span> : null}
          </button>
          <button type="button" data-testid="settings-rail-care" className={railActive('care')} onClick={() => openDetails('pref', 'care')}>主动关心</button>
        </div>
        <div className="d2-rail-group">
          <small>系 统</small>
          <button type="button" data-testid="settings-rail-tasks" className={railActive('tasks')} onClick={() => openDetails('sys', 'tasks')}>运行任务</button>
          <button type="button" data-testid="settings-rail-window" className={railActive('window')} onClick={() => openDetails('sys', 'window')}>窗口与关闭</button>
          <button type="button" data-testid="settings-rail-data" className={railActive('data')} onClick={() => openDetails('sys', 'data')}>本地数据</button>
          <button type="button" data-testid="settings-rail-about" className="d2-rail-item" onClick={() => navigate('about')}>关于 Echo</button>
        </div>
        <button type="button" className="d2-rail-restart" onClick={onRestartOnboarding}>重新查看引导</button>
        <button type="button" className="d2-rail-restart" onClick={() => { void openFeedback() }} title="打开反馈渠道">反馈与建议</button>
      </aside>
      <div className="d2-settings-main">
      {detailTarget === 'tasks' ? (
      <div className="d2-settings-subview" data-testid="settings-tasks-view">
                <header className="sec-head">
                  <div className="sec-kicker">系 统</div>
                  <h1 className="sec-title">运行任务</h1>
                  <p className="sec-desc">任务在后台继续，不需要守着。</p>
                </header>
                <section className="d2-settings-linear-section">
                  <h3>运行任务</h3>
                  {visibleRuntimeTasks.length > 0
                    ? <RuntimeTaskList tasks={visibleRuntimeTasks} onCancel={(id) => { void cancelRuntimeTask(id) }} />
                    : <p className="d2-settings-empty-line">现在没有正在运行的任务</p>}
                </section>
                <section className="d2-settings-linear-section">
                  <header><h3>服务状态</h3><button type="button" onClick={checkAllHealth} disabled={healthChecking || anyRuntimeTaskRunning}>{healthChecking ? '检查中' : '检查全部'}</button></header>
                  <div className="d2-service-lines">
                    {visibleHealth.map((item) => (
                      <div className="d2-service-line" key={item.service}>
                        <span><strong>{serviceHealthLabel(item.service)}</strong><small>{item.message}</small></span>
                        <em className={item.status === 'ok' ? 'is-ok' : /还没检查|尚未检查/.test(item.message) ? 'is-muted' : 'is-warn'}>{item.status === 'ok' ? '正常' : /还没检查|尚未检查/.test(item.message) ? '尚未检查' : '需处理'}</em>
                      </div>
                    ))}
                  </div>
                </section>
                <button className="d2-settings-danger-link" type="button" onClick={() => openDetails('sys', 'data')}>管理本地数据</button>
              </div>
      ) : (
        <>
      <div className="scroll-panel">
        <header className="sec-head">
          <div className="sec-kicker">{SECTION_META[detailTarget].group}</div>
          <h1 className="sec-title">{SECTION_META[detailTarget].title}</h1>
          <p className="sec-desc">{SECTION_META[detailTarget].desc}</p>
        </header>
        {/* Pinned Progress HUD */}
        {(globalImportStatus || visibleImportProgress) && (
          <div className="import-progress-hud" aria-live="polite">
            <div className="hud-meta">
              <div className="hud-title">
                <span className="hud-pulse" />
                {activeImportTask ? '正在导入你的歌单...' : semanticAnalysisTask ? '正在整理歌曲语义...' : '歌单导入任务'}
              </div>
              {visibleImportProgress && (
                <div className="hud-percent">
                  {importProgressPercent(visibleImportProgress)}%
                </div>
              )}
            </div>
            {visibleImportProgress && (
              <div className="hud-bar-bg">
                <div className="hud-bar-fill" style={{ width: `${importProgressPercent(visibleImportProgress)}%` }} />
              </div>
            )}
            <div className="hud-status-text">
              {visibleImportProgress ? importProgressLine(visibleImportProgress) : globalImportStatus}
            </div>
            {globalImportStatus && visibleImportProgress && (
              <div className="hud-status-text" style={{ opacity: 0.7, fontSize: '10px' }}>
                {globalImportStatus}
              </div>
            )}
          </div>
        )}

        <form className={`d2-settings-form detail-${detailTarget}`} onSubmit={(event) => { void save(event) }}>
          {/* TAB 1: SYNC */}
          {activeTab === 'sync' && (
            <div ref={importSectionRef} className="import-focus-anchor">
              <Section label="让 Echo 认识你的音乐" className="settings-detail-section target-music">
                <p className="import-intro">登录网易云后才能播放歌曲；导入歌单后 Echo 才懂你的口味。</p>
                <div className={`semantic-summary ${semanticSummaryStatus ? 'warn' : ''}`}>
                  <span className="status-dot" />
                  {semanticSummaryStatus || formatSemanticSummary(semanticSummary)}
                </div>

                <div className="import-method">
                  <div className="import-method-title">网易云音乐</div>
                  <div className="import-method-desc">登录后才能播放歌曲。登录后也可以直接导入网易云歌单。</div>
                  <div className="import-method-actions">
                    {neteaseState.loggedIn ? (
                      <>
                        <button className="btn" type="button" onClick={loadNeteasePlaylists} disabled={neteaseBusy} ref={neteasePlaylistButtonRef}>读取歌单</button>
                        <button className="btn danger" type="button" onClick={logoutNetease} disabled={neteaseBusy || activeImportTask}>退出</button>
                      </>
                    ) : (
                      <button className="btn" type="button" onClick={startNeteaseLogin} disabled={neteaseBusy}>
                        {neteaseBusy ? '生成中...' : '扫码登录'}
                      </button>
                    )}
                    <button className="btn sec" type="button" onClick={refreshNeteaseStatus} disabled={neteaseBusy}>刷新状态</button>
                  </div>
                  <div className="import-method-status">
                    <span className={`status-ind inline ${neteaseState.loggedIn ? 'ok' : 'idle'}`}>
                      <span className="status-dot" />
                      {neteaseState.loggedIn ? neteaseState.nickname ?? '已登录' : neteaseState.message}
                    </span>
                  </div>
                  {neteaseQr && (
                    <div className="netease-qr">
                      <img src={neteaseQr.qrImage} alt="网易云扫码登录二维码" />
                      <div>
                        <div className="field-label">用网易云音乐 App 扫码</div>
                        <div className="field-hint">扫码后在手机上确认，这里会自动更新登录状态。</div>
                        <div className={`status-ind ${qrStatusClass(neteaseQrStatus)}`}>
                          <span className="status-dot" />
                          {neteaseQrStatus}
                        </div>
                      </div>
                    </div>
                  )}
                  {!neteaseQr && neteaseQrStatus && (
                    <div className={`status-ind ${qrStatusClass(neteaseQrStatus)}`}>
                      <span className="status-dot" />
                      {neteaseQrStatus}
                    </div>
                  )}
                  {!neteaseState.loggedIn && (
                    <div style={{ display: 'grid', gap: '12px', marginTop: '14px' }}>
                      <div className="field">
                        <div className="field-label">短信验证码登录</div>
                        <div className="field-hint">扫码被风控时用这个入口。验证码来自网易云官方短信。</div>
                        <div className="netease-phone-field">
                          <input
                            className="input"
                            value={neteasePhone}
                            onChange={(event) => { setNeteasePhone(event.target.value); setNeteaseCaptchaCooldown(0) }}
                            placeholder="手机号"
                            inputMode="tel"
                          />
                          <button className="netease-code-btn" type="button" onClick={sendNeteaseCaptcha} disabled={neteaseBusy || !neteasePhone.trim() || neteaseCaptchaCooldown > 0}>
                            {neteaseCaptchaSent ? '已发送' : neteaseLoginStatusState === 'working' ? '发送中' : '发验证码'}
                          </button>
                        </div>
                        <div className="settings-row">
                          <input
                            className="input"
                            value={neteaseCaptcha}
                            onChange={(event) => setNeteaseCaptcha(event.target.value)}
                            placeholder="验证码"
                            inputMode="numeric"
                          />
                          <button className="btn" type="button" onClick={loginNeteaseWithCaptcha} disabled={neteaseBusy || !neteasePhone.trim() || !neteaseCaptcha.trim()}>
                            登录
                          </button>
                        </div>
                        {neteaseLoginStatus && (
                          <div className={`status-ind ${asyncStatusClass(neteaseLoginStatusState)}`}>
                            <span className="status-dot" />
                            {neteaseLoginStatus}
                          </div>
                        )}
                      </div>
                      <div className="field">
                        <div className="field-label">Cookie 兜底</div>
                        <div className="field-hint">填完整 Cookie，或只填 MUSIC_U 的值。Echo 会加密保存在本地。</div>
                        <textarea
                          className="input"
                          value={neteaseCookieInput}
                          onChange={(event) => setNeteaseCookieInput(event.target.value)}
                          placeholder="MUSIC_U=..."
                          rows={3}
                          style={{ resize: 'vertical' }}
                        />
                        <div className="settings-row">
                          <button className="btn sec" type="button" onClick={importNeteaseCookie} disabled={neteaseBusy || !neteaseCookieInput.trim()}>
                            使用 Cookie 登录
                          </button>
                        </div>
                      </div>
                    </div>
                  )}
                  {neteaseState.loggedIn && neteasePlaylists.length > 0 && (
                    <div style={{ marginTop: '14px' }}>
                      <button
                        className="btn sec"
                        type="button"
                        onClick={(event) => openNeteaseDrawer(event.currentTarget)}
                        style={{ width: '100%', justifyContent: 'center' }}
                      >
                        选择要导入的歌单 ({neteasePlaylists.length})
                      </button>
                    </div>
                  )}
                  {neteasePlaylistStatus && (
                    <div className={`status-ind ${playlistStatusClass(neteasePlaylistStatus)}`} style={{ marginTop: '10px' }}>
                      <span className="status-dot" />
                      {neteasePlaylistStatus}
                    </div>
                  )}
                </div>

                <div className="import-divider"><span>或者</span></div>

                <div className="import-method">
                  <div className="import-method-title">从文件导入</div>
                  <div className="import-method-desc">适合其他音乐平台或手工整理的通用歌单 JSON。</div>
                  <div className="import-method-actions">
                    <button className="btn sec" type="button" onClick={downloadTemplate} disabled={templateState === 'working'}>
                      <Download size={15} />
                      {templateState === 'working' ? '保存中...' : '下载模板'}
                    </button>
                    <button className="btn sec" type="button" onClick={importPlaylist} disabled={busy || activeImportTask}>
                      <Upload size={15} />
                      {activeImportTask || importState === 'importing' ? '导入中...' : '选择文件'}
                    </button>
                  </div>
                  {templateStatus && (
                    <div className={`status-ind ${templateState === 'ok' ? 'ok' : templateState === 'fail' ? 'err' : 'idle'}`}>
                      <span className="status-dot" />
                      {templateStatus}
                    </div>
                  )}
                  {importStatus && (
                    <div className={`status-ind ${importState === 'ok' ? 'ok' : importState === 'fail' ? 'err' : 'idle'}`}>
                      <span className="status-dot" />
                      {importStatus}
                    </div>
                  )}
                  {importBoundary && <BoundaryState compact snapshot={importBoundary} onAction={() => { void importPlaylist() }} />}
                </div>

                <div className="data-line">
                  <div>
                    重新认识你
                    <small>基于已导入歌单重新初始化画像。</small>
                  </div>
                  <button className="btn warn" type="button" onClick={regenerateProfile} disabled={busy || activeImportTask || profileRefreshRunning || schedulerCatchupRunning}>
                    {profileRefreshRunning || profileState === 'importing' ? '生成中...' : '重新生成'}
                  </button>
                </div>
                {profileStatus && (
                  <div className={`status-ind ${profileState === 'ok' ? 'ok' : profileState === 'fail' ? 'err' : 'idle'}`}>
                    <span className="status-dot" />
                    {profileStatus}
                  </div>
                )}
              </Section>
            </div>
          )}

          {/* TAB 2: PREFERENCE */}
          {activeTab === 'pref' && (
            <>
              <Section label="风 信" className="settings-detail-section target-yinyi">
                <label className="field">
                  <div>
                    <div className="field-label">每天什么时候写{pageLabels.yinyi}</div>
                    <div className="field-hint">Echo 在这个时间点回顾今天的你。</div>
                  </div>
                  <input className="time-input" type="time" value={generateAt} onChange={(event) => updateYinyiGenerateAt(event.target.value)} />
                </label>

                <label className="toggle-row">
                  <div className="toggle-text">
                    <div className="t1">打开{pageLabels.yinyi}时随机翻一篇过去</div>
                    <div className="t2">像偶然翻到旧日记本的某一页。</div>
                  </div>
                  <input type="checkbox" checked={openWithRandom} onChange={(event) => updateYinyiOpenWithRandom(event.target.checked)} />
                </label>
                {yinyiStatus && (
                  <div className={`status-ind ${yinyiStatus === '已保存' ? 'ok' : 'err'}`}>
                    <span className="status-dot" />
                    {yinyiStatus}
                  </div>
                )}
              </Section>

              <Section label="絮 语 与 品 味" className="settings-detail-section target-chat">
                <label className="toggle-row">
                  <div className="toggle-text">
                    <div className="t1">启动时恢复上次{pageLabels.chat}</div>
                    <div className="t2">影响下次真正启动；最小化到托盘会保留当前界面。</div>
                  </div>
                  <input type="checkbox" checked={restoreOnStart} onChange={(event) => updateRestoreOnStart(event.target.checked)} />
                </label>
                {chatStatus && (
                  <div className={`status-ind ${chatStatus === '已保存' ? 'ok' : 'err'}`}>
                    <span className="status-dot" />
                    {chatStatus}
                  </div>
                )}
              </Section>

              <Section label="E C H O 此 刻 的 理 解" className="settings-detail-section target-stage">
                {stageContext ? (
                  <>
                    <div className="data-line">
                      <div>
                        {stageContext.summary}
                        <small>{stageKindLabels[stageContext.kind]} · {stageGoalLabels[stageContext.goal]} · 第 {stageContext.revision} 次更新</small>
                      </div>
                    </div>
                    <div className="settings-row">
                      <button className="btn sec" type="button" onClick={() => { void endCurrentStageContext() }}>已经结束</button>
                      <button className="btn danger" type="button" onClick={() => { void deleteCurrentStageContext() }}>这条不对</button>
                    </div>
                  </>
                ) : (
                  <EmptyState title="现在没有持续中的阶段" body="此刻轻轻松松的，也很好。" />
                )}
                {stageContextStatus && (
                  <div className="status-ind ok"><span className="status-dot" />{stageContextStatus}</div>
                )}
                {recentAgentActions.length > 0 && (
                  <div className="service-health-list">
                    {recentAgentActions.slice(0, 5).map((action) => (
                      <div className={`service-health-item ${action.status === 'failed' ? 'error' : 'ok'}`} key={action.id}>
                        <div className="service-health-main">
                          <span className="service-health-dot" />
                          <div>
                            <div className="service-health-title">{actionOriginLabels[action.origin]} · {actionTypeLabels[action.actionType]}</div>
                            <div className="service-health-message">{action.status === 'failed' ? '没有完成' : action.status === 'canceled' ? '已经取消' : action.outcomes[0] ? actionOutcomeLabels[action.outcomes[0].type] : '已经完成'}</div>
                          </div>
                        </div>
                        <time className="service-health-time">{new Date(action.plannedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time>
                      </div>
                    ))}
                  </div>
                )}
              </Section>

              <Section label="E C H O 学 到 了 什 么" className="settings-detail-section target-learned" data-testid="settings-learned">
                <div className="d2-settings-rows">
                  <div className="d2-settings-row">
                    <div className="d2-settings-row-main">
                      <span><strong>夜间复盘</strong></span>
                    </div>
                    <label className="switch"><input type="checkbox" checked={settings?.dream.enabled ?? true} onChange={(event) => { void updateDreamSetting('dream.enabled', event.target.checked) }} /><span /></label>
                  </div>
                  <div className="d2-settings-row">
                    <span><strong>复盘时间</strong></span>
                    <input
                      className="input d2-learned-time"
                      value={dreamTimeDraft || settings?.dream.reviewAt || '23:30'}
                      onChange={(event) => setDreamTimeDraft(event.target.value)}
                      onBlur={(event) => { const value = event.target.value.trim(); if (/^\d{1,2}:\d{2}$/.test(value)) void updateDreamSetting('dream.reviewAt', value) }}
                      placeholder="23:30"
                    />
                  </div>
                </div>
                {learnedStatus && <div className="status-ind ok"><span className="status-dot" />{learnedStatus}</div>}
                {learnedCases.length > 0 ? (
                  <div className="d2-learned-list">
                    {learnedCases.map((item) => (
                      <div className={`d2-learned-item ${item.status}`} key={item.id}>
                        <div className="d2-learned-main">
                          <span className="d2-learned-kind">{learnedKindLabels[item.kind]}</span>
                          <div>
                            <div className="d2-learned-trigger">「{item.triggerText}」</div>
                            <div className="d2-learned-summary">{summarizeLearnedCase(item)}</div>
                            <small>{learnedStatusLabels[item.status]}{item.corroborations > 0 ? ` · 被印证 ${item.corroborations} 次` : ''} · {item.sourceDate}</small>
                          </div>
                        </div>
                        <button className="btn danger d2-learned-delete" type="button" onClick={() => { void deleteLearnedCase(item.id) }}>删除</button>
                      </div>
                    ))}
                  </div>
                ) : (
                  <EmptyState title="今天还没学到新东西" body="你纠正我的时候，我会记住。夜里我会自己复盘一遍。" />
                )}
              </Section>

              <Section label="回 声 · v 0 . 3" className="settings-detail-section target-voice">
                <label className="field">
                  <div className="field-label">所在城市</div>
                  <div className="field-hint">用于天气开场。留空时 Echo 会跳过天气。</div>
                  <input
                    className="input"
                    value={city}
                    onChange={(event) => setCity(event.target.value)}
                    onBlur={(event) => { void saveVoiceSettings({ city: event.target.value }) }}
                    placeholder="北京 / 上海 / Shenzhen"
                  />
                </label>

                <label className="field">
                  <div className="field-label">TTS 服务</div>
                  <div className="field-hint">支持任何 OpenAI 兼容的 /v1/audio/speech 接口，留空回到默认。</div>
                  <div className="model-presets">
                    <button
                      type="button"
                      className={!ttsEditingCustom && (ttsBaseUrl.trim() || defaultTtsBaseUrl) === defaultTtsBaseUrl ? 'model-tag active' : 'model-tag'}
                      aria-pressed={!ttsEditingCustom && (ttsBaseUrl.trim() || defaultTtsBaseUrl) === defaultTtsBaseUrl}
                      onClick={() => {
                        setTtsEditingCustom(false)
                        setTtsBaseUrl(defaultTtsBaseUrl)
                        void saveVoiceSettings({ ttsBaseUrl: defaultTtsBaseUrl })
                      }}
                    >
                      wangwangit · 默认
                    </button>
                    <button
                      type="button"
                      className={ttsEditingCustom || Boolean(ttsBaseUrl.trim() && ttsBaseUrl.trim() !== defaultTtsBaseUrl) ? 'model-tag active' : 'model-tag'}
                      aria-pressed={ttsEditingCustom || Boolean(ttsBaseUrl.trim() && ttsBaseUrl.trim() !== defaultTtsBaseUrl)}
                      onClick={() => {
                        setTtsEditingCustom(true)
                        if ((ttsBaseUrl.trim() || defaultTtsBaseUrl) === defaultTtsBaseUrl) {
                          setTtsBaseUrl('')
                        }
                        window.setTimeout(() => ttsBaseUrlInputRef.current?.focus(), 0)
                      }}
                    >
                      自定义
                    </button>
                  </div>
                  <input
                    ref={ttsBaseUrlInputRef}
                    className="input"
                    value={ttsBaseUrl}
                    onChange={(event) => {
                      setTtsEditingCustom(true)
                      setTtsBaseUrl(event.target.value)
                    }}
                    onBlur={(event) => {
                      if (!event.target.value.trim()) setTtsEditingCustom(false)
                      void saveVoiceSettings({ ttsBaseUrl: event.target.value })
                    }}
                    placeholder={defaultTtsBaseUrl}
                  />
                  <div className="settings-row">
                    <button className="btn sec" type="button" onClick={testTtsConnection} disabled={busy || ttsTestState === 'testing'}>
                      {ttsTestState === 'testing' ? '测试中...' : '测试 TTS'}
                    </button>
                  </div>
                  {ttsTestStatus && (
                    <div className={`status-ind ${ttsTestState === 'ok' ? 'ok' : ttsTestState === 'fail' ? 'err' : 'idle'}`}>
                      <span className="status-dot" />
                      {ttsTestStatus}
                    </div>
                  )}
                </label>

                <label className="field">
                  <div className="field-label">音色</div>
                  <select
                    className="input"
                    value={ttsVoice}
                    onChange={(event) => {
                      setTtsVoice(event.target.value)
                      void saveVoiceSettings({ ttsVoice: event.target.value })
                    }}
                  >
                    {ttsVoices.map(([value, label]) => (
                      <option value={value} key={value}>{label}</option>
                    ))}
                  </select>
                </label>

                <label className="field">
                  <div className="field-label">语速 · {ttsSpeed.toFixed(1)}x</div>
                  <input
                    className="range-input"
                    type="range"
                    min="0.5"
                    max="1.5"
                    step="0.1"
                    value={ttsSpeed}
                    onChange={(event) => setTtsSpeed(Number(event.target.value))}
                    onBlur={(event) => saveTtsSpeedOnce(Number(event.target.value))}
                    onPointerUp={(event) => saveTtsSpeedOnce(Number(event.currentTarget.value))}
                  />
                </label>
                {voiceSettingsStatus && (
                  <div className={`status-ind ${voiceSettingsStatus === '已保存' ? 'ok' : 'err'}`}>
                    <span className="status-dot" />
                    {voiceSettingsStatus}
                  </div>
                )}
              </Section>

              <Section label="E C H O 的 关 心" className="care-settings-section settings-detail-section target-care">
                <label className="toggle-row">
                  <div className="toggle-text">
                    <div className="t1">主动来找你</div>
                    <div className="t2">Echo 在合适的时候发系统通知问候你或推荐歌。</div>
                  </div>
                  <input type="checkbox" checked={careEnabled} onChange={(event) => updateCareEnabled(event.target.checked)} />
                </label>

                <div className="care-frequency">
                  <div className="field-label">频率</div>
                  <div className="care-frequency-row">
                    {[
                      ['gentle', '克制', '每天最多 1 次'],
                      ['normal', '适中', '每天最多 2 次'],
                      ['frequent', '频繁', '每天最多 3 次'],
                    ].map(([value, label, count]) => (
                      <button
                        className={careFrequency === value ? 'care-frequency-pill active' : 'care-frequency-pill'}
                        type="button"
                        key={value}
                        onClick={() => updateCareFrequency(value as CareFrequency)}
                      >
                        <span>{label}</span>
                        <small>{count}</small>
                      </button>
                    ))}
                  </div>
                </div>

                <label className="toggle-row care-guard-row">
                  <div className="toggle-text">
                    <div className="t1">安静时段</div>
                    <div className="t2">这段时间不发主动通知。</div>
                  </div>
                  <input type="checkbox" checked={careQuietEnabled} onChange={(event) => { void updateCareQuietEnabled(event.target.checked) }} />
                </label>
                <div className="care-time-row" aria-disabled={!careQuietEnabled}>
                  <label>
                    <span>开始</span>
                    <input
                      className="input"
                      type="time"
                      value={careQuietStart}
                      disabled={!careQuietEnabled}
                      onChange={(event) => setCareQuietStart(event.target.value)}
                      onBlur={(event) => { void saveCareQuietTime('carePings.quietHours.start', event.target.value) }}
                    />
                  </label>
                  <span className="care-time-arrow">到</span>
                  <label>
                    <span>结束</span>
                    <input
                      className="input"
                      type="time"
                      value={careQuietEnd}
                      disabled={!careQuietEnabled}
                      onChange={(event) => setCareQuietEnd(event.target.value)}
                      onBlur={(event) => { void saveCareQuietTime('carePings.quietHours.end', event.target.value) }}
                    />
                  </label>
                </div>

                <label className="toggle-row care-guard-row">
                  <div className="toggle-text">
                    <div className="t1">Echo 全屏时不打扰</div>
                    <div className="t2">Echo 窗口进入全屏时保持安静。</div>
                  </div>
                  <input type="checkbox" checked={careDetectFullscreen} onChange={(event) => { void updateCareDetectFullscreen(event.target.checked) }} />
                </label>

                <div className="care-pause-block">
                  <div className="field-label">暂停主动关心</div>
                  <div className="care-pause-row">
                    <button className="btn sec" type="button" onClick={() => { void updateCarePause('today') }}>到明早</button>
                    <button className="btn sec" type="button" onClick={() => { void updateCarePause('week') }}>7 天</button>
                    <button className="btn sec" type="button" disabled={!carePausedUntil} onClick={() => { void updateCarePause('resume') }}>恢复</button>
                  </div>
                  {carePausedUntil && (
                    <div className="field-hint">已暂停至 {carePausedUntil.toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })}</div>
                  )}
                </div>

                {recentCareActions.length > 0 && (
                  <div className="care-recent-decisions">
                    <div className="field-label">最近的主动判断</div>
                    {recentCareActions.map((action) => (
                      <div className="care-decision-line" key={action.id}>
                        <span>{careActionExplanation(action)}</span>
                        <time>{new Date(action.plannedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })}</time>
                      </div>
                    ))}
                  </div>
                )}

                <p className="care-copy">次数是上限。Echo 只在当下合适、线索足够时出现。</p>
                <button className="btn sec care-test-btn" type="button" onClick={testCarePing} disabled={busy || carePingRunning || schedulerCatchupRunning}>
                  {carePingRunning ? '生成中...' : '立刻测试一条'}
                </button>
                {careStatus && (
                  <div className={`status-ind ${careStatus === '已保存' ? 'ok' : careStatus.includes('失败') ? 'err' : 'idle'}`}>
                    <span className="status-dot" />
                    {careStatus}
                  </div>
                )}
              </Section>
            </>
          )}

          {/* TAB 3: SYSTEM */}
          {activeTab === 'sys' && (
            <>
              {!hasLlmConfig && (
                <div className="first-run d2-llm-first-run" style={{ marginBottom: '16px', marginTop: '4px' }}>
                  <div>嗨,我是 Echo。</div>
                  <p>在我们开始之前,你需要给我一个 LLM 端点——这样我才能“说话”。DeepSeek 一个月几块钱,Kimi 也行,任何 OpenAI 兼容的服务都可以。</p>
                </div>
              )}

              <Section label="窗 口" className="settings-detail-section target-window">
                <div className="window-size-options" role="group" aria-label="窗口尺寸">
                  {([
                    ['compact', '小号', '1152 × 720'],
                    ['standard', '标准', '1280 × 800'],
                    ['large', '大号', '1440 × 900'],
                  ] as const).map(([preset, label, dimensions]) => (
                    <button
                      className={(settings?.ui.windowSize ?? 'standard') === preset ? 'window-size-option active' : 'window-size-option'}
                      type="button"
                      key={preset}
                      disabled={windowSizeBusy}
                      onClick={() => { void updateWindowSize(preset) }}
                    >
                      {label}
                      <small>{dimensions}</small>
                    </button>
                  ))}
                </div>
                <p className="window-size-note">窗口始终保持 16:10，不支持拖动边框和最大化。切换后会自动居中。</p>
                <label className="field d2-close-behavior-field">
                  <div className="field-label">点击关闭按钮时</div>
                  <select className="input" aria-label="关闭窗口时" value={settings?.ui.closeBehavior ?? 'ask'} onChange={(event) => { void updateOverviewSetting('ui.closeBehavior', event.target.value as NonNullable<Settings['ui']['closeBehavior']>) }}>
                    <option value="ask">每次询问</option>
                    <option value="minimize">最小化到任务栏</option>
                    <option value="quit">退出 Echo</option>
                  </select>
                </label>
                {windowSizeStatus && (
                  <div className={`status-ind ${windowSizeStatus === '窗口尺寸已保存' ? 'ok' : windowSizeStatus.includes('没有') ? 'err' : 'idle'}`} role="status">
                    <span className="status-dot" />
                    {windowSizeStatus}
                  </div>
                )}
              </Section>

              <div ref={apiSectionRef}>
                <Section label="A I 模 型" className="settings-detail-section target-llm">
                  {storageDegraded && (
                    <div className="status-ind err" role="alert">
                      <span className="status-dot" />
                      {storageHealth?.message ?? '当前系统未启用加密存储，API Key 暂时不能保存。'}
                    </div>
                  )}

                  <label className="field">
                    <div className="field-label">服务商</div>
                    <select className="input" value={provider} onChange={(event) => switchProvider(event.target.value)}>
                      {Object.entries(providerPresets).map(([key, preset]) => (
                        <option value={key} key={key}>{preset.label}</option>
                      ))}
                    </select>
                  </label>

                  {provider !== 'custom' && providerPresets[provider] && (
                    <div className="provider-info">
                      <span className="provider-dot" />
                      端点 {providerPresets[provider].baseUrl} · 只需填 Key 即可
                    </div>
                  )}

                  {provider === 'custom' && (
                    <label className="field">
                      <div className="field-label">API 端点</div>
                      <div className="field-hint">填写完整的 OpenAI 兼容 Base URL。</div>
                      <input className="input" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://api.example.com/v1" />
                    </label>
                  )}

                  <label className="field">
                    <div className="field-label">API Key</div>
                    <div className="field-hint">{storageCannotSave ? '加密存储不可用，已禁止保存以避免明文写入。' : (providerPresets[provider]?.keyHint ?? '本地加密存储。')}</div>
                    <input
                      className="input"
                      type="password"
                      value={apiKey}
                      onChange={(event) => setApiKey(event.target.value)}
                      placeholder="sk-..."
                      disabled={storageCannotSave}
                    />
                  </label>

                  <label className="field">
                    <div className="field-label">模型</div>
                    <input
                      className="input"
                      value={model}
                      onChange={(event) => setModel(event.target.value)}
                      placeholder={providerPresets[provider]?.modelPlaceholder ?? '模型名'}
                    />
                    {provider !== 'custom' && providerPresets[provider]?.docsUrl && (
                      <a href={providerPresets[provider].docsUrl} target="_blank" rel="noopener noreferrer" className="model-docs-link">
                        了解模型名称 ›
                      </a>
                    )}
                  </label>

                  <div className="settings-row">
                    <button className="btn sec" type="button" onClick={testLlm} disabled={busy}>
                      {testState === 'testing' ? '测试中...' : '测试连接'}
                    </button>
                    <button className="btn" type="submit" disabled={busy || settingsSaved}>
                      {settingsSaved ? '已保存' : '保存'}
                    </button>
                  </div>
                  {modelStatusText && (
                    <div className={`status-ind ${modelStatusState}`}>
                      <span className="status-dot" />
                      {modelStatusText}
                    </div>
                  )}
                  {testState === 'fail' && (
                    <p className="status-help">
                      通常是 API Key 错了 / 过期了 / 余额不够。去你的 LLM 平台后台看一下 key,然后回来重填。
                    </p>
                  )}
                </Section>
              </div>

              {visibleRuntimeTasks.length > 0 && (
                <Section label="运行任务" className="settings-detail-section target-tasks">
                  <RuntimeTaskList tasks={visibleRuntimeTasks} onCancel={(id) => { void cancelRuntimeTask(id) }} />
                </Section>
              )}

              <Section label="服务状态" className="health-section settings-detail-section target-tasks">
                <div className="service-health-head">
                  <p>这里显示 Echo 依赖的外部服务状态。异常时先按提示恢复，再重试当前任务。</p>
                  <button className="btn sec" type="button" onClick={checkAllHealth} disabled={healthChecking || anyRuntimeTaskRunning}>
                    {healthChecking ? '检查中...' : '检查全部'}
                  </button>
                </div>
                <div className="service-health-list">
                  {visibleHealth.map((item) => (
                    <div className={`service-health-item ${item.status}`} key={item.service}>
                      <div className="service-health-main">
                        <span className="service-health-dot" />
                        <div>
                          <div className="service-health-title">{serviceHealthLabel(item.service)}</div>
                          <div className="service-health-message">{item.message}</div>
                          {item.status !== 'ok' && (
                            <div className="service-health-message">{serviceRecoveryHint(item.service)}</div>
                          )}
                        </div>
                      </div>
                      <time className="service-health-time">
                        {item.checkedAt ? new Date(item.checkedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' }) : '--:--'}
                      </time>
                    </div>
                  ))}
                </div>
              </Section>

              <Section label="数 据" className="settings-detail-section target-data">
                <div className="data-line danger-line">
                  <div>
                    清空所有数据
                    <small>回到第一次打开 Echo 的状态。</small>
                  </div>
                  <button className="btn danger" type="button" onClick={requestResetData} disabled={busy || anyRuntimeTaskRunning}>清 空</button>
                </div>
                {dataStatus && (
                  <div className={`status-ind ${dataState === 'ok' ? 'ok' : dataState === 'err' ? 'err' : 'idle'}`}>
                    <span className="status-dot" />
                    {dataStatus}
                  </div>
                )}
              </Section>
            </>
          )}
        </form>

      </div>
        </>
      )}

      </div>

      {renderNeteaseDrawer && (
        <>
          <div className={`drawer-overlay ${showNeteaseDrawer ? 'active' : ''}`} onClick={closeNeteaseDrawer} aria-hidden="true" />
          <div
            className={`drawer-sheet ${showNeteaseDrawer ? 'active' : ''}`}
            role="dialog"
            aria-modal="true"
            aria-labelledby="netease-playlist-drawer-title"
            aria-hidden={!showNeteaseDrawer}
            ref={drawerSheetRef}
            onTransitionEnd={(event) => {
              if (event.target === event.currentTarget && !showNeteaseDrawer) finishNeteaseDrawerClose()
            }}
          >
            <div className="drawer-drag-bar" />
            <div className="drawer-header">
              <div className="drawer-title" id="netease-playlist-drawer-title">选择歌单导入 Echo</div>
              <button type="button" className="drawer-close" onClick={closeNeteaseDrawer} ref={drawerCloseButtonRef} aria-label="关闭歌单选择">×</button>
            </div>
            <div className="drawer-body">
              {neteasePlaylists.map((playlist) => (
                <div className="playlist-item" key={playlist.id}>
                  <div className="playlist-info">
                    <div className="playlist-name" title={playlist.name}>{playlist.name}</div>
                    <div className="playlist-count">{playlist.trackCount} 首 · {playlist.creator ?? '网易云'}</div>
                  </div>
                  <button
                    className="playlist-import-btn"
                    type="button"
                    onClick={() => {
                      closeNeteaseDrawer()
                      void importNeteasePlaylist(playlist.id)
                    }}
                    disabled={Boolean(importingNeteaseId) || activeImportTask}
                  >
                    {importingNeteaseId === playlist.id ? '导入中...' : '导入'}
                  </button>
                </div>
              ))}
            </div>
          </div>
        </>
      )}

      {showResetConfirm && (
        <div className="close-dialog-layer settings-reset-layer" role="dialog" aria-modal="true" aria-labelledby="settings-reset-title">
          <div className="close-dialog settings-reset-dialog">
            <div className="close-dialog-kicker">E C H O · R E S E T</div>
            <h2 id="settings-reset-title">要把 Echo 清空吗？</h2>
            <p>这会清掉本地{pageLabels.chat}、{pageLabels.yinyi}、画像、收藏、导入歌单和网易云登录状态。清空后，Echo 会回到第一次打开时的样子。</p>
            <label className="close-dialog-check">
              <input
                type="checkbox"
                checked={resetConfirmChecked}
                onChange={(event) => setResetConfirmChecked(event.target.checked)}
              />
              <span>我知道这会清空本地数据</span>
            </label>
            <div className="close-dialog-actions">
              <button className="d2-dialog-btn close-quit-btn" type="button" onClick={() => setShowResetConfirm(false)} disabled={busy}>
                先不清
              </button>
              <button className="d2-dialog-btn danger settings-reset-confirm" type="button" onClick={resetData} disabled={busy || anyRuntimeTaskRunning || !resetConfirmChecked}>
                {busy ? '清空中' : '清空 Echo'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
