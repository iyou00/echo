import { useEffect, useRef, useState } from 'react'
import { BookOpen, Brain, Check, ChevronDown, Clock3, Play, RefreshCw, RotateCcw, Settings, X } from 'lucide-react'
import type { EchoApi, MemoryAuditSummary, PlaybackState, ProfileInsight, TasteProfile, TasteProfileVersion, TasteQuestion, Track } from '../../types/ipc'
import type { AppPageProps } from '../appState'
import { BrandLogo, EmptyState, Section } from '../components'
import { latestRunningRuntimeTask, useRuntimeTasks } from '../hooks/useRuntimeTasks'
import { friendlyOperationError } from '../../shared/runtimeRecovery'
import { trackIdentity } from '../../shared/trackIdentity'
import {
  ERA_SCALE,
  eraNeedleLeft,
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
}

function displayDate(value?: string) {
  if (!value) return ''
  return new Date(value).toLocaleDateString('zh-CN')
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

export function EchoProfilePage({ echo, navigate, profile, playbackState, setPlaybackState, refreshQueue, refreshProfile }: EchoProfileProps) {
  const [busy, setBusy] = useState(false)
  const [phase, setPhase] = useState<'idle' | 'loading' | 'in'>('idle')
  const [playingKey, setPlayingKey] = useState('')
  const playingKeyRef = useRef('')
  const statusTimerRef = useRef<ReturnType<typeof setTimeout>>()
  const mountedRef = useRef(true)
  const memoryDetailsRef = useRef<HTMLDetailsElement>(null)
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

  // Automatically initialize tuner pointer to the strongest valid era signal.
  useEffect(() => {
    const sorted = profile?.era_preference
      ? Object.entries(profile.era_preference)
          .filter(([, value]) => Number.isFinite(value) && value > 0)
          .sort((a, b) => b[1] - a[1])
      : []
    setTunerActiveEra(sorted[0]?.[0] ?? '20s')
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
  const coreSignals = [
    displayedGenres[0] ? {
      label: '声音方向',
      value: displayedGenres[0].name,
      note: displayedGenres[0].trend === 'up'
        ? `最近更明显 · ${profileEvidenceSourceLabel(displayedGenres[0], '来自已有画像')}`
        : `${signalStrengthLabel(displayedGenres[0].weight)} · ${profileEvidenceSourceLabel(displayedGenres[0], '来自已有画像')}`,
      tone: 'warm',
    } : null,
    positiveArtistItems[0] ? {
      label: '熟悉的人声',
      value: positiveArtistItems[0].name,
      note: positiveArtistItems[0].note ?? profileEvidenceSourceLabel(positiveArtistItems[0]),
      tone: 'ink',
    } : null,
    moodItems[0] ? {
      label: '常出现的状态',
      value: moodItems[0].tag,
      note: `${signalStrengthLabel(moodItems[0].frequency)} · ${profileEvidenceSourceLabel(moodItems[0], '来自已有画像')}`,
      tone: 'blue',
    } : null,
    energyKnown ? {
      label: '听歌能量',
      value: energyLabel(energyPercent),
      note: statMetaLabel(evidence, 'energy', tempoKnown && topTempo ? tempoLabel(topTempo.tempo) : '节奏还在观察'),
      tone: 'warm',
    } : null,
    topEra ? {
      label: '年代线索',
      value: topEra[0],
      note: statMetaLabel(evidence, 'era', signalStrengthLabel(topEra[1])),
      tone: 'ink',
    } : null,
  ].filter((item): item is NonNullable<typeof item> => Boolean(item)).slice(0, 3)
  const signatureSectionLabel = activeMoodFilter === 'all'
    ? (hasSignatureBehaviorEvidence ? '这些歌，最能说明' : '这些歌，留下了线索')
    : `${activeMoodFilter}时，你更像这些歌`
  const portraitPhase = profileBusy && phase === 'idle' ? 'loading' : phase

  return (
    <div className="phone-surface profile-page">
      <div className="scroll-panel">
        {!profile ? (
          <EmptyState
            icon={<BrandLogo className="empty-logo" size={56} />}
            className="profile-empty"
            title={profileBusy ? '等我一下。' : '我还没听过你的歌呢。你给我导一份歌单,我读一下,然后我们再正经聊。'}
            body={undefined}
            sign={profileBusy ? undefined : '— Echo · 等你'}
            action={!profileBusy && <button className="primary-button empty-cta" onClick={() => navigate('settings')}>导 入 歌 单</button>}
          />
        ) : (
          <>
            <Section className="portrait-section">
              <div className="profile-portrait-actions">
                <button className={`profile-icon-action${profileBusy ? ' spinning' : ''}`} onClick={regenerate} disabled={profileBusy} title="更新画像" aria-label="更新画像">
                  <RefreshCw size={15} />
                </button>
                <button className="profile-icon-action" onClick={() => navigate('settings')} title="设置" aria-label="设置">
                  <Settings size={15} />
                </button>
              </div>
              <div className="portrait-eyebrow">一份持续更新的观察</div>
              <BrandLogo className={`avatar-big${profileBusy ? ' avatar-breathing' : ''}`} size={56} />
              <div className={`portrait-content ${portraitPhase}`}>
                {portraitPhase === 'idle' || portraitPhase === 'in' ? (
                  <p className="portrait-text">
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
                            className="clue-term"
                            onClick={() => triggerClueEvidence(segment)}
                          >
                            {segment}
                          </button>
                        )
                      }
                      return <span key={index}>{segment}</span>
                    })}
                  </p>
                ) : (
                  <div className="portrait-loading" role="status" aria-label="画像生成中">
                    <div className="portrait-skeleton" aria-hidden="true">
                      <span className="portrait-skeleton-line long" />
                      <span className="portrait-skeleton-line mid" />
                      <span className="portrait-skeleton-line short" />
                    </div>
                  </div>
                )}
              </div>
              {clueEvidence && (
                <div className="portrait-evidence" role="status">
                  <div>
                    <span>为什么这么说</span>
                    <strong>{clueEvidence.title}</strong>
                  </div>
                  <p>{clueEvidence.detail}</p>
                  <small>{clueEvidence.source}</small>
                  <button type="button" onClick={() => setClueEvidence(null)} title="收起依据" aria-label="收起依据"><X size={13} /></button>
                </div>
              )}
              <div className="portrait-meta-row">
                <div className="portrait-sign">
                  — Echo · {portraitUpdatedAt ? `写于 ${displayDate(portraitUpdatedAt)}` : '初次见面'}
                  {status !== 'idle' && <span className={`portrait-status ${status}`}>{statusMessage}</span>}
                </div>
                {!correctionOpen && (
                  <button className="portrait-correction-link" type="button" onClick={() => setCorrectionOpen(true)}>
                    这段理解不准
                  </button>
                )}
              </div>
              {correctionOpen && (
                <div className="portrait-correction">
                  <div className="portrait-correction-box">
                    <textarea
                      value={correctionDraft}
                      onChange={(event) => setCorrectionDraft(event.target.value)}
                      maxLength={300}
                      placeholder="比如：我最近听王菲比较多，是那几天刚好在听。"
                    />
                    <div className="portrait-correction-actions">
                      <button className="tb-btn" type="button" onClick={() => { setCorrectionOpen(false); setCorrectionDraft('') }} disabled={correctionSaving}>
                        取消
                      </button>
                      <button className="tb-btn" type="button" onClick={submitCorrection} disabled={!correctionDraft.trim() || correctionSaving}>
                        {correctionSaving ? '保存中' : '记下'}
                      </button>
                    </div>
                  </div>
                </div>
              )}
            </Section>

            <Section className="profile-recent-section" label="这周，我对你改观的一点">
              <div className="profile-change-list">
                {recentInsights.length > 0 ? recentInsights.slice(0, 2).map((insight) => (
                  <div className="profile-change-item profile-insight" key={insight.id}>
                    <div>
                      <strong>{insight.statement}</strong>
                      <small>{insight.evidenceLabel}</small>
                    </div>
                    <div className="profile-insight-actions" aria-label={`回应：${insight.statement}`}>
                      <button type="button" disabled={Boolean(savingInsightId)} onClick={() => respondToInsight(insight, 'confirm')} title="是我"><Check size={12} /><span>是我</span></button>
                      <button type="button" disabled={Boolean(savingInsightId)} onClick={() => respondToInsight(insight, 'temporary')} title="只是最近"><Clock3 size={12} /><span>只是最近</span></button>
                      <button type="button" disabled={Boolean(savingInsightId)} onClick={() => respondToInsight(insight, 'reject')} title="不太对"><X size={12} /><span>不太对</span></button>
                    </div>
                  </div>
                )) : (
                  <div className="profile-change-empty">
                    <span>还没有明显变化</span>
                    <p>最近的线索还不够跨天，我先不急着替你下结论。</p>
                  </div>
                )}
              </div>
            </Section>

            <Section className="profile-core-section" label="现在最像你的三个音乐线索">
              {coreSignals.length > 0 ? (
                <div className="profile-core-signals">
                  {coreSignals.map((signal, index) => (
                    <div className={`profile-core-signal tone-${signal.tone}`} key={`${signal.label}-${signal.value}`}>
                      <span className="profile-core-index">{String(index + 1).padStart(2, '0')}</span>
                      <div>
                        <small>{signal.label}</small>
                        <strong>{signal.value}</strong>
                        <p>{signal.note}</p>
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="profile-muted-copy">我还没有足够线索挑出最像你的三个方向，再听一阵子会更准。</p>
              )}
            </Section>

            <Section label={signatureSectionLabel}>
              {moodItems.length > 0 && (
                <div className="profile-mood-filter" role="tablist" aria-label="按氛围查看代表歌曲">
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
              <div className="signature-list">
                {filteredSignatureDisplay.length === 0 ? (
                  <p style={{ fontSize: '12px', color: 'var(--text-tertiary)', padding: '16px 0', textAlign: 'center', fontStyle: 'italic' }}>
                    {activeMoodFilter === 'all' ? '还没有足够的主动线索，我先不替你选代表歌曲。' : '在这个情绪切片下，还没有收集到契合的歌曲。'}
                  </p>
                ) : (
                  filteredSignatureDisplay.map((item, index) => {
                    const trackKeyStr = trackIdentity(item.track)
                    const isCurrentTrack = Boolean(trackKeyStr && trackKeyStr === trackIdentity(playbackState.current))

                    return (
                      <div className={`sig-track${isCurrentTrack ? ' playing' : ''}`} key={`${item.track.title}-${index}`}>
                        <div className="sig-track-main">
                          <div className="sig-num">{String(index + 1).padStart(2, '0')}</div>
                          <div className="sig-track-body">
                            <div className="sig-title">{item.track.title}</div>
                            <div className="sig-meta">{item.track.artist}{item.track.year ? ` · ${item.track.year}` : ''}</div>
                            {item.note && <div className="sig-observation">{item.note}</div>}
                          </div>
                          <button
                            className="sig-play"
                            title="播放这首代表曲目"
                            onClick={() => playSignature(item.track)}
                            disabled={playingKey === trackKeyStr}
                          >
                            <Play size={10} fill="currentColor" />
                          </button>
                        </div>
                      </div>
                    )
                  })
                )}
              </div>
            </Section>

            {questions[0] && (
              <Section className="profile-question-section" label="我还没看清">
                <div className="profile-curiosity">
                  <p>{questions[0].content}</p>
                  <div className="profile-curiosity-answer">
                    <input value={questionDraft} onChange={(event) => setQuestionDraft(event.target.value)} maxLength={180} placeholder="跟 Echo 说一句" />
                    <button type="button" onClick={answerProfileQuestion} disabled={!questionDraft.trim() || questionSaving}>{questionSaving ? '记着' : '告诉 Echo'}</button>
                  </div>
                </div>
              </Section>
            )}

            <Section className="profile-deep-section" label="再往深处看">
              <details className="profile-archive profile-disclosure">
                <summary>
                  <BookOpen size={16} />
                  <span><strong>完整音乐档案</strong><small>年代、能量、流派、艺人与场景</small></span>
                  <ChevronDown className="profile-disclosure-chevron" size={16} />
                </summary>
                <div className="profile-disclosure-body">
                  {eraEntries.length > 0 && (
                    <div className="profile-analysis-group compact">
                      <div className="profile-analysis-title">年代偏好</div>
                      <div className="tuner-dial">
                        <div className="tuner-needle" style={{ left: eraNeedleLeft(tunerActiveEra) }} />
                        <div className="tuner-scale">
                          {ERA_SCALE.map((era) => (
                            <button type="button" key={era} className={`tuner-tick long-tick ${tunerActiveEra === era ? 'active' : ''}`} onClick={() => setTunerActiveEra(era)}>
                              <span className="tuner-tick-label">{era}</span>
                            </button>
                          ))}
                        </div>
                      </div>
                      <div className="tuner-meta"><span>{tunerActiveEra}</span><span className="tuner-meta-highlight">{signalStrengthLabel(profile.era_preference?.[tunerActiveEra] ?? 0)}</span></div>
                      <p className="tuner-quote">{eraEvidenceLine(profile, tunerActiveEra).replace(/占比\s*\d+%[，,]?\s*/g, '')}</p>
                    </div>
                  )}
                  <div className="profile-analysis-group compact">
                    <div className="profile-analysis-title">节奏与能量</div>
                    <button className="energy-row" type="button" onClick={() => setShowEnergyDetails((current) => !current)} aria-expanded={showEnergyDetails}>
                      {energyKnown
                        ? <span className="battery-container" aria-hidden="true"><span className="battery-fill" style={{ width: `${energyPercent}%` }} /></span>
                        : <span className="energy-unknown-mark" aria-hidden="true"><Clock3 size={15} /></span>}
                      <span className="energy-desc">{energyKnown ? `${energyLabel(energyPercent)} · ${tempoKnown && topTempo ? tempoLabel(topTempo.tempo) : '节奏还在观察'}` : '能量线索还不够，我会按真实播放继续观察。'}</span>
                      <ChevronDown className={showEnergyDetails ? 'expanded' : ''} size={15} />
                    </button>
                    {showEnergyDetails && (
                      <div className="energy-dropdown">
                        {tempoKnown && tempoEntries.map((entry) => <div className="energy-drop-item" key={entry.tempo}><span>{tempoLabel(entry.tempo)}</span><span className="energy-drop-val">{signalStrengthLabel(entry.rawValue)}</span></div>)}
                        <div className="energy-drop-item"><span>探索倾向</span><span className="energy-drop-val">{discoveryLabel(profile.discovery_appetite ?? 0.5)}</span></div>
                      </div>
                    )}
                  </div>
                  {displayedGenres.length > 0 && (
                    <div className="profile-analysis-group">
                      <div className="profile-analysis-title">声音方向</div>
                      {displayedGenres.map((genre) => (
                        <div className={`genre-row evidence-${genre.evidenceLevel}`} key={genre.name}>
                          <div className="genre-head"><span className="genre-name">{genre.name}</span><span className="genre-trend">{genre.trend === 'up' ? '最近更明显' : genre.trend === 'down' ? '最近变少' : signalStrengthLabel(genre.weight)}</span></div>
                          <div className="genre-bar-bg"><div className="genre-bar-fill" style={{ width: `${genre.barPercent}%` }} /></div>
                          {genre.note && <div className="genre-note">{genre.note}</div>}
                        </div>
                      ))}
                    </div>
                  )}
                  {positiveArtistItems.length > 0 && (
                    <div className="profile-analysis-group">
                      <div className="profile-analysis-title">艺人线索</div>
                      <div className="artist-list">
                        {positiveArtistItems.slice(0, 5).map((artist, index) => (
                          <div className={`artist-item evidence-${artist.evidenceLevel}`} key={artist.name}>
                            <span className="artist-rank">{String(index + 1).padStart(2, '0')}</span>
                            <div className="artist-name">{artist.name}<small>{artist.note ?? profileEvidenceSourceLabel(artist)}</small></div>
                            <div className="affinity-bar"><span className="affinity-fill" style={{ width: `${asPercent(artist.affinity)}%` }} /></div>
                          </div>
                        ))}
                      </div>
                    </div>
                  )}
                  <div className="profile-analysis-group">
                    <div className="profile-analysis-title">常出现的听歌场景</div>
                    {sceneItems.length > 0 ? (
                      <div className="profile-scene-list">{sceneItems.map((scene) => <div className="profile-scene-row" key={scene.tag}><span>{scene.tag}</span><small>{scene.strength}</small></div>)}</div>
                    ) : <p className="profile-muted-copy">场景线索还少，我会继续观察你通常在什么时候听什么。</p>}
                  </div>
                </div>
              </details>
              <details
                ref={memoryDetailsRef}
                className="profile-memory profile-disclosure"
                onToggle={(event) => { if (event.currentTarget.open) void loadMemoryAudit() }}
              >
                <summary>
                  <Brain size={16} />
                  <span><strong>Echo 用来理解你的线索</strong><small>核对记忆，也可以回到过去的画像</small></span>
                  <ChevronDown className="profile-disclosure-chevron" size={16} />
                </summary>
                <div className="profile-disclosure-body">
                  {memoryLoadState === 'loading' && <p className="profile-muted-copy" role="status">正在整理...</p>}
                  {memoryLoadState === 'error' && (
                    <div className="profile-memory-error" role="alert">
                      <p>这次没读到我记住的线索。</p>
                      <button type="button" onClick={() => void loadMemoryAudit(true)}>重新读取</button>
                    </div>
                  )}
                  {memoryLoadState === 'loaded' && memoryAudit && (
                    memoryAudit.items.length > 0 ? (
                      <div className="profile-memory-list">
                        {memoryAudit.items.map((item) => (
                          <div className="profile-memory-item" key={item.id}>
                            <span>{item.label}</span>
                            <div><strong>{item.title}</strong>{item.detail && <small>{item.detail}</small>}</div>
                          </div>
                        ))}
                      </div>
                    ) : <p className="profile-muted-copy">还没有形成可核对的记忆。</p>
                  )}
                  {memoryLoadState === 'loaded' && profileVersions && profileVersions.length > 0 && (
                    <div className="profile-version-list">
                      <div className="profile-analysis-title">画像版本</div>
                      {profileVersions.slice(0, 6).map((version) => (
                        <div className="profile-version-item" key={version.id}>
                          <div><strong>{displayDate(version.createdAt)}</strong><small>{version.summary ?? version.portrait}</small></div>
                          <button type="button" disabled={restoringVersionId != null} onClick={() => restoreProfileVersion(version.id)} title="恢复这版画像"><RotateCcw size={13} /></button>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </details>
            </Section>

            <footer className="page-foot" style={{ paddingBottom: '32px' }}>
              {portraitUpdatedAt
                ? `画像更新于 ${displayDate(portraitUpdatedAt)}`
                : '画像 · 尚未生成'}
            </footer>
          </>
        )}
      </div>
    </div>
  )
}
