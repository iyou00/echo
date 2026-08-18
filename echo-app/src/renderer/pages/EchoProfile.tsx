import { useEffect, useRef, useState } from 'react'
import { ChevronDown } from 'lucide-react'
import type { EchoApi, MemoryAuditItem, MemoryAuditKind, MemoryAuditSummary, PlaybackState, ProfileInsight, TasteProfile, TasteProfileVersion, TasteQuestion, Track, UiBoundarySnapshot } from '../../types/ipc'
import type { AppPageProps } from '../appState'
import { latestRunningRuntimeTask, useRuntimeTasks } from '../hooks/useRuntimeTasks'
import { friendlyOperationError } from '../../shared/runtimeRecovery'
import { trackIdentity } from '../../shared/trackIdentity'
import { BoundaryState } from '../components/BoundaryState'
import {
  ERA_SCALE,
  findPortraitClueMatch,
  normalizeProfileMoodFilter,
  profileEvidenceSourceLabel,
  profileItemIsPositiveDisplaySignal,
  profileSignatureItemVisible,
  profileItemHasBehaviorEvidence,
  profileAsPercent as asPercent,
  profileWeightDisplay,
  tempoPreferenceDisplay,
  type ProfileStatsEvidence,
} from './echoProfileDisplay'

interface EchoProfileProps extends AppPageProps {
  echo: EchoApi
  profile: TasteProfile | null
  playbackState: PlaybackState
  setPlaybackState: (state: PlaybackState) => void
  refreshQueue: () => Promise<Track[]>
  refreshProfile: () => Promise<void>
  boundary?: UiBoundarySnapshot
  onOpenLearned?: () => void
}

function displayDate(value?: string) {
  if (!value) return ''
  return new Date(value).toLocaleDateString('zh-CN')
}

const AUDIT_TAG_TEXT: Record<MemoryAuditKind, string> = {
  correction: '纠正',
  favorite: '收藏',
  loop: '循环',
  played: '听过',
  skip: '跳过',
  explicit_like: '口头',
  explicit_miss: '口头',
}

const AUDIT_TAG_TONE: Record<MemoryAuditKind, string> = {
  correction: 'red',
  favorite: 'green',
  loop: '',
  played: '',
  skip: 'red',
  explicit_like: 'green',
  explicit_miss: 'red',
}

function auditTimeLabel(value?: string) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleDateString('zh-CN', { month: 'long', day: 'numeric' })
}

function renderAuditEvent(item: MemoryAuditItem) {
  const meterWidth = Math.round(Math.min(Math.max(item.weight ?? 0.4, 0.05), 1) * 100)
  const negative = item.kind === 'skip' || item.kind === 'explicit_miss'
  return (
    <div className="ev-row" key={item.id}>
      <span className={`tag ${AUDIT_TAG_TONE[item.kind]}`}>{item.label || AUDIT_TAG_TEXT[item.kind]}</span>
      <span className="what">
        {item.title}
        {item.detail && <small>{item.detail}</small>}
      </span>
      <div className="meter" aria-hidden="true">
        <i style={{ width: `${meterWidth}%`, ...(negative ? { background: 'var(--d2-red)' } : null) }} />
      </div>
      <time>{auditTimeLabel(item.createdAt)}</time>
    </div>
  )
}

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)) }

type SignatureDisplayItem = NonNullable<TasteProfile['display']>['signatureItems'][number]

type MemoryLoadState = 'idle' | 'loading' | 'loaded' | 'error'

type StatEvidenceKind = 'era' | 'energy' | 'tempo'

function statsEvidence(profile?: TasteProfile | null): ProfileStatsEvidence | undefined {
  return profile?.profile_meta?.statsEvidence
}

function statCounts(evidence: ProfileStatsEvidence | undefined, kind: StatEvidenceKind) {
  if (!evidence) return { imported: undefined as number | undefined, behavior: undefined as number | undefined }
  if (kind === 'era') return { imported: evidence.eraImportedCount, behavior: evidence.eraBehaviorCount }
  if (kind === 'energy') return { imported: evidence.energyImportedCount, behavior: evidence.energyBehaviorCount }
  return { imported: evidence.tempoImportedCount, behavior: evidence.tempoBehaviorCount }
}

function hasStatSignal(evidence: ProfileStatsEvidence | undefined, kind: StatEvidenceKind, hasLegacyValue: boolean): boolean {
  const { imported, behavior } = statCounts(evidence, kind)
  if (imported == null || behavior == null) return hasLegacyValue
  return imported + behavior > 0
}

function statMetaLabel(evidence: ProfileStatsEvidence | undefined, kind: StatEvidenceKind, fallback: string): string {
  const { imported, behavior } = statCounts(evidence, kind)
  if (imported == null || behavior == null) return fallback
  if (behavior >= 3) return `${Math.round(behavior)} 条播放/反馈`
  if (behavior > 0) return `${Math.round(behavior)} 条行为线索`
  if (imported >= 5) return '来自导入歌单'
  if (imported > 0) return '导入线索偏少'
  return '继续观察'
}

function eraEvidenceLine(profile: TasteProfile, era: string): string {
  const percent = asPercent(profile.era_preference?.[era] ?? 0)
  const evidence = statsEvidence(profile)
  const { imported, behavior } = statCounts(evidence, 'era')
  if (percent <= 0) return '这个年代暂时没有足够线索。'
  if (behavior != null && imported != null) {
    if (behavior >= 3) return `这个频段占比 ${percent}%，主要来自你最近的播放和反馈。`
    if (behavior > 0) return `这个频段占比 ${percent}%，已经有少量行为线索。`
    if (imported >= 5) return `这个频段占比 ${percent}%，目前主要来自导入歌单。`
    return `这个频段占比 ${percent}%，线索还少。`
  }
  if (percent >= 35) return `这个频段占比 ${percent}%，已经是你歌单里的明显线索。`
  if (percent >= 15) return `这个频段占比 ${percent}%，有一些稳定出现的声音。`
  return `这个频段占比 ${percent}%，目前只是轻微信号。`
}

function tempoLabel(value: 'slow' | 'medium' | 'fast') {
  if (value === 'slow') return '慢速'
  if (value === 'fast') return '快速'
  return '中速'
}

function energyLabel(percent: number) {
  if (percent >= 66) return '偏高能'
  if (percent <= 38) return '偏安静'
  return '中等能量'
}

function signalStrengthLabel(value: number) {
  const percent = asPercent(value)
  if (percent >= 70) return '线索很强'
  if (percent >= 45) return '线索稳定'
  if (percent > 0) return '轻微信号'
  return '还在观察'
}

function discoveryLabel(value: number) {
  const percent = asPercent(value)
  if (percent >= 64) return '更愿意探索'
  if (percent <= 38) return '偏熟悉安全'
  return '探索适中'
}

export function EchoProfilePage({ echo, navigate, profile, playbackState, setPlaybackState, refreshQueue, refreshProfile, boundary, onOpenLearned }: EchoProfileProps) {
  const [busy, setBusy] = useState(false)
  const [phase, setPhase] = useState<'idle' | 'loading' | 'in'>('idle')
  const [playingKey, setPlayingKey] = useState('')
  const playingKeyRef = useRef('')
  const statusTimerRef = useRef<ReturnType<typeof setTimeout>>()
  const mountedRef = useRef(true)
  const memoryLoadingRef = useRef(false)
  const [status, setStatus] = useState<'idle' | 'success' | 'error'>('idle')
  const [statusMessage, setStatusMessage] = useState('')

  const [correctionOpen, setCorrectionOpen] = useState(false)
  const [correctionDraft, setCorrectionDraft] = useState('')
  const [correctionSaving, setCorrectionSaving] = useState(false)
  const [questions, setQuestions] = useState<TasteQuestion[]>([])
  const [questionDraft, setQuestionDraft] = useState('')
  const [questionSaving, setQuestionSaving] = useState(false)
  const [dismissedInsights, setDismissedInsights] = useState<Set<string>>(() => new Set())
  const [savingInsightId, setSavingInsightId] = useState('')
  const [memoryAudit, setMemoryAudit] = useState<MemoryAuditSummary | null>(null)
  const [profileVersions, setProfileVersions] = useState<TasteProfileVersion[] | null>(null)
  const [memoryLoadState, setMemoryLoadState] = useState<MemoryLoadState>('idle')
  const [restoringVersionId, setRestoringVersionId] = useState<number | null>(null)
  const [clueEvidence, setClueEvidence] = useState<{ title: string; detail: string; source: string } | null>(null)

  const [activeMoodFilter, setActiveMoodFilter] = useState<string>('all')
  const [tunerActiveEra, setTunerActiveEra] = useState<string>('20s')
  const [showEnergyDetails, setShowEnergyDetails] = useState<boolean>(false)

  // Retained task and cancellation hook
  const runtimeTasks = useRuntimeTasks(echo)
  const profileTask = latestRunningRuntimeTask(runtimeTasks, ['taste-refresh'], { includeChildren: false })
  const profileTaskRunning = Boolean(profileTask)
  const profileBusy = busy || profileTaskRunning

  // Automatically initialize tuner pointer to the strongest valid era signal,
  // but keep the user's current selection across profile refreshes.
  useEffect(() => {
    const sorted = profile?.era_preference
      ? Object.entries(profile.era_preference)
          .filter(([, value]) => Number.isFinite(value) && value > 0)
          .sort((a, b) => b[1] - a[1])
      : []
    const known = new Set(sorted.map(([era]) => era))
    setTunerActiveEra((current) => (known.has(current) ? current : sorted[0]?.[0] ?? '20s'))
  }, [profile])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      clearTimeout(statusTimerRef.current)
    }
  }, [])

  useEffect(() => {
    let active = true
    echo.taste.getProfile()
      .then((result) => { if (active) setQuestions(result.questions) })
      .catch(() => { if (active) setQuestions([]) })
    return () => { active = false }
  }, [echo, profile?.profile_meta?.portraitUpdatedAt])

  const portraitUpdatedAt = profile?.profile_meta?.portraitUpdatedAt ?? profile?.profile_meta?.updatedAt ?? profile?.profile_meta?.structuredUpdatedAt
  const display = profile?.display
  
  const signatureItems: SignatureDisplayItem[] = profile
    ? (display?.signatureItems?.length ? display.signatureItems : profile.signature_tracks.slice(0, 7).map((track) => ({ track, note: track.reason, evidenceLevel: 'weak' as const, source: 'fallback' as const })))
    : []

  const genreItems = profile
    ? (display?.genreItems?.length ? display.genreItems : profile.genres.map((genre) => ({ ...genre, representativeArtists: [] as string[], note: undefined, evidenceLevel: 'weak' as const, source: 'fallback' as const })))
    : []
  
  const artistItems = profile
    ? (display?.artistItems?.length ? display.artistItems : profile.artists.map((artist) => ({ name: artist.name, affinity: artist.affinity, note: artist.notes ?? '还在观察', evidenceLevel: 'weak' as const, source: 'fallback' as const })))
    : []
  const positiveArtistItems = artistItems.filter(profileItemIsPositiveDisplaySignal)

  const artistNamesSet = new Set(positiveArtistItems.map(a => a.name.trim().toLowerCase()))

  const genreItemsFiltered = genreItems.filter(profileItemIsPositiveDisplaySignal).filter((genre) => {
    const nameLower = genre.name.trim().toLowerCase()
    if (artistNamesSet.has(nameLower)) return false
    return true
  })

  const rawDisplayedGenres = genreItemsFiltered.slice(0, 5)

  const displayedGenres = rawDisplayedGenres.map((genre) => {
    const display = profileWeightDisplay(genre.weight)
    return {
      ...genre,
      displayPercent: display.value,
      displayPercentLabel: display.label,
      barPercent: display.bar,
    }
  })
  
  const moodItems = profile
    ? (display?.moodItems?.length ? display.moodItems : profile.moods.slice(0, 6).map((mood) => ({ tag: mood.tag, frequency: mood.frequency, evidenceLevel: 'weak' as const, source: 'fallback' as const })))
        .filter(profileItemIsPositiveDisplaySignal)
    : []
  const moodFilterKey = moodItems.map((mood) => mood.tag).join('\u0000')

  useEffect(() => {
    setClueEvidence(null)
  }, [profile])

  useEffect(() => {
    const availableMoodTags = moodFilterKey ? moodFilterKey.split('\u0000') : []
    setActiveMoodFilter((current) => normalizeProfileMoodFilter(current, availableMoodTags))
  }, [moodFilterKey])

  function showStatus(type: 'success' | 'error', message: string, autoHideMs?: number) {
    clearTimeout(statusTimerRef.current)
    setStatus(type)
    setStatusMessage(message)
    if (autoHideMs) statusTimerRef.current = setTimeout(() => setStatus('idle'), autoHideMs)
  }

  function clearStatus() {
    clearTimeout(statusTimerRef.current)
    setStatus('idle')
    setStatusMessage('')
  }

  function portraitFriendlyError(error: unknown): string {
    const message = error instanceof Error ? error.message : String(error)
    if (/取消|cancell?ed|aborted/i.test(message)) return '好，我先停下。'
    if (/没有返回 portrait|画像文案生成失败|需要直接对用户|缺少|内部证据|禁用表达|编造/i.test(message)) {
      return '我刚才没写顺，先保留原来的理解。'
    }
    if (/LLM 配置|API.?key|鉴权|余额|配置还没|rate|429|401|403|请求太频繁/i.test(message)) {
      return '我这会儿有点连不上脑子，先检查一下模型设置。'
    }
    if (/超时|网络|服务端|响应格式|fetch|ECONN|ENOTFOUND/i.test(message)) return '我刚才连得不太顺，稍后再试一次。'
    return '为什么我看不懂你呢？居然失败了。'
  }

  async function regenerate() {
    setBusy(true)
    clearStatus()
    try {
      setPhase('loading')
      const [result] = await Promise.all([echo.taste.regeneratePortrait(), sleep(900)])
      try {
        await refreshProfile()
      } catch {
        // Safe catch
      }
      if (!mountedRef.current) return
      setPhase('in')
      await sleep(400)
      if (!mountedRef.current) return
      setPhase('idle')
      if (result?.profile_meta?.portraitRefreshOutcome === 'retained') {
        showStatus('error', result.profile_meta.portraitRefreshReason ?? '新画像没写好，已经保留原来的。', 4000)
      }
    } catch (error) {
      if (!mountedRef.current) return
      setPhase('in')
      await sleep(400)
      if (!mountedRef.current) return
      try {
        await refreshProfile()
      } catch {
        // The saved fallback profile is best-effort; keep the friendly error visible if refresh fails too.
      }
      setPhase('idle')
      showStatus('error', portraitFriendlyError(error))
    } finally {
      if (mountedRef.current) setBusy(false)
    }
  }

  async function playSignature(track: Track) {
    const key = trackIdentity(track)
    playingKeyRef.current = key
    setPlayingKey(key)
    try {
      const next = await echo.playback.play({
        ...track,
        sourceContext: 'history',
        agentActionId: undefined,
        agentActionItemId: undefined,
        stageContextId: undefined,
        playbackInstanceId: undefined,
      })
      setPlaybackState(next)
      await refreshQueue()
    } catch (error) {
      showStatus('error', friendlyOperationError(error, '这首歌暂时没播放出来。'), 3000)
    } finally {
      if (playingKeyRef.current === key) setPlayingKey('')
    }
  }

  const triggerClueEvidence = (term: string) => {
    const match = findPortraitClueMatch(
      term,
      artistItems.map((artist) => artist.name),
      genreItems.map((genre) => genre.name),
    )

    if (match?.kind === 'artist') {
      const matchedArtist = artistItems.find((artist) => artist.name === match.name)
      if (!matchedArtist) return
      setClueEvidence({
        title: matchedArtist.name,
        detail: matchedArtist.note ?? '这个名字在你的播放、收藏或歌单里留下了比较清楚的线索。',
        source: profileEvidenceSourceLabel(matchedArtist),
      })
    } else if (match?.kind === 'genre') {
      const matchedGenre = genreItems.find((genre) => genre.name === match.name)
      if (!matchedGenre) return
      setClueEvidence({
        title: matchedGenre.name,
        detail: matchedGenre.note ?? '这是你的播放和歌单里反复出现的声音方向。',
        source: profileEvidenceSourceLabel(matchedGenre),
      })
    }
  }

  async function submitCorrection() {
    const note = correctionDraft.trim()
    if (!note || correctionSaving) return
    setCorrectionSaving(true)
    try {
      const result = await echo.taste.correctMemory(note)
      if (result.ok) {
        setCorrectionDraft('')
        setCorrectionOpen(false)
        showStatus('success', result.message, 2600)
        await refreshProfile()
      } else {
        showStatus('error', result.message, 3000)
      }
    } catch (error) {
      showStatus('error', friendlyOperationError(error, '这次纠正没有记下来，请稍后再试。'), 3000)
    } finally {
      if (mountedRef.current) setCorrectionSaving(false)
    }
  }

  async function respondToInsight(insight: ProfileInsight, action: 'confirm' | 'temporary' | 'reject') {
    if (savingInsightId) return
    setSavingInsightId(insight.id)
    try {
      await echo.taste.respondToInsight(insight, action)
      showStatus('success', action === 'confirm' ? '好，这一点我会更认真地记住。' : action === 'temporary' ? '明白，只把它放在最近。' : '这条我收回，不再据此判断你。', 3000)
      setDismissedInsights((current) => new Set(current).add(insight.id))
      await refreshProfile()
    } catch (error) {
      showStatus('error', friendlyOperationError(error, '这次反馈没有记下来，请稍后再试。'), 3000)
    } finally {
      if (mountedRef.current) setSavingInsightId('')
    }
  }

  async function answerProfileQuestion() {
    const question = questions[0]
    const answer = questionDraft.trim()
    if (!question || !answer || questionSaving) return
    setQuestionSaving(true)
    try {
      await echo.taste.answerQuestion(question.id, answer)
      setQuestions((current) => current.filter((item) => item.id !== question.id))
      setQuestionDraft('')
      showStatus('success', '我记下了，这比我自己猜要准。', 2600)
      await refreshProfile()
    } catch (error) {
      showStatus('error', friendlyOperationError(error, '这次回答没有记下来。'), 3000)
    } finally {
      if (mountedRef.current) setQuestionSaving(false)
    }
  }

  async function loadMemoryAudit(force = false) {
    if (memoryLoadingRef.current || (!force && memoryLoadState === 'loaded')) return
    memoryLoadingRef.current = true
    setMemoryLoadState('loading')
    try {
      const [audit, versions] = await Promise.all([
        echo.taste.getMemoryAudit(),
        echo.taste.getProfileVersions(),
      ])
      if (!mountedRef.current) return
      setMemoryAudit(audit)
      setProfileVersions(versions)
      setMemoryLoadState('loaded')
    } catch (error) {
      if (!mountedRef.current) return
      setMemoryLoadState('error')
      showStatus('error', friendlyOperationError(error, '暂时没读到 Echo 记住的内容。'), 3000)
    } finally {
      memoryLoadingRef.current = false
    }
  }

  const loadMemoryAuditRef = useRef(loadMemoryAudit)
  loadMemoryAuditRef.current = loadMemoryAudit

  useEffect(() => {
    if (profile) void loadMemoryAuditRef.current()
  }, [profile])

  async function restoreProfileVersion(id: number) {
    if (restoringVersionId != null) return
    setRestoringVersionId(id)
    try {
      await echo.taste.restoreProfileVersion(id)
      await refreshProfile()
      await loadMemoryAudit(true)
      showStatus('success', '已经恢复到这版画像。', 3000)
    } catch (error) {
      showStatus('error', friendlyOperationError(error, '这版画像暂时没恢复成功。'), 3000)
    } finally {
      if (mountedRef.current) setRestoringVersionId(null)
    }
  }

  const filteredSignatureDisplay = signatureItems
    .filter((item) => ['favorite', 'loop', 'played', 'explicit_like'].includes(item.source))
    .filter((item) => profileSignatureItemVisible(item, activeMoodFilter))
    .slice(0, 5)

  const evidence = statsEvidence(profile)
  const energyKnown = hasStatSignal(evidence, 'energy', profile?.energy_preference != null)
  const energyValue = profile?.energy_preference ?? 0
  const energyPercent = asPercent(energyValue)
  const eraEntries = profile?.era_preference
    ? Object.entries(profile.era_preference)
        .filter(([, value]) => Number.isFinite(value) && value > 0)
        .sort((a, b) => b[1] - a[1])
    : []
  const topEra = eraEntries[0]
  const tempoEntries = tempoPreferenceDisplay(profile?.tempo_preference)
  const topTempo = tempoEntries[0]
  const tempoKnown = hasStatSignal(evidence, 'tempo', Boolean(topTempo))
  const sceneSource = profile?.scenes?.filter((scene) => scene.tag.trim() && scene.frequency > 0).slice(0, 5) ?? []
  const sceneItems = sceneSource.map((scene) => ({ ...scene, strength: signalStrengthLabel(scene.frequency) }))
  const recentInsights = (profile?.insights?.recentChanges ?? []).filter((item) => !dismissedInsights.has(item.id))
  const hasSignatureBehaviorEvidence = filteredSignatureDisplay.some(profileItemHasBehaviorEvidence)
  const signatureSectionLabel = activeMoodFilter === 'all'
    ? (hasSignatureBehaviorEvidence ? '这 些 歌 ， 最 能 说 明' : '这 些 歌 ， 留 下 了 线 索')
    : `${activeMoodFilter}时，你更像这些歌`
  const auditItems = memoryAudit?.items ?? []
  const auditCorrections = auditItems.filter((item) => item.kind === 'correction')
  const auditEvents = auditItems.filter((item) => item.kind !== 'correction')
  const weekStartMs = Date.now() - 7 * 24 * 60 * 60 * 1000
  const isThisWeek = (item: MemoryAuditItem) => Boolean(item.createdAt && new Date(item.createdAt).getTime() >= weekStartMs)
  const auditThisWeek = auditEvents.filter(isThisWeek)
  const auditEarlier = auditEvents.filter((item) => !isThisWeek(item))
  const portraitPhase = profileBusy && phase === 'idle' ? 'loading' : phase

  return (
    <div className="d2-profile">
      {!profile ? (
        boundary && !profileBusy
          ? <BoundaryState snapshot={boundary} onAction={() => navigate('settings')} />
          : (
            <div className="pf-empty">
              <div className="ring" aria-hidden="true">♪</div>
              <h2>{profileBusy ? '等我一下。' : '我还没听过你的歌。'}</h2>
              <p>{profileBusy ? '正在整理你给我的线索……' : '放几首，或者导入一份歌单——画像从这里开始长。听过的每一首、说过的每一句，我都会记成线索。'}</p>
              {!profileBusy && (
                <div className="pf-empty-cta">
                  <button type="button" className="pf-btn" onClick={() => navigate('settings')}>去导入歌单</button>
                  <button type="button" className="pf-btn plain" onClick={() => navigate('chat')}>先去聊聊</button>
                </div>
              )}
            </div>
          )
      ) : (
        <>
          <div className="pf-hero">
            <div className="pf-kicker">E C H O 眼 里 的 你</div>
            {portraitPhase === 'loading' ? (
              <div className="d2-profile-skeleton" role="status" aria-label="画像生成中">
                <span className="long" />
                <span className="mid" />
                <span className="short" />
              </div>
            ) : (
              <h1 className="pf-portrait">
                {profile.echo_portrait.split(/(，|。|、|！|？|”|“)/).map((segment, index) => {
                  const match = findPortraitClueMatch(
                    segment,
                    artistItems.map((artist) => artist.name),
                    genreItems.map((genre) => genre.name),
                  )

                  if (match) {
                    return (
                      <button
                        type="button"
                        key={index}
                        className="d2-profile-mark"
                        onClick={() => triggerClueEvidence(segment)}
                      >
                        {segment}
                      </button>
                    )
                  }
                  return <span key={index}>{segment}</span>
                })}
              </h1>
            )}

            {clueEvidence && (
              <div className="d2-profile-clue" role="status">
                <div className="d2-profile-clue-head">
                  <span>为什么这么说</span>
                  <strong>{clueEvidence.title}</strong>
                  <button type="button" onClick={() => setClueEvidence(null)} title="收起依据" aria-label="收起依据">×</button>
                </div>
                <p>{clueEvidence.detail}</p>
                <small>{clueEvidence.source}</small>
              </div>
            )}

            {status !== 'idle' && <div className={`d2-profile-status ${status}`}>{statusMessage}</div>}

            <div className="pf-hero-meta">
              <span>{portraitUpdatedAt ? `画像更新于 ${displayDate(portraitUpdatedAt)}` : '画像 · 尚未生成'}</span>
              <div className="pf-hero-tools">
                <button type="button" onClick={regenerate} disabled={profileBusy}>{profileBusy ? '正在重写…' : '更新理解'}</button>
                <button type="button" onClick={() => navigate('settings')}>设置</button>
              </div>
            </div>
          </div>

          <div className="pf-dims">
            <div className="dim">
              <small>声 音 方 向</small>
              <h3>{displayedGenres.length > 0 ? `${displayedGenres[0].name}为主${displayedGenres[1] ? `，也有${displayedGenres[1].name}` : ''}` : '还在观察'}</h3>
              {displayedGenres.length > 0 && (
                <div className="tags">
                  {displayedGenres.slice(0, 4).map((genre) => <i key={genre.name}>{genre.name} {genre.displayPercentLabel}</i>)}
                </div>
              )}
              <div className="ev">{displayedGenres[0] ? (displayedGenres[0].trend === 'up' ? '最近更明显' : signalStrengthLabel(displayedGenres[0].weight)) : '线索还少'}</div>
            </div>
            <div className="dim">
              <small>情 绪 底 色</small>
              <h3>{moodItems.length > 0 ? moodItems.slice(0, 2).map((mood) => mood.tag).join('、') : energyKnown ? energyLabel(energyPercent) : '还在观察'}</h3>
              {moodItems.length > 0 && (
                <div className="tags">{moodItems.slice(0, 4).map((mood) => <i key={mood.tag}>{mood.tag}</i>)}</div>
              )}
              <div className="ev">{energyKnown ? `${energyLabel(energyPercent)} · ${statMetaLabel(evidence, 'energy', tempoKnown && topTempo ? tempoLabel(topTempo.tempo) : '节奏还在观察')}` : '能量线索还不够，我会继续观察'}</div>
              {(energyKnown || tempoKnown) && (
                <>
                  <button className="dim-more" type="button" onClick={() => setShowEnergyDetails((current) => !current)} aria-expanded={showEnergyDetails}>
                    {showEnergyDetails ? '收起节奏细节' : '节奏细节'}
                    <ChevronDown className={showEnergyDetails ? 'expanded' : ''} size={12} />
                  </button>
                  {showEnergyDetails && (
                    <div className="dim-detail">
                      {tempoKnown && tempoEntries.map((entry) => (
                        <div className="d2-profile-kv" key={entry.tempo}><span>{tempoLabel(entry.tempo)}</span><strong>{signalStrengthLabel(entry.rawValue)}</strong></div>
                      ))}
                      <div className="d2-profile-kv"><span>探索倾向</span><strong>{discoveryLabel(profile.discovery_appetite ?? 0.5)}</strong></div>
                    </div>
                  )}
                </>
              )}
            </div>
            <div className="dim">
              <small>年 代 与 新 旧</small>
              <h3>{topEra ? `${topEra[0]} 的声音最多` : '还在观察'}</h3>
              {eraEntries.length > 0 && (
                <div className="tags">{eraEntries.slice(0, 3).map(([era, value]) => <i key={era}>{era} {asPercent(value)}%</i>)}</div>
              )}
              <div className="ev">{statMetaLabel(evidence, 'era', topEra ? signalStrengthLabel(topEra[1]) : '继续观察')}</div>
              {eraEntries.length > 0 && (
                <>
                  <div className="d2-profile-era-scale">
                    {ERA_SCALE.map((era) => (
                      <button type="button" key={era} className={tunerActiveEra === era ? 'active' : ''} onClick={() => setTunerActiveEra(era)}>
                        {era}
                      </button>
                    ))}
                  </div>
                  <div className="d2-profile-era-meta">
                    <span>{tunerActiveEra}</span>
                    <strong>{signalStrengthLabel(profile.era_preference?.[tunerActiveEra] ?? 0)}</strong>
                  </div>
                  <p className="d2-profile-muted">{eraEvidenceLine(profile, tunerActiveEra)}</p>
                </>
              )}
            </div>
            <div className="dim">
              <small>常 去 场 景</small>
              <h3>{sceneItems.length > 0 ? sceneItems.slice(0, 2).map((scene) => scene.tag).join('、') : '还在观察'}</h3>
              {sceneItems.length > 0 && (
                <div className="tags">{sceneItems.slice(0, 4).map((scene) => <i key={scene.tag}>{scene.tag}</i>)}</div>
              )}
              <div className="ev">{sceneItems[0]?.strength ?? '场景线索还少'}</div>
            </div>
          </div>

          <div className="sub-kicker pf-gap">{signatureSectionLabel}</div>
          {moodItems.length > 0 && (
            <div className="d2-profile-moods" role="tablist" aria-label="按氛围查看代表歌曲">
              <button type="button" role="tab" aria-selected={activeMoodFilter === 'all'} className={activeMoodFilter === 'all' ? 'active' : ''} onClick={() => setActiveMoodFilter('all')}>全部</button>
              {moodItems.slice(0, 5).map((mood) => {
                const isSelected = activeMoodFilter === mood.tag
                return (
                  <button
                    type="button"
                    role="tab"
                    aria-selected={isSelected}
                    className={isSelected ? 'active' : ''}
                    key={mood.tag}
                    onClick={() => setActiveMoodFilter(isSelected ? 'all' : mood.tag)}
                  >
                    {mood.tag}
                  </button>
                )
              })}
            </div>
          )}
          {filteredSignatureDisplay.length === 0 ? (
            <p className="d2-profile-muted">
              {activeMoodFilter === 'all' ? '还没有足够的主动线索，我先不替你选代表歌曲。' : '在这个情绪切片下，还没有收集到契合的歌曲。'}
            </p>
          ) : (
            filteredSignatureDisplay.map((item, index) => {
              const trackKeyStr = trackIdentity(item.track)
              const isCurrentTrack = Boolean(trackKeyStr && trackKeyStr === trackIdentity(playbackState.current))
              const isPlayingThis = playingKey === trackKeyStr

              return (
                <div className={`d2-profile-row${isCurrentTrack ? ' current' : ''}`} key={`${item.track.title}-${index}`}>
                  <div>
                    <strong>{String(index + 1).padStart(2, '0')} · {item.track.title}</strong>
                    <small>{item.track.artist}{item.track.year ? ` · ${item.track.year}` : ''}</small>
                    {item.note && <small className="d2-profile-row-note">{item.note}</small>}
                  </div>
                  <button
                    className="d2-profile-row-btn"
                    type="button"
                    title="播放这首代表曲目"
                    onClick={() => playSignature(item.track)}
                    disabled={isPlayingThis}
                  >
                    {isPlayingThis ? '正在放' : '播放'}
                  </button>
                </div>
              )
            })
          )}
          {positiveArtistItems.length > 0 && (
            <div className="d2-profile-group pf-artists">
              <div className="d2-profile-group-label">人声线索</div>
              {positiveArtistItems.slice(0, 5).map((artist) => (
                <div className="d2-profile-row" key={artist.name}>
                  <div>
                    <strong>{artist.name}</strong>
                    <small>{artist.note ?? profileEvidenceSourceLabel(artist)}</small>
                    <span className="d2-profile-meter" aria-hidden="true"><span style={{ width: `${asPercent(artist.affinity)}%` }} /></span>
                  </div>
                  <span className="d2-profile-row-label">{asPercent(artist.affinity)}%</span>
                </div>
              ))}
            </div>
          )}

          <div className="sub-kicker pf-gap">它 记 下 的 证 据<span className="n">· 本周与更早</span></div>
          {memoryLoadState === 'loading' && <p className="d2-profile-muted" role="status">正在整理…</p>}
          {memoryLoadState === 'error' && (
            <div className="d2-profile-row">
              <div><strong>这次没读到我记住的线索。</strong></div>
              <button className="d2-profile-row-btn" type="button" onClick={() => void loadMemoryAudit(true)}>重新读取</button>
            </div>
          )}
          {memoryLoadState === 'loaded' && auditEvents.length === 0 && <p className="d2-profile-muted">还没有形成可核对的记忆。</p>}
          {memoryLoadState === 'loaded' && auditThisWeek.length > 0 && (
            <>
              <div className="ev-group">本 周</div>
              {auditThisWeek.map(renderAuditEvent)}
            </>
          )}
          {memoryLoadState === 'loaded' && auditEarlier.length > 0 && (
            <>
              <div className="ev-group">更 早</div>
              {auditEarlier.map(renderAuditEvent)}
            </>
          )}
          {memoryLoadState === 'loaded' && profileVersions && profileVersions.length > 0 && (
            <>
              <div className="sub-kicker pf-gap">画 像 版 本</div>
              {profileVersions.slice(0, 6).map((version) => (
                <div className="d2-profile-row" key={version.id}>
                  <div>
                    <strong>{displayDate(version.createdAt)}</strong>
                    <small>{version.summary ?? version.portrait}</small>
                  </div>
                  <button
                    className="d2-profile-row-btn"
                    type="button"
                    disabled={restoringVersionId != null}
                    onClick={() => restoreProfileVersion(version.id)}
                    title="恢复这版画像"
                  >
                    {restoringVersionId === version.id ? '恢复中' : '恢复'}
                  </button>
                </div>
              ))}
            </>
          )}

          <div className="sub-kicker pf-gap">这 周 ， 我 对 你 改 观 的 一 点</div>
          {recentInsights.length > 0 ? recentInsights.slice(0, 2).map((insight) => (
            <div className="d2-profile-row" key={insight.id}>
              <div>
                <strong>{insight.statement}</strong>
                <small>{insight.evidenceLabel}</small>
                <div className="d2-insight-actions" role="group" aria-label={`回应：${insight.statement}`}>
                  <button type="button" disabled={Boolean(savingInsightId)} onClick={() => respondToInsight(insight, 'confirm')}>是我</button>
                  <button type="button" disabled={Boolean(savingInsightId)} onClick={() => respondToInsight(insight, 'temporary')}>只是最近</button>
                  <button type="button" disabled={Boolean(savingInsightId)} onClick={() => respondToInsight(insight, 'reject')}>不太对</button>
                </div>
              </div>
            </div>
          )) : (
            <p className="d2-profile-muted">最近的线索还不够跨天，我先不急着替你下结论。</p>
          )}

          {questions[0] && (
            <>
              <div className="d2-profile-subtitle pf-gap">我还没看清</div>
              <p className="d2-profile-question-copy">{questions[0].content}</p>
              <div className="d2-profile-question-answer">
                <form
                  className="d2-profile-question-form"
                  onSubmit={(event) => {
                    event.preventDefault()
                    void answerProfileQuestion()
                  }}
                >
                  <input value={questionDraft} onChange={(event) => setQuestionDraft(event.target.value)} maxLength={180} placeholder="跟 Echo 说一句" />
                  <button type="submit" disabled={!questionDraft.trim() || questionSaving}>{questionSaving ? '记着' : '告诉 Echo'}</button>
                </form>
              </div>
            </>
          )}

          <div className="sub-kicker pf-gap">你 纠 正 过 它</div>
          {auditCorrections.length > 0 ? auditCorrections.map((item) => (
            <div className="corr" key={item.id}>
              <q>{item.title}</q>
              <small>{[auditTimeLabel(item.createdAt), item.detail].filter(Boolean).join(' · ')}</small>
            </div>
          )) : (
            <p className="d2-profile-muted">还没有被你纠正过的记忆。说错了就直接讲，我会当场改。</p>
          )}
          {correctionOpen ? (
            <div className="d2-profile-correct">
              <textarea
                value={correctionDraft}
                onChange={(event) => setCorrectionDraft(event.target.value)}
                maxLength={300}
                placeholder="比如：我最近听王菲比较多，是那几天刚好在听。"
              />
              <div className="d2-profile-correct-actions">
                <button className="d2-profile-row-btn" type="button" onClick={() => { setCorrectionOpen(false); setCorrectionDraft('') }} disabled={correctionSaving}>取消</button>
                <button className="d2-profile-row-btn primary" type="button" onClick={submitCorrection} disabled={!correctionDraft.trim() || correctionSaving}>{correctionSaving ? '保存中' : '记下'}</button>
              </div>
            </div>
          ) : (
            <button className="d2-profile-correct-link" type="button" onClick={() => setCorrectionOpen(true)}>这段理解不准</button>
          )}
          {onOpenLearned && (
            <p className="cross-link">这些纠正沉淀在 <button type="button" className="cross-link-btn" onClick={onOpenLearned}>设置 · Echo 学到了什么</button>，可随时删除或停用夜间复盘。</p>
          )}
          <p className="migrate-note">觉得哪里说得不对？不用找设置——直接对 Echo 说「你记错了，……」，它会当场改。</p>
        </>
      )}
    </div>
  )
}
