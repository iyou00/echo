import { type CSSProperties, useEffect, useRef, useState } from 'react'
import { Pause, Play, RefreshCw, Settings } from 'lucide-react'
import type { EchoApi, PlaybackState, TasteProfile, Track } from '../../types/ipc'
import type { AppPageProps } from '../appState'
import { BrandLogo, EmptyState, Section } from '../components'
import { latestRunningRuntimeTask, useRuntimeTasks } from '../hooks/useRuntimeTasks'
import { stableHash } from '../../shared/deterministic'
import { friendlyOperationError } from '../../shared/runtimeRecovery'
import {
  ERA_SCALE,
  eraNeedleLeft,
  findPortraitClueMatch,
  hasProfileBehaviorEvidence,
  percentDisplay,
  profileChangeSectionCopy,
  profileEnergyLine,
  profileEvidenceSourceLabel,
  profileItemIsPositiveDisplaySignal,
  profileSignatureItemVisible,
  profileItemHasBehaviorEvidence,
  profileItemHasUserActionEvidence,
  profileMoodLine,
  profileAsPercent as asPercent,
  profileSummaryCardMeta,
  profileTrendLines,
  profileWeightDisplay,
  tempoPreferenceDisplay,
  type ProfileStatsEvidence,
} from './echoProfileDisplay'

interface EchoProfileProps extends AppPageProps {
  echo: EchoApi
  profile: TasteProfile | null
  setPlaybackState: (state: PlaybackState) => void
  refreshQueue: () => Promise<Track[]>
  refreshProfile: () => Promise<void>
}

function displayDate(value?: string) {
  if (!value) return ''
  return new Date(value).toLocaleDateString('zh-CN')
}

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)) }

type MoodItem = NonNullable<TasteProfile['display']>['moodItems'][number]

type SignatureDisplayItem = NonNullable<TasteProfile['display']>['signatureItems'][number]

function moodCloudStyle(mood: MoodItem, index: number): CSSProperties {
  const percent = asPercent(mood.frequency)
  const shift = (stableHash(`${mood.tag}:${index}`) % 9) - 4
  const lift = (stableHash(`mood:${mood.tag}`) % 7) - 3
  return {
    '--mood-size': `${13 + Math.round(percent / 7)}px`,
    '--mood-opacity': `${0.58 + Math.min(0.34, percent / 180)}`,
    '--mood-x': `${shift}px`,
    '--mood-y': `${lift}px`,
  } as CSSProperties
}

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

export function EchoProfilePage({ echo, navigate, profile, setPlaybackState, refreshQueue, refreshProfile }: EchoProfileProps) {
  const [busy, setBusy] = useState(false)
  const [phase, setPhase] = useState<'idle' | 'loading' | 'in'>('idle')
  const [playingKey, setPlayingKey] = useState('')
  const playingKeyRef = useRef('')
  const statusTimerRef = useRef<ReturnType<typeof setTimeout>>()
  const mountedRef = useRef(true)
  const [status, setStatus] = useState<'idle' | 'success' | 'error'>('idle')
  const [statusMessage, setStatusMessage] = useState('')

  const [correctionOpen, setCorrectionOpen] = useState(false)
  const [correctionDraft, setCorrectionDraft] = useState('')
  const [correctionSaving, setCorrectionSaving] = useState(false)

  // New Music-Centric Interactive States
  const [activeMoodFilter, setActiveMoodFilter] = useState<string>('all')
  const [tunerActiveEra, setTunerActiveEra] = useState<string>('20s')
  const [showEnergyDetails, setShowEnergyDetails] = useState<boolean>(false)
  const [localPlaybackState, setLocalPlaybackState] = useState<PlaybackState | null>(null)

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



  // Listen to Global Playback Changes for persistent HUD
  useEffect(() => {
    let active = true
    echo.playback.getState()
      .then((state) => {
        if (active) setLocalPlaybackState(state)
      })
      .catch(() => {
        if (active) setLocalPlaybackState(null)
      })
    const unsubscribe = echo.playback.onStateChanged((state) => {
      if (active) setLocalPlaybackState(state)
    })
    return () => {
      active = false
      unsubscribe()
    }
  }, [echo])

  useEffect(() => {
    mountedRef.current = true
    return () => {
      mountedRef.current = false
      clearTimeout(statusTimerRef.current)
    }
  }, [])

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

  const artistNamesSet = new Set(artistItems.map(a => a.name.trim().toLowerCase()))

  const genreItemsFiltered = genreItems.filter((genre) => {
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
    : []

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
      await Promise.all([echo.taste.regeneratePortrait(), sleep(900)])
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
    const key = `${track.id ?? track.neteaseId ?? ''}:${track.title}:${track.artist}`
    playingKeyRef.current = key
    setPlayingKey(key)
    try {
      const next = await echo.playback.play(track)
      setPlaybackState(next)
      await refreshQueue()
    } catch (error) {
      showStatus('error', friendlyOperationError(error, '这首歌暂时没播放出来。'), 3000)
    } finally {
      if (playingKeyRef.current === key) setPlayingKey('')
    }
  }



  // Persistent Player Handlers
  const isPlaying = localPlaybackState?.status === 'playing'
  const currentTrack = localPlaybackState?.current
  const togglePlayback = async () => {
    if (!currentTrack) return
    try {
      let nextState
      if (isPlaying) {
        nextState = await echo.playback.pause()
      } else {
        nextState = await echo.playback.resume()
      }
      setLocalPlaybackState(nextState)
      setPlaybackState(nextState)
    } catch (err) {
      showStatus('error', '播放器控制失败', 2000)
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
      showStatus('success', `${matchedArtist.name} · ${matchedArtist.note ?? '从你的听歌里慢慢记下来的'}`, 4000)
    } else if (match?.kind === 'genre') {
      const matchedGenre = genreItems.find((genre) => genre.name === match.name)
      if (!matchedGenre) return
      showStatus('success', `${matchedGenre.name} · ${matchedGenre.note ?? '你歌单里的一个稳定方向'}`, 4000)
    } else {
      showStatus('success', '这是我从你平时听歌里慢慢拼出来的。', 3000)
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

  // Filter signature tracks only by explicit evidence.
  const filteredSignatureDisplay = signatureItems.filter((item) => profileSignatureItemVisible(item, activeMoodFilter))

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
  const sceneTotal = sceneSource.reduce((sum, scene) => sum + scene.frequency, 0)
  const sceneItems = sceneSource.map((scene) => {
    const display = percentDisplay(sceneTotal > 0 ? (scene.frequency / sceneTotal) * 100 : asPercent(scene.frequency), 6)
    return {
      ...scene,
      labelPercent: display.label,
      barPercent: display.bar,
    }
  })
  const trendLines = profileTrendLines(genreItemsFiltered, {
    evidence,
    moodLine: profileMoodLine(moodItems, evidence),
    energyLine: energyKnown ? profileEnergyLine(energyLabel(energyPercent), evidence) : '',
  })
  const hasDisplayUserActionEvidence = [
    ...signatureItems,
    ...genreItemsFiltered,
    ...artistItems,
    ...moodItems,
  ].some(profileItemHasUserActionEvidence)
  const hasBehaviorEvidence = hasProfileBehaviorEvidence(evidence) || hasDisplayUserActionEvidence
  const hasSignatureBehaviorEvidence = signatureItems.some(profileItemHasBehaviorEvidence)
  const statsCards = [
    { label: '主要流派', value: displayedGenres[0]?.name ?? '线索不足', meta: displayedGenres[0] ? profileSummaryCardMeta(displayedGenres[0], displayedGenres[0].displayPercentLabel) : '继续听几首会更准' },
    { label: '艺人线索', value: positiveArtistItems[0]?.name ?? '线索不足', meta: positiveArtistItems[0] ? profileSummaryCardMeta(positiveArtistItems[0], signalStrengthLabel(positiveArtistItems[0].affinity)) : '还在观察' },
    { label: '氛围倾向', value: moodItems[0]?.tag ?? '线索不足', meta: moodItems[0] ? profileSummaryCardMeta(moodItems[0], `${asPercent(moodItems[0].frequency)}%`) : '还在观察' },
    { label: '年代偏好', value: topEra?.[0] ?? '线索不足', meta: topEra ? statMetaLabel(evidence, 'era', `${asPercent(topEra[1])}%`) : '还在观察' },
    { label: '节奏速度', value: tempoKnown && topTempo ? tempoLabel(topTempo.tempo) : '线索不足', meta: tempoKnown && topTempo ? statMetaLabel(evidence, 'tempo', topTempo.label) : '还在观察' },
    { label: '能量水平', value: energyKnown ? energyLabel(energyPercent) : '线索不足', meta: energyKnown ? statMetaLabel(evidence, 'energy', signalStrengthLabel(energyValue)) : '还在观察' },
  ]
  const signatureSectionLabel = activeMoodFilter === 'all'
    ? (hasSignatureBehaviorEvidence ? '代表歌曲' : '歌单代表')
    : `${activeMoodFilter} · ${hasSignatureBehaviorEvidence ? '代表歌曲' : '歌单代表'}`
  const changeSectionCopy = profileChangeSectionCopy(hasBehaviorEvidence)

  // Segments calculate for 30 bars Bottom Seeker HUD
  const duration = localPlaybackState?.duration ?? 180
  const position = localPlaybackState?.position ?? 0
  const percent = duration > 0 ? position / duration : 0
  const activeSegmentsCount = Math.min(30, Math.floor(percent * 30))
  const portraitPhase = profileBusy && phase === 'idle' ? 'loading' : phase

  return (
    <div className="phone-surface profile-page">
      <div className="page-toolbar">
        <div className="tb-status">Echo 眼里的你</div>
        <div className="tb-actions">
          <button className={`tb-btn icon-only${profileBusy ? ' spinning' : ''}`} onClick={regenerate} disabled={profileBusy} title="重新生成画像">
            <RefreshCw size={14} />
          </button>
          <button className="tb-btn icon-only" onClick={() => navigate('settings')} title="设置">
            <Settings size={14} />
          </button>
        </div>
      </div>

      <div className="scroll-panel" style={{ paddingBottom: currentTrack ? '70px' : '20px' }}>
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
            {/* 章 1 · Echo 画像 */}
            <Section className="portrait-section">
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
                          <span 
                            key={index} 
                            className="clue-term"
                            onClick={() => triggerClueEvidence(segment)}
                          >
                            {segment}
                          </span>
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

            <Section label={changeSectionCopy.label}>
              <div className="profile-change-list">
                {trendLines.length > 0 ? trendLines.map((line) => (
                  <div className="profile-change-item" key={line}>{line}</div>
                )) : (
                  <div className="profile-change-item muted">{changeSectionCopy.emptyText}</div>
                )}
              </div>
              {eraEntries.length > 0 && (
                <div className="profile-analysis-group compact">
                  <div className="profile-analysis-title">年代偏好</div>
                  <div className="tuner-dial">
                    <div className="tuner-needle" style={{ left: eraNeedleLeft(tunerActiveEra) }} />
                    <div className="tuner-scale">
                      {ERA_SCALE.map((era) => {
                        const isSelected = tunerActiveEra === era
                        return (
                          <div
                            key={era}
                            className={`tuner-tick long-tick ${isSelected ? 'active' : ''}`}
                            onClick={() => setTunerActiveEra(era)}
                          >
                            <span className="tuner-tick-label">{era}</span>
                          </div>
                        )
                      })}
                    </div>
                  </div>
                  <div className="tuner-meta">
                    <span>{tunerActiveEra}</span>
                    <span className="tuner-meta-highlight">{asPercent(profile.era_preference?.[tunerActiveEra] ?? 0)}%</span>
                  </div>
                  <p className="tuner-quote">{eraEvidenceLine(profile, tunerActiveEra)}</p>
                </div>
              )}
              <div className="profile-analysis-group compact">
                <div className="profile-analysis-title">节奏与能量</div>
                <div className="energy-row">
                  <div
                    className="battery-container"
                    onClick={() => setShowEnergyDetails(prev => !prev)}
                    title="查看节奏细节"
                  >
                    <div className="battery-fill" style={{ width: `${energyKnown ? energyPercent : 0}%` }} />
                  </div>
                  <p className="energy-desc">
                    {energyKnown ? `${energyLabel(energyPercent)} · ${tempoKnown && topTempo ? tempoLabel(topTempo.tempo) : '节奏还在观察'}` : '能量线索还不够，我会按真实播放继续观察。'}
                  </p>
                </div>
                {showEnergyDetails && (
                  <div className="energy-dropdown">
                    <div className="energy-drop-item">
                      <span>能量水平</span>
                      <span className="energy-drop-val">{energyKnown ? signalStrengthLabel(energyValue) : '线索不足'}</span>
                    </div>
                    {tempoKnown && tempoEntries.map((entry) => (
                      <div className="energy-drop-item" key={entry.tempo}>
                        <span>{tempoLabel(entry.tempo)}</span>
                        <span className="energy-drop-val">{entry.label}</span>
                      </div>
                    ))}
                    <div className="energy-drop-item" style={{ borderTop: '0.5px dashed var(--border)', paddingTop: '4px', marginTop: '4px' }}>
                      <span>探索倾向</span>
                      <span className="energy-drop-val">{discoveryLabel(profile.discovery_appetite ?? 0.5)}</span>
                    </div>
                  </div>
                )}
              </div>
            </Section>

            <Section label="音乐品味统计">
              <div className="profile-stats-grid">
                {statsCards.map((item) => (
                  <div className="profile-stat-card" key={item.label}>
                    <span>{item.label}</span>
                    <strong>{item.value}</strong>
                    <small>{item.meta}</small>
                  </div>
                ))}
              </div>
              {displayedGenres.length > 0 && (
                <div className="profile-analysis-group">
                  <div className="profile-analysis-title">流派分布</div>
                  {displayedGenres.map((genre) => (
                    <div className={`genre-row evidence-${genre.evidenceLevel}`} key={genre.name}>
                      <div className="genre-head">
                        <span className="genre-name">{genre.name}</span>
                        <span className={genre.trend === 'up' ? 'genre-trend trend-up' : genre.trend === 'down' ? 'genre-trend trend-down' : 'genre-trend trend-steady'}>
                          {genre.trend === 'up' ? '↑' : genre.trend === 'down' ? '↓' : '·'} {genre.displayPercentLabel}
                        </span>
                      </div>
                      <div className="genre-bar-bg">
                        <div className="genre-bar-fill" style={{ width: `${genre.barPercent}%` }} />
                      </div>
                      {genre.note && <div className="genre-note">{genre.note}</div>}
                      {genre.representativeArtists.length > 0 && (
                        <div className="genre-chips">
                          {genre.representativeArtists.map((artist) => <span className="genre-chip" key={`${genre.name}-${artist}`}>{artist}</span>)}
                        </div>
                      )}
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
                        <div className="artist-name">
                          {artist.name}
                          <small>{artist.note ?? profileEvidenceSourceLabel(artist)}</small>
                        </div>
                        <div className="affinity-bar">
                          <span className="affinity-fill" style={{ width: `${asPercent(artist.affinity)}%` }} />
                        </div>
                      </div>
                    ))}
                  </div>
                </div>
              )}
              {moodItems.length > 0 && (
                <div className="profile-analysis-group">
                  <div className="profile-analysis-title">氛围倾向</div>
                  <div className="moods-container">
                    <div className="mood-cloud" style={{ display: 'flex', flexWrap: 'wrap', gap: '8px 10px', alignItems: 'baseline' }}>
                      {moodItems.map((mood, index) => {
                        const isSelected = activeMoodFilter === mood.tag
                        const baseStyle = moodCloudStyle(mood, index)
                        return (
                          <span
                            className={`mood-cloud-tag ${isSelected ? 'active' : ''}`}
                            key={mood.tag}
                            style={{
                              ...baseStyle,
                              padding: '4px 10px',
                              borderRadius: '14px',
                              backgroundColor: 'var(--ayin-green-100)',
                              fontSize: 'var(--mood-size)'
                            } as CSSProperties}
                            onClick={() => setActiveMoodFilter(isSelected ? 'all' : mood.tag)}
                          >
                            {mood.tag}
                          </span>
                        )
                      })}
                    </div>
                  </div>
                </div>
              )}
            </Section>

            <Section label={signatureSectionLabel}>
              <div className="signature-list">
                {filteredSignatureDisplay.length === 0 ? (
                  <p style={{ fontSize: '12px', color: 'var(--text-tertiary)', padding: '16px 0', textAlign: 'center', fontStyle: 'italic' }}>
                    在这个情绪切片下，还没有收集到契合的歌曲。
                  </p>
                ) : (
                  filteredSignatureDisplay.map((item, index) => {
                    const trackKeyStr = `${item.track.id ?? item.track.neteaseId ?? ''}:${item.track.title}:${item.track.artist}`
                    const isTrackPlayingNow = currentTrack && `${currentTrack.id ?? currentTrack.neteaseId ?? ''}:${currentTrack.title}:${currentTrack.artist}` === trackKeyStr

                    return (
                      <div className={`sig-track ${isTrackPlayingNow ? 'playing' : ''}`} key={`${item.track.title}-${index}`}>
                        <div className="sig-track-main">
                          <div className="sig-num">{String(index + 1).padStart(2, '0')}</div>
                          <div className="sig-track-body">
                            <div className="sig-title">{item.track.title}</div>
                            <div className="sig-meta">{item.track.artist}{item.track.year ? ` · ${item.track.year}` : ''}</div>
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

            <Section label="常出现的听歌场景">
              {sceneItems.length > 0 ? (
                <div className="profile-scene-list">
                  {sceneItems.map((scene) => (
                    <div className="profile-scene-row" key={scene.tag}>
                      <div className="profile-scene-head">
                        <span>{scene.tag}</span>
                        <small>{scene.labelPercent}</small>
                      </div>
                      <div className="genre-bar-bg">
                        <div className="genre-bar-fill" style={{ width: `${scene.barPercent}%` }} />
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="profile-muted-copy">场景线索还少，我会继续观察你通常在什么时候听什么。</p>
              )}
            </Section>

            <footer className="page-foot" style={{ paddingBottom: '32px' }}>
              {portraitUpdatedAt
                ? `画像更新于 ${displayDate(portraitUpdatedAt)}`
                : '画像 · 尚未生成'}
            </footer>
          </>
        )}
      </div>

      {/* 底部正在播放持久浮条 (Segmented Playback HUD) */}
      {currentTrack && (
        <div className="now-playing-strip">
          <div className="np-main-row">
            <div className="np-info" style={{ flex: 1, minWidth: 0 }}>
              <span className="np-title" style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{currentTrack.title}</span>
              <span className="np-meta" style={{ display: 'block', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{currentTrack.artist}</span>
            </div>
            <button 
              className="np-btn" 
              onClick={togglePlayback}
              title={isPlaying ? "暂停播放" : "继续播放"}
            >
              {isPlaying ? <Pause size={16} fill="currentColor" /> : <Play size={16} fill="currentColor" />}
            </button>
          </div>
          {/* Flex 30 segments progress bar */}
          <div className="np-segmented-bar" title={`进度：${Math.round(percent * 100)}%`}>
            {Array.from({ length: 30 }).map((_, idx) => (
              <div 
                key={idx} 
                className={`np-bar-segment ${idx < activeSegmentsCount ? 'active' : ''}`} 
              />
            ))}
          </div>
        </div>
      )}
    </div>
  )
}
