import { FormEvent, useEffect, useRef, useState } from 'react'
import { Upload } from 'lucide-react'
import type { CareFrequency, EchoApi, ImportProgressPayload, NeteaseLoginState, NeteasePlaylistSummary, NeteaseQrLogin, ServiceHealth, Settings, Track } from '../../types/ipc'
import type { AppPageProps } from '../../App'
import { EmptyState, Section } from '../components'

interface SettingsPageProps extends AppPageProps {
  echo: EchoApi
  settings: Settings | null
  setSettings: (settings: Settings) => void
  hasLlmConfig: boolean
  refreshProfile: () => Promise<void>
  refreshQueue: () => Promise<Track[]>
}

const modelPresets = ['deepseek-chat', 'moonshot-v1-32k', 'gpt-4o', 'glm-4-plus', 'qwen-max']
const defaultTtsBaseUrl = 'https://tts.wangwangit.com'
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
  echo,
  settings,
  setSettings,
  hasLlmConfig,
  refreshProfile,
  refreshQueue,
}: SettingsPageProps) {
  const [baseUrl, setBaseUrl] = useState('')
  const [apiKey, setApiKey] = useState('')
  const [model, setModel] = useState('')
  const [generateAt, setGenerateAt] = useState('22:00')
  const [openWithRandom, setOpenWithRandom] = useState(false)
  const [restoreOnStart, setRestoreOnStart] = useState(true)
  const [city, setCity] = useState('')
  const [ttsBaseUrl, setTtsBaseUrl] = useState('')
  const [ttsVoice, setTtsVoice] = useState('zh-CN-XiaochenNeural')
  const [ttsSpeed, setTtsSpeed] = useState(1)
  const [ttsTestStatus, setTtsTestStatus] = useState('')
  const [ttsTestState, setTtsTestState] = useState<'idle' | 'testing' | 'ok' | 'fail'>('idle')
  const [careEnabled, setCareEnabled] = useState(false)
  const [careFrequency, setCareFrequency] = useState<CareFrequency>('normal')
  const [careStatus, setCareStatus] = useState('')
  const [modelStatus, setModelStatus] = useState('')
  const [yinyiStatus, setYinyiStatus] = useState('')
  const [chatStatus, setChatStatus] = useState('')
  const [voiceSettingsStatus, setVoiceSettingsStatus] = useState('')
  const [dataStatus, setDataStatus] = useState('')
  const [dataState, setDataState] = useState<'idle' | 'working' | 'ok' | 'err'>('idle')
  const [testState, setTestState] = useState<'idle' | 'testing' | 'ok' | 'fail'>('idle')
  const [importStatus, setImportStatus] = useState('')
  const [importState, setImportState] = useState<'idle' | 'importing' | 'ok' | 'fail'>('idle')
  const [importProgress, setImportProgress] = useState<ImportProgressPayload | null>(null)
  const [neteaseState, setNeteaseState] = useState<NeteaseLoginState>({ loggedIn: false, message: '正在检查网易云状态...' })
  const [neteaseQr, setNeteaseQr] = useState<NeteaseQrLogin | null>(null)
  const [neteaseQrStatus, setNeteaseQrStatus] = useState('')
  const [neteasePlaylists, setNeteasePlaylists] = useState<NeteasePlaylistSummary[]>([])
  const [neteasePlaylistStatus, setNeteasePlaylistStatus] = useState('')
  const [importingNeteaseId, setImportingNeteaseId] = useState('')
  const [neteaseBusy, setNeteaseBusy] = useState(false)
  const [health, setHealth] = useState<ServiceHealth[]>([])
  const [busy, setBusy] = useState(false)
  const [showResetConfirm, setShowResetConfirm] = useState(false)
  const [resetConfirmChecked, setResetConfirmChecked] = useState(false)
  const skipHydrateRef = useRef(false)

  function commitSettings(next: Settings) {
    skipHydrateRef.current = true
    setSettings(next)
  }

  useEffect(() => {
    if (!settings) return
    if (skipHydrateRef.current) {
      skipHydrateRef.current = false
      return
    }
    setBaseUrl(settings.llm.baseUrl)
    setApiKey(settings.llm.apiKey)
    setModel(settings.llm.model)
    setGenerateAt(settings.yinyi.generateAt)
    setOpenWithRandom(settings.yinyi.openWithRandom)
    setRestoreOnStart(settings.chat.restoreOnStart)
    setCity(settings.user.city)
    setTtsBaseUrl(settings.tts.baseUrl)
    setTtsVoice(settings.tts.voice)
    setTtsSpeed(settings.tts.speed)
    setCareEnabled(settings.carePings.enabled)
    setCareFrequency(settings.carePings.frequency)
  }, [settings])

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
  }, [echo])

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
  }, [echo])

  useEffect(() => {
    return echo.import.onProgress((payload) => {
      setImportProgress(payload)
      if (payload.phase === 'done') {
        // 让最终进度短暂停留一会儿再隐藏，避免视觉上瞬间跳没。
        window.setTimeout(() => setImportProgress((current) => (current && current.phase === 'done' ? null : current)), 1200)
      }
    })
  }, [echo])

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
          window.clearInterval(timer)
        }
        if (result.status === 'expired' || result.status === 'failed') {
          window.clearInterval(timer)
        }
      } catch (error) {
        if (!stopped) setNeteaseQrStatus(error instanceof Error ? error.message : '登录检查失败')
      }
    }, 1800)
    return () => {
      stopped = true
      window.clearInterval(timer)
    }
  }, [echo, neteaseQr])

  async function save(event?: FormEvent): Promise<boolean> {
    event?.preventDefault()
    setBusy(true)
    setTestState('idle')
    try {
      let next = await echo.settings.update('llm.baseUrl', baseUrl.trim())
      next = await echo.settings.update('llm.apiKey', apiKey.trim())
      next = await echo.settings.update('llm.model', model.trim())
      next = await echo.settings.update('yinyi.generateAt', generateAt)
      next = await echo.settings.update('yinyi.openWithRandom', openWithRandom)
      next = await echo.settings.update('chat.restoreOnStart', restoreOnStart)
      next = await echo.settings.update('user.city', city.trim())
      next = await echo.settings.update('tts.baseUrl', ttsBaseUrl.trim() || defaultTtsBaseUrl)
      next = await echo.settings.update('tts.voice', ttsVoice)
      next = await echo.settings.update('tts.speed', ttsSpeed)
      next = await echo.settings.update('carePings.enabled', careEnabled)
      next = await echo.settings.update('carePings.frequency', careFrequency)
      commitSettings(next)
      setModelStatus('已保存')
      setTestState('ok')
      return true
    } catch (error) {
      const message = error instanceof Error ? error.message : '保存失败'
      setModelStatus(message)
      setTestState('fail')
      setHealth(await echo.health.get().catch(() => health))
      return false
    } finally {
      setBusy(false)
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
      setChatStatus(error instanceof Error ? error.message : '保存失败')
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
      setYinyiStatus(error instanceof Error ? error.message : '保存失败')
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
      setYinyiStatus(error instanceof Error ? error.message : '保存失败')
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
    } catch (error) {
      setTestState('fail')
      setModelStatus(error instanceof Error ? error.message : '连接失败')
    } finally {
      setBusy(false)
    }
  }

  async function importPlaylist() {
    setBusy(true)
    setImportState('importing')
    setImportStatus('正在读取 JSON、写入本地数据库，并生成你的初始画像...')
    setImportProgress(null)
    try {
      const result = await echo.settings.importPlaylist()
      setImportState(result.imported ? 'ok' : result.count === 0 && result.message === '导入已取消' ? 'idle' : 'fail')
      setImportStatus(result.imported ? `${result.message ?? `已导入 ${result.count} 首`} · ${result.name ?? '歌单'}` : result.message ?? '导入失败')
      if (result.imported) {
        await Promise.all([refreshProfile(), refreshQueue()])
      }
    } catch (error) {
      setImportState('fail')
      setImportStatus(error instanceof Error ? error.message : '导入失败')
    } finally {
      setBusy(false)
    }
  }

  function importProgressLine(progress: ImportProgressPayload): string {
    if (progress.phase === 'semantics') {
      const total = Math.max(1, Math.ceil(progress.total / 25))
      const current = Math.min(total, Math.ceil(progress.current / 25))
      return `语义标注 ${current}/${total} 批 · 已读 ${progress.current}/${progress.total} 首`
    }
    if (progress.phase === 'profile') return 'Echo 在写画像第一稿...'
    return '导入完成'
  }

  function importProgressPercent(progress: ImportProgressPayload): number {
    if (progress.phase === 'done') return 100
    if (progress.phase === 'profile') return 95
    if (progress.total <= 0) return 0
    return Math.min(90, Math.round((progress.current / progress.total) * 90))
  }

  async function regenerateProfile() {
    setBusy(true)
    setImportState('importing')
    setImportStatus('Echo 正在重新整理你的画像...')
    try {
      await echo.taste.regeneratePortrait()
      await refreshProfile()
      setImportState('ok')
      setImportStatus('画像已重新生成')
    } catch (error) {
      setImportState('fail')
      setImportStatus(error instanceof Error ? error.message : '画像重新生成失败')
    } finally {
      setBusy(false)
    }
  }

  function requestResetData() {
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
      await Promise.all([refreshProfile(), refreshQueue()])
      setNeteaseState(await echo.netease.getLoginState().catch(() => ({ loggedIn: false, message: '网易云状态检查失败' })))
      setNeteaseQr(null)
      setNeteaseQrStatus('')
      setNeteasePlaylists([])
      setNeteasePlaylistStatus('')
      setImportStatus('')
      setImportProgress(null)
      setHealth(await echo.health.get().catch(() => []))
      setDataStatus('数据已清空')
      setDataState('ok')
    } catch (error) {
      setDataStatus(error instanceof Error ? error.message : '清空失败')
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
    try {
      let next = await echo.settings.update('user.city', nextCity.trim())
      next = await echo.settings.update('tts.baseUrl', nextBaseUrl.trim() || defaultTtsBaseUrl)
      next = await echo.settings.update('tts.voice', nextVoice)
      next = await echo.settings.update('tts.speed', Math.max(0.5, Math.min(1.5, nextSpeed)))
      commitSettings(next)
      setVoiceSettingsStatus('已保存')
      return true
    } catch (error) {
      setVoiceSettingsStatus(error instanceof Error ? error.message : '保存失败')
      return false
    }
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
      setTtsTestStatus(error instanceof Error ? error.message : '语音服务测试失败')
    }
  }

  async function testCarePing() {
    setCareStatus('正在发一条测试通知...')
    try {
      const result = await echo.carePings.test()
      setCareStatus(result.message)
    } catch (error) {
      setCareStatus(error instanceof Error ? error.message : '测试通知失败')
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
      setCareStatus(error instanceof Error ? error.message : '保存失败')
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
      setCareStatus(error instanceof Error ? error.message : '保存失败')
    }
  }

  async function startNeteaseLogin() {
    setNeteaseBusy(true)
    setNeteaseQrStatus('正在生成二维码...')
    try {
      const qr = await echo.netease.createQrLogin()
      setNeteaseQr(qr)
      setNeteaseQrStatus(qr.message)
    } catch (error) {
      setNeteaseQr(null)
      setNeteaseQrStatus(error instanceof Error ? error.message : '二维码生成失败')
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
      setNeteaseState({ loggedIn: false, message: error instanceof Error ? error.message : '网易云状态检查失败' })
    } finally {
      setNeteaseBusy(false)
    }
  }

  async function logoutNetease() {
    setNeteaseBusy(true)
    try {
      setNeteaseState(await echo.netease.logout())
      setHealth(await echo.health.get())
      setNeteaseQr(null)
      setNeteaseQrStatus('')
      setNeteasePlaylists([])
      setNeteasePlaylistStatus('')
    } catch (error) {
      setNeteasePlaylistStatus(error instanceof Error ? error.message : '退出失败')
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
    } catch (error) {
      setNeteasePlaylistStatus(error instanceof Error ? error.message : '读取歌单失败')
    } finally {
      setNeteaseBusy(false)
    }
  }

  async function importNeteasePlaylist(id: string) {
    setImportingNeteaseId(id)
    setImportProgress(null)
    setNeteasePlaylistStatus('正在导入网易云歌单，并重新生成画像...')
    try {
      const result = await echo.netease.importPlaylist(id)
      setNeteasePlaylistStatus(result.imported ? `${result.message} · ${result.name ?? '歌单'}` : result.message ?? '导入失败')
      if (result.imported) {
        await Promise.all([refreshProfile(), refreshQueue()])
      }
    } catch (error) {
      setNeteasePlaylistStatus(error instanceof Error ? error.message : '导入失败')
    } finally {
      setImportingNeteaseId('')
    }
  }

  if (!settings) {
    return (
      <div className="phone-surface settings-page">
        <EmptyState title="正在读取设置" body="Echo 在打开本地配置。" />
      </div>
    )
  }

  const storageHealth = health.find((item) => item.service === 'storage')
  const storageDegraded = storageHealth && storageHealth.status !== 'ok' && storageHealth.status !== 'unknown'
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
    settings.carePings.frequency === careFrequency
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

  return (
    <div className="phone-surface settings-page">
      <div className="scroll-panel">
        {!hasLlmConfig && (
          <div className="first-run">
            <div>嗨,我是 Echo。</div>
            <p>在我们开始之前,你需要给我一个 LLM 端点——这样我才能“说话”。DeepSeek 一个月几块钱,Kimi 也行,任何 OpenAI 兼容的服务都可以。</p>
          </div>
        )}

        <form onSubmit={(event) => { void save(event) }}>
          <Section label="A I 模 型">
            {storageDegraded && (
              <div className="status-ind err" role="alert">
                <span className="status-dot" />
                {storageHealth?.message ?? '当前系统未启用加密存储，API Key 暂时不能保存。'}
              </div>
            )}

            <label className="field">
              <div className="field-label">API 端点</div>
              <div className="field-hint">支持任何 OpenAI 兼容服务。</div>
              <input className="input" value={baseUrl} onChange={(event) => setBaseUrl(event.target.value)} placeholder="https://api.example.com/v1" />
            </label>

            <label className="field">
              <div className="field-label">API Key</div>
              <div className="field-hint">{storageDegraded ? '加密存储不可用，已禁止保存以避免明文写入。' : '本地加密存储。'}</div>
              <input
                className="input"
                type="password"
                value={apiKey}
                onChange={(event) => setApiKey(event.target.value)}
                placeholder="sk-..."
                disabled={storageDegraded}
              />
            </label>

            <label className="field">
              <div className="field-label">模型</div>
              <div className="field-hint">点击下方常用预设，或在输入框里自由填写模型名。</div>
              <div className="model-presets">
                {modelPresets.map((item) => (
                  <button type="button" className={model === item ? 'model-tag active' : 'model-tag'} key={item} onClick={() => setModel(item)}>
                    {item}
                  </button>
                ))}
              </div>
              <input className="input" value={model} onChange={(event) => setModel(event.target.value)} placeholder="deepseek-chat" />
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

          <Section label="音 忆">
            <label className="field">
              <div>
                <div className="field-label">每天什么时候写音忆</div>
                <div className="field-hint">Echo 在这个时间点回顾今天的你。</div>
              </div>
              <input className="time-input" type="time" value={generateAt} onChange={(event) => updateYinyiGenerateAt(event.target.value)} />
            </label>

            <label className="toggle-row">
              <div className="toggle-text">
                <div className="t1">打开音忆时随机翻一篇过去</div>
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

          <Section label="对 话 与 品 味">
            <label className="toggle-row">
              <div className="toggle-text">
                <div className="t1">启动时恢复上次对话</div>
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

            <div className="data-line">
              <div>
                导入歌单
                <small>从网易云导出的 JSON 文件。</small>
              </div>
              <button className="btn sec" type="button" onClick={importPlaylist} disabled={busy}>
                <Upload size={15} />
                {importState === 'importing' ? '导入中...' : '选择文件'}
              </button>
            </div>
            {importStatus && (
              <div className={`status-ind ${importState === 'ok' ? 'ok' : importState === 'fail' ? 'err' : 'idle'}`}>
                <span className="status-dot" />
                {importStatus}
              </div>
            )}
            {importProgress && (
              <div className="import-progress" aria-live="polite">
                <div className="import-progress-text">{importProgressLine(importProgress)}</div>
                <div className="import-progress-bar">
                  <span style={{ width: `${importProgressPercent(importProgress)}%` }} />
                </div>
              </div>
            )}

            <div className="data-line">
              <div>
                重新认识你
                <small>基于已导入歌单重新初始化画像。</small>
              </div>
              <button className="btn warn" type="button" onClick={regenerateProfile} disabled={busy}>
                重新生成
              </button>
            </div>
          </Section>

          <Section label="网 易 云 · v 0 . 2">
            <div className="data-line">
              <div>
                登录状态
                <small>扫码后保存加密 cookie，后续用于读取歌单和播放链接。</small>
              </div>
              <span className={`status-ind inline ${neteaseState.loggedIn ? 'ok' : 'idle'}`}>
                <span className="status-dot" />
                {neteaseState.loggedIn ? neteaseState.nickname ?? '已登录' : '未登录'}
              </span>
            </div>
            <div className="netease-actions">
              <button className="btn sec" type="button" onClick={refreshNeteaseStatus} disabled={neteaseBusy}>刷新状态</button>
              {neteaseState.loggedIn ? (
                <>
                  <button className="btn" type="button" onClick={loadNeteasePlaylists} disabled={neteaseBusy}>读取歌单</button>
                  <button className="btn danger" type="button" onClick={logoutNetease} disabled={neteaseBusy}>退出</button>
                </>
              ) : (
                <button className="btn" type="button" onClick={startNeteaseLogin} disabled={neteaseBusy}>
                  {neteaseBusy ? '生成中...' : '扫码登录'}
                </button>
              )}
            </div>
            {neteaseQr && (
              <div className="netease-qr">
                <img src={neteaseQr.qrImage} alt="网易云扫码登录二维码" />
                <div>
                  <div className="field-label">用网易云音乐 App 扫码</div>
                  <div className="field-hint">扫码后在手机上确认，这里会自动更新登录状态。</div>
                  <div className="status-ind idle">
                    <span className="status-dot" />
                    {neteaseQrStatus}
                  </div>
                </div>
              </div>
            )}
            {!neteaseQr && (
              <div className={`status-ind ${neteaseState.loggedIn ? 'ok' : 'idle'}`}>
                <span className="status-dot" />
                {neteaseState.message}
              </div>
            )}
            {neteasePlaylists.length > 0 && (
              <div className="netease-playlists">
                {neteasePlaylists.map((playlist) => (
                  <div className="netease-playlist" key={playlist.id}>
                    <div>
                      <div className="np-list-name">{playlist.name}</div>
                      <div className="np-list-meta">{playlist.trackCount} 首 · {playlist.creator ?? '网易云'}</div>
                    </div>
                    <button className="btn sec" type="button" onClick={() => importNeteasePlaylist(playlist.id)} disabled={Boolean(importingNeteaseId)}>
                      {importingNeteaseId === playlist.id ? '导入中...' : '导入'}
                    </button>
                  </div>
                ))}
              </div>
            )}
            {neteasePlaylistStatus && (
              <div className={`status-ind ${neteasePlaylistStatus.includes('失败') ? 'err' : 'idle'}`}>
                <span className="status-dot" />
                {neteasePlaylistStatus}
              </div>
            )}
          </Section>

          <Section label="听 音 · v 0 . 3">
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
                  className={ttsBaseUrl === defaultTtsBaseUrl ? 'model-tag active' : 'model-tag'}
                  onClick={() => {
                    setTtsBaseUrl(defaultTtsBaseUrl)
                    void saveVoiceSettings({ ttsBaseUrl: defaultTtsBaseUrl })
                  }}
                >
                  wangwangit · 默认
                </button>
                <button
                  type="button"
                  className={ttsBaseUrl && ttsBaseUrl !== defaultTtsBaseUrl ? 'model-tag active' : 'model-tag'}
                  onClick={() => setTtsBaseUrl(ttsBaseUrl && ttsBaseUrl !== defaultTtsBaseUrl ? ttsBaseUrl : 'https://')}
                >
                  自定义
                </button>
              </div>
              <input
                className="input"
                value={ttsBaseUrl}
                onChange={(event) => setTtsBaseUrl(event.target.value)}
                onBlur={(event) => { void saveVoiceSettings({ ttsBaseUrl: event.target.value }) }}
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
                onBlur={(event) => { void saveVoiceSettings({ ttsSpeed: Number(event.target.value) }) }}
                onMouseUp={(event) => { void saveVoiceSettings({ ttsSpeed: Number(event.currentTarget.value) }) }}
                onTouchEnd={(event) => { void saveVoiceSettings({ ttsSpeed: Number(event.currentTarget.value) }) }}
              />
            </label>
            {voiceSettingsStatus && (
              <div className={`status-ind ${voiceSettingsStatus === '已保存' ? 'ok' : 'err'}`}>
                <span className="status-dot" />
                {voiceSettingsStatus}
              </div>
            )}
          </Section>

          <Section label="E C H O 的 关 心" className="care-settings-section">
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
                  ['gentle', '克制', '每天 2 条'],
                  ['normal', '适中', '每天 3 条'],
                  ['frequent', '频繁', '每天 4 条'],
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

            <p className="care-copy">Echo 会在合适的时候轻轻出现一下。你点开后，它会带你回到对话、播放推荐，或进入听音。</p>
            <button className="btn sec care-test-btn" type="button" onClick={testCarePing} disabled={busy}>
              立刻测试一条
            </button>
            {careStatus && (
              <div className={`status-ind ${careStatus === '已保存' ? 'ok' : careStatus.includes('失败') ? 'err' : 'idle'}`}>
                <span className="status-dot" />
                {careStatus}
              </div>
            )}
          </Section>

          <Section label="数 据">
            <div className="data-line danger-line">
              <div>
                清空所有数据
                <small>回到第一次打开 Echo 的状态。</small>
              </div>
              <button className="btn danger" type="button" onClick={requestResetData} disabled={busy}>清 空</button>
            </div>
            {dataStatus && (
              <div className={`status-ind ${dataState === 'ok' ? 'ok' : dataState === 'err' ? 'err' : 'idle'}`}>
                <span className="status-dot" />
                {dataStatus}
              </div>
            )}
          </Section>
        </form>

        <footer className="page-foot">E C H O · v 0 . 1 . 0</footer>
      </div>

      {showResetConfirm && (
        <div className="close-dialog-layer settings-reset-layer" role="dialog" aria-modal="true" aria-labelledby="settings-reset-title">
          <div className="close-dialog settings-reset-dialog">
            <div className="close-dialog-kicker">E C H O · R E S E T</div>
            <h2 id="settings-reset-title">要把 Echo 清空吗？</h2>
            <p>这会清掉本地对话、音忆、画像、收藏、导入歌单和网易云登录状态。清空后，Echo 会回到第一次打开时的样子。</p>
            <label className="close-dialog-check">
              <input
                type="checkbox"
                checked={resetConfirmChecked}
                onChange={(event) => setResetConfirmChecked(event.target.checked)}
              />
              <span>我知道这会清空本地数据</span>
            </label>
            <div className="close-dialog-actions">
              <button className="btn close-quit-btn" type="button" onClick={() => setShowResetConfirm(false)} disabled={busy}>
                先不清
              </button>
              <button className="btn settings-reset-confirm" type="button" onClick={resetData} disabled={busy || !resetConfirmChecked}>
                {busy ? '清空中' : '清空 Echo'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
