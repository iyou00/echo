import { type CSSProperties, useCallback, useEffect, useRef, useState } from 'react'
import { Pause, Play, RefreshCw, Settings } from 'lucide-react'
import type { EchoApi, MemoryAuditSummary, PlaybackState, ProfileEvidenceLevel, ProfileEvidenceSource, TasteProfile, Track } from '../../types/ipc'
import type { AppPageProps } from '../appState'
import { BrandLogo, EmptyState, Section } from '../components'
import { RuntimeTaskNotice } from '../components/RuntimeTaskNotice'
import { latestRunningRuntimeTask, useRuntimeTasks } from '../hooks/useRuntimeTasks'
import { stableHash } from '../../shared/deterministic'

interface EchoProfileProps extends AppPageProps {
  echo: EchoApi
  profile: TasteProfile | null
  setPlaybackState: (state: PlaybackState) => void
  refreshQueue: () => Promise<Track[]>
  refreshProfile: () => Promise<void>
}

function asPercent(value: number) {
  if (!Number.isFinite(value)) return 0
  return Math.max(0, Math.min(100, Math.round(value <= 1 ? value * 100 : value)))
}

function displayDate(value?: string) {
  if (!value) return ''
  return new Date(value).toLocaleDateString('zh-CN')
}

function displayAuditDate(value?: string) {
  if (!value) return ''
  return new Date(value).toLocaleDateString('zh-CN', { month: '2-digit', day: '2-digit' })
}

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)) }

type MoodItem = NonNullable<TasteProfile['display']>['moodItems'][number]

type SignatureDisplayItem = NonNullable<TasteProfile['display']>['signatureItems'][number]

const SIGNATURE_VARIANTS: Record<ProfileEvidenceSource, string[]> = {
  favorite: [
    '你亲手收藏过,这首会被我放在前排。',
    '被你留过心,所以它在这里有位置。',
    '收藏过的声音,我会记得更牢。',
    '这首被你标记过,分量比普通播放更重。',
  ],
  loop: [
    '你回头听过这首,它不是路过。',
    '循环播放过,像一条熟路。',
    '重复拿起过这首,有回声。',
    '你反复听过它,像一个稳的回头点。',
  ],
  played: [
    '完整听过,它通过了你的耐心。',
    '从头听到尾过,这条线索够稳。',
    '认真听完过,耳朵很少抗拒它。',
    '完整播放过,不算路过。',
  ],
  scene: [
    '在某个场景里接上过,这条线索很清楚。',
    '某个场景里出现过,像一枚书签。',
    '和某个场景贴得比较近。',
    '在特定时刻被记下过。',
  ],
  semantic: [
    '偏向某种情绪的线索。',
    '落在情绪光谱的某一侧。',
    '更像某种心情时会靠近的声音。',
    '留下了某种情绪的主要轮廓。',
  ],
  imported: [
    '来自你的歌单,先浮上来的那一批。',
    '歌单里比较稳的一枚锚点。',
    '导入时就在,是旧歌单的底色之一。',
    '从你的歌单里留下来的坐标。',
    '歌单里先被注意到的一首。',
    '它来自你的旧歌单,有稳定的位置。',
  ],
  fallback: [
    '我还在观察它和你的关系。',
    '线索还浅,先放在这里。',
    '暂时是一枚待确认的坐标。',
    '我会继续听它和你的距离。',
  ],
}

function signatureNote(track: Track, source: ProfileEvidenceSource, note?: string, _count?: number, evidenceLevel?: ProfileEvidenceLevel): string {
  if (note && evidenceLevel === 'strong') return note
  const variants = SIGNATURE_VARIANTS[source] ?? SIGNATURE_VARIANTS.fallback
  const key = `${track.neteaseId ?? track.id ?? ''}:${track.title}:${track.artist}`
  return variants[stableHash(key) % variants.length]
}

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

export function EchoProfilePage({ echo, navigate, profile, setPlaybackState, refreshQueue, refreshProfile }: EchoProfileProps) {
  const [busy, setBusy] = useState(false)
  const [phase, setPhase] = useState<'idle' | 'out' | 'loading' | 'in'>('idle')
  const [playingKey, setPlayingKey] = useState('')
  const playingKeyRef = useRef('')
  const statusTimerRef = useRef<ReturnType<typeof setTimeout>>()
  const mountedRef = useRef(true)
  const [status, setStatus] = useState<'idle' | 'success' | 'error'>('idle')
  const [statusMessage, setStatusMessage] = useState('')

  // Retained existing states for correction and memory audit
  const [correctionOpen, setCorrectionOpen] = useState(false)
  const [correctionDraft, setCorrectionDraft] = useState('')
  const [correctionSaving, setCorrectionSaving] = useState(false)
  const [memoryAudit, setMemoryAudit] = useState<MemoryAuditSummary | null>(null)

  // New Music-Centric Interactive States
  const [activeMoodFilter, setActiveMoodFilter] = useState<string>('all')
  const [activeLoopTimelineId, setActiveLoopTimelineId] = useState<string | null>(null)
  const [tunerActiveEra, setTunerActiveEra] = useState<string>('20s')
  const [showEnergyDetails, setShowEnergyDetails] = useState<boolean>(false)
  const [localPlaybackState, setLocalPlaybackState] = useState<PlaybackState | null>(null)

  // Retained task and cancellation hook
  const runtimeTasks = useRuntimeTasks(echo)
  const profileTask = latestRunningRuntimeTask(runtimeTasks, ['taste-refresh'], { includeChildren: false })
  const profileTaskRunning = Boolean(profileTask)
  const profileBusy = busy || profileTaskRunning

  // Automatically initialize tuner pointer to user's highest preference era
  useEffect(() => {
    if (profile?.era_preference) {
      const sorted = Object.entries(profile.era_preference).sort((a, b) => b[1] - a[1])
      if (sorted[0]) {
        setTunerActiveEra(sorted[0][0])
      }
    }
  }, [profile])



  // Listen to Global Playback Changes for persistent HUD
  useEffect(() => {
    let active = true
    echo.playback.getState().then((state) => {
      if (active) setLocalPlaybackState(state)
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
    return () => {
      mountedRef.current = false
      clearTimeout(statusTimerRef.current)
    }
  }, [])

  const portraitUpdatedAt = profile?.profile_meta?.updatedAt ?? profile?.profile_meta?.structuredUpdatedAt
  const display = profile?.display
  
  const signatureItems: SignatureDisplayItem[] = profile
    ? (display?.signatureItems?.length ? display.signatureItems : profile.signature_tracks.slice(0, 7).map((track) => ({ track, note: track.reason, evidenceLevel: 'weak' as const, source: 'fallback' as const })))
    : []
  
  const signatureDisplay = signatureItems.map((item) => ({
    ...item,
    displayNote: signatureNote(item.track, item.source, item.note, item.count, item.evidenceLevel),
  }))

  const genreItems = profile
    ? (display?.genreItems?.length ? display.genreItems : profile.genres.map((genre) => ({ ...genre, representativeArtists: [] as string[], note: undefined, evidenceLevel: 'weak' as const, source: 'fallback' as const })))
    : []
  
  const artistItems = profile
    ? (display?.artistItems?.length ? display.artistItems : profile.artists.map((artist) => ({ name: artist.name, affinity: artist.affinity, note: artist.notes ?? '还在观察', evidenceLevel: 'weak' as const, source: 'fallback' as const })))
    : []

  const artistNamesSet = new Set(artistItems.map(a => a.name.trim().toLowerCase()))
  const explicitArtistsSet = new Set([
    '王菲', '林俊杰', '周杰伦', 'bruno mars', 'charlie puth', '蔡健雅', '海洋bo', 'justin bieber', 'taylor swift', 'adele', 'eason chan', '陈奕迅', '孙燕姿', '张杰', '邓紫棋'
  ])

  const genreItemsFiltered = genreItems.filter((genre) => {
    const nameLower = genre.name.trim().toLowerCase()
    if (artistNamesSet.has(nameLower)) return false
    if (explicitArtistsSet.has(nameLower)) return false
    return true
  })
  
  const moodItems = profile
    ? (display?.moodItems?.length ? display.moodItems : profile.moods.slice(0, 6).map((mood) => ({ tag: mood.tag, frequency: mood.frequency, evidenceLevel: 'weak' as const, source: 'fallback' as const })))
    : []

  const refreshMemoryAudit = useCallback(async () => {
    try {
      setMemoryAudit(await echo.taste.getMemoryAudit())
    } catch {
      setMemoryAudit(null)
    }
  }, [echo])

  useEffect(() => {
    void refreshMemoryAudit()
  }, [refreshMemoryAudit, profile?.profile_meta?.updatedAt, profile?.profile_meta?.structuredUpdatedAt])

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

  async function regenerate() {
    setBusy(true)
    clearStatus()
    setPhase('out')
    await sleep(400)
    if (!mountedRef.current) return

    setPhase('loading')

    try {
      await echo.taste.regeneratePortrait()
      try {
        await refreshProfile()
        await refreshMemoryAudit()
      } catch {
        // Safe catch
      }
      if (!mountedRef.current) return
      setPhase('in')
      await sleep(400)
      if (!mountedRef.current) return
      setPhase('idle')
      showStatus('success', '已刷新', 2000)
    } catch (error) {
      if (!mountedRef.current) return
      setPhase('in')
      await sleep(400)
      if (!mountedRef.current) return
      setPhase('idle')
      showStatus('error', error instanceof Error ? error.message : '画像刷新失败')
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
      showStatus('error', error instanceof Error ? error.message : '播放失败', 3000)
    } finally {
      if (playingKeyRef.current === key) setPlayingKey('')
    }
  }



  // Persistent Player Handlers
  const isPlaying = localPlaybackState?.status === 'playing'
  const currentTrack = localPlaybackState?.current
  const togglePlayback = async () => {
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

  // Highlight artist and genre clue evidence triggers
  const triggerClueEvidence = (term: string) => {
    const matchedArtist = artistItems.find(a => term.toLowerCase().includes(a.name.toLowerCase()))
    const matchedGenre = genreItems.find(g => term.toLowerCase().includes(g.name.toLowerCase()))

    if (matchedArtist) {
      showStatus('success', `证据线索：${matchedArtist.name} · ${matchedArtist.note ?? '听歌积累的品味碎片'}`, 4000)
    } else if (matchedGenre) {
      showStatus('success', `流派偏好：${matchedGenre.name} · ${matchedGenre.note ?? '你歌单中的主流底色'}`, 4000)
    } else {
      showStatus('success', `Echo 听音洞察：来自你的日常音乐互动证据。`, 3000)
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
        await refreshMemoryAudit()
      } else {
        showStatus('error', result.message, 3000)
      }
    } catch (error) {
      showStatus('error', error instanceof Error ? error.message : '纠正保存失败', 3000)
    } finally {
      if (mountedRef.current) setCorrectionSaving(false)
    }
  }

  // Interactive Era Quotes
  const ERA_QUOTES: Record<string, string> = {
    '80s': '金色的八十年代。经典的实体唱片，厚重的合成器与温暖的吉他SOLO。这部分声音在你这里像一处秘密避难所，偶尔来，但每次来都极其专注。',
    '90s': '黄金九十年代。华语流行的鼎盛时期，纯粹的词曲与深情的编曲。它们构成了你听音品味的坚实基底，每当你需要寻找某种旋律感时，它总能接住你。',
    '00s': '千禧新纪元。R&B、新流行乐与乐团黄金时代的交汇。那些你在清晨或者久别重逢时反复回听的旋律，都藏在这条频段里。',
    '10s': '数字洪流时代。独立乐团、城市民谣与精细制作的流行乐。这是你最熟悉的背景音，也是你深夜循环最多的治愈能量来源。',
    '20s': '当下频段。短视频时代的冲击、K-pop 白天电池与新锐说唱。高电量、快节奏，是你白天工作和通勤时最强劲的推进器。'
  }

  const tunerNeedleLefts: Record<string, string> = {
    '80s': '10%',
    '90s': '30%',
    '00s': '50%',
    '10s': '70%',
    '20s': '90%'
  }

  // Filter Signature tracks by click choices
  const filteredSignatureDisplay = signatureDisplay.filter((item) => {
    if (activeMoodFilter === 'all') return true
    return (
      (item.track.profileEvidence?.moods?.includes(activeMoodFilter)) ||
      (item.track.semantic?.moods?.includes(activeMoodFilter)) ||
      (item.note?.includes(activeMoodFilter)) ||
      (item.track.reason?.includes(activeMoodFilter)) ||
      (stableHash(`${item.track.title}:${activeMoodFilter}`) % 3 === 0)
    )
  })

  // 32-bar visualizer heights generator using stableHash to prevent re-render mismatch
  const barsCount = 32
  const visualizerHeights = Array.from({ length: barsCount }).map((_, index) => {
    const rawHash = stableHash(`${profile?.echo_portrait ?? ''}:${index}`)
    return 20 + (rawHash % 71) // 20% to 90% range
  })

  // Segments calculate for 30 bars Bottom Seeker HUD
  const duration = localPlaybackState?.duration ?? 180
  const position = localPlaybackState?.position ?? 0
  const percent = duration > 0 ? position / duration : 0
  const activeSegmentsCount = Math.min(30, Math.floor(percent * 30))

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
            title={profileBusy ? '我正在读你的歌单……第一遍读得慢一点,你别催。' : '我还没听过你的歌呢。你给我导一份歌单,我读一下,然后我们再正经聊。'}
            body={profileBusy ? profileTask?.message ?? '大概再等 20 秒。' : undefined}
            sign={profileBusy ? undefined : '— Echo · 等你'}
            action={!profileBusy && <button className="primary-button empty-cta" onClick={() => navigate('settings')}>导 入 歌 单</button>}
          />
        ) : (
          <>
            {/* 章 1 · Echo 画像 */}
            <Section className="portrait-section">
              <BrandLogo className={`avatar-big${profileBusy ? ' avatar-breathing' : ''}`} size={56} />
              <div className={`portrait-content ${phase}`}>
                {phase === 'idle' || phase === 'in' ? (
                  <p className="portrait-text">
                    {/* Make clue terms inside echo portrait highlightable on click */}
                    {profile.echo_portrait.split(/(，|。|、|！|？|”|“)/).map((segment, index) => {
                      // Detect key artists or genres to highlight as evidence clues
                      const cleanSegment = segment.replace(/["'「」“]/g, '').trim()
                      const hasClue = cleanSegment.length > 1 && (
                        artistItems.some(a => cleanSegment.toLowerCase().includes(a.name.toLowerCase())) ||
                        genreItems.some(g => cleanSegment.toLowerCase().includes(g.name.toLowerCase()))
                      )

                      if (hasClue) {
                        return (
                          <span 
                            key={index} 
                            className="clue-term"
                            onClick={() => triggerClueEvidence(cleanSegment)}
                          >
                            {segment}
                          </span>
                        )
                      }
                      return <span key={index}>{segment}</span>
                    })}
                  </p>
                ) : (
                  <p className="portrait-text portrait-loading">{profileTask?.message ?? '正在透过音乐看你,请稍等。'}</p>
                )}
              </div>
              <div className="portrait-sign">
                — Echo · {profileBusy ? '正在写' : (portraitUpdatedAt ? `写于 ${displayDate(portraitUpdatedAt)}` : '初次见面')}
                {status !== 'idle' && <span className={`portrait-status ${status}`}>{statusMessage}</span>}
              </div>
              <div className="portrait-correction">
                {!correctionOpen ? (
                  <button className="portrait-correction-link" type="button" onClick={() => setCorrectionOpen(true)}>
                    这段理解不准
                  </button>
                ) : (
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
                )}
              </div>
            </Section>
            <RuntimeTaskNotice task={profileTask?.status === 'running' ? profileTask : null} title="口味画像" onCancel={(id) => { void echo.runtime.cancelTask(id) }} />

            {/* 章 2 · 记忆审计 (MEMORY AUDIT) */}
            {memoryAudit && memoryAudit.items.length > 0 && (
              <Section label="M E M O R Y">
                <div className="memory-audit-head" style={{ display: 'flex', justifyContent: 'space-between', fontSize: '11px', fontFamily: 'var(--font-mono)', color: 'var(--text-secondary)', marginBottom: '8px' }}>
                  <span>{memoryAudit.items.length} 条关键记忆</span>
                  <span>纠正 {memoryAudit.counts.corrections} · 收藏 {memoryAudit.counts.favorites}</span>
                </div>
                <div className="memory-audit-list" style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
                  {memoryAudit.items.slice(0, 3).map((item) => (
                    <div className={`memory-audit-item memory-${item.kind}`} key={item.id} style={{ display: 'flex', gap: '10px', padding: '8px 10px', backgroundColor: 'var(--bg-secondary)', borderRadius: 'var(--radius-md)', border: '0.5px solid var(--border)' }}>
                      <span className="memory-audit-label" style={{ fontFamily: 'var(--font-mono)', fontSize: '9px', padding: '2px 6px', borderRadius: '4px', backgroundColor: item.kind === 'correction' ? '#FFF2F2' : 'var(--ayin-green-100)', color: item.kind === 'correction' ? '#B86B3E' : 'var(--ayin-green-900)', height: 'fit-content' }}>
                        {item.label}
                      </span>
                      <div className="memory-audit-body" style={{ flex: 1, minWidth: 0, textAlign: 'left' }}>
                        <div className="memory-audit-title" style={{ fontWeight: 500, fontSize: '12px' }}>{item.title}</div>
                        {item.detail && <div className="memory-audit-detail" style={{ fontSize: '10.5px', color: 'var(--text-secondary)', marginTop: '2px' }}>{item.detail}</div>}
                      </div>
                      {item.createdAt && <time className="memory-audit-date" style={{ fontFamily: 'var(--font-mono)', fontSize: '9px', color: 'var(--text-tertiary)' }}>{displayAuditDate(item.createdAt)}</time>}
                    </div>
                  ))}
                </div>
              </Section>
            )}

            {/* 章 3 · 收音机年代仪 (ERA TRAVEL) */}
            {profile.era_preference && Object.keys(profile.era_preference).length > 0 && (
              <Section label="E R A   T R A V E L">
                <div className="tuner-dial">
                  <div className="tuner-needle" style={{ left: tunerNeedleLefts[tunerActiveEra] ?? '50%' }} />
                  <div className="tuner-scale">
                    {['80s', '90s', '00s', '10s', '20s'].map((era) => {
                      const isLong = era === '80s' || era === '90s' || era === '00s' || era === '10s' || era === '20s'
                      const isSelected = tunerActiveEra === era
                      return (
                        <div 
                          key={era} 
                          className={`tuner-tick ${isLong ? 'long-tick' : ''} ${isSelected ? 'active' : ''}`}
                          onClick={() => setTunerActiveEra(era)}
                        >
                          <span className="tuner-tick-label">{era}</span>
                        </div>
                      )
                    })}
                  </div>
                </div>
                <div className="tuner-meta">
                  <span>频段对焦：<span className="tuner-meta-highlight">{tunerActiveEra}</span></span>
                  <span>偏好占比：<span className="tuner-meta-highlight">{asPercent(profile.era_preference?.[tunerActiveEra] ?? 0)}%</span></span>
                </div>
                <p className="tuner-quote">{ERA_QUOTES[tunerActiveEra] ?? '聚焦在时空频段中，读取你的音乐基因线索。'}</p>
              </Section>
            )}

            {/* 章 4 · 音乐能量与心律波 (ENERGY & TEMPO) */}
            <Section label="E N E R G Y   &   T E M P O">
              <div className="energy-row">
                <div 
                  className="battery-container" 
                  onClick={() => setShowEnergyDetails(prev => !prev)}
                  title="点击查看电量与心律分析"
                >
                  <div className="battery-fill" style={{ width: `${asPercent(profile.energy_preference ?? 0.68)}%` }} />
                </div>
                <p className="energy-desc">
                  当前听音蓄能值达到 <strong style={{ color: 'var(--ayin-green-700)' }}>{asPercent(profile.energy_preference ?? 0.68)}%</strong>。
                  {profile.tempo_preference?.fast && profile.tempo_preference.fast > 0.4 
                    ? '最近偏好快节奏强律动，为白天充满活力电量！' 
                    : '偏好温和沉静的中慢速旋律，让身心处于充电和放松状态。'}
                </p>
              </div>

              {showEnergyDetails && (
                <div className="energy-dropdown">
                  <div className="energy-drop-item">
                    <span>日常音乐蓄电量 (Energy)</span>
                    <span className="energy-drop-val">{asPercent(profile.energy_preference ?? 0.68)}%</span>
                  </div>
                  {profile.tempo_preference && (
                    <>
                      <div className="energy-drop-item">
                        <span>慢速舒缓频率 (Slow Tempo)</span>
                        <span className="energy-drop-val">{asPercent(profile.tempo_preference.slow)}%</span>
                      </div>
                      <div className="energy-drop-item">
                        <span>中速舒缓平衡 (Medium Tempo)</span>
                        <span className="energy-drop-val">{asPercent(profile.tempo_preference.medium)}%</span>
                      </div>
                      <div className="energy-drop-item">
                        <span>快速元气律动 (Fast Tempo)</span>
                        <span className="energy-drop-val">{asPercent(profile.tempo_preference.fast)}%</span>
                      </div>
                    </>
                  )}
                  <div className="energy-drop-item" style={{ borderTop: '0.5px dashed var(--border)', paddingTop: '4px', marginTop: '4px' }}>
                    <span>日常探索欲望 (Discovery)</span>
                    <span className="energy-drop-val">{asPercent(profile.discovery_appetite ?? 0.5)}%</span>
                  </div>
                </div>
              )}

              {/* 32-bar visualizer waves compliant with tokens.md */}
              <div className="rhythm-waves">
                {visualizerHeights.map((h, idx) => (
                  <div 
                    key={idx} 
                    className="rhythm-bar" 
                    style={{ height: `${h}%` }} 
                  />
                ))}
              </div>
            </Section>

            {/* 章 5 · 避雷过滤器拦截盾 (ACOUSTIC SHIELD) */}
            {profile.anti_patterns && profile.anti_patterns.length > 0 && (
              <Section label="A C O U S T I C   S H I E L D">
                <div className="shield-card">
                  <div className="shield-header">
                    <span>SHIELD DEFENSE ACTIVE</span>
                    <span>已拦截 {profile.anti_patterns.length} 个避雷信号</span>
                  </div>
                  <div className="shield-tags">
                    {profile.anti_patterns.slice(0, 3).map((term, index) => {
                      const isSongSkip = term.startsWith('跳过:')
                      const displayTerm = isSongSkip ? term.replace('跳过:', '切歌 · ') : `踩雷 · ${term}`
                      return (
                        <span key={index} className="shield-tag" title={isSongSkip ? '这首歌被你高频切过，Echo 自动将它移出推荐' : '你在聊天中标记过不喜欢该艺人'}>
                          {displayTerm}
                        </span>
                      )
                    })}
                  </div>
                </div>
              </Section>
            )}



            {/* 章 7 · 代表作 7 首 (SIGNATURE 7) */}
            <Section label={activeMoodFilter === 'all' ? "S I G N A T U R E   ·   7" : `F I L T E R E D   ·   ${activeMoodFilter.toUpperCase()}`}>
              <div className="signature-list">
                {filteredSignatureDisplay.length === 0 ? (
                  <p style={{ fontSize: '12px', color: 'var(--text-tertiary)', padding: '16px 0', textAlign: 'center', fontStyle: 'italic' }}>
                    在这个情绪切片下，还没有收集到契合的歌曲。
                  </p>
                ) : (
                  filteredSignatureDisplay.map((item, index) => {
                    const trackKeyStr = `${item.track.id ?? item.track.neteaseId ?? ''}:${item.track.title}:${item.track.artist}`
                    const isExpanded = activeLoopTimelineId === trackKeyStr
                    const isTrackPlayingNow = currentTrack && `${currentTrack.id ?? currentTrack.neteaseId ?? ''}:${currentTrack.title}:${currentTrack.artist}` === trackKeyStr

                    return (
                      <div className={`sig-track ${isTrackPlayingNow ? 'playing' : ''}`} key={`${item.track.title}-${index}`}>
                        <div className="sig-track-main">
                          <div className="sig-num">{String(index + 1).padStart(2, '0')}</div>
                          <div className="sig-track-body">
                            <div className="sig-title">{item.track.title}</div>
                            <div className="sig-meta">{item.track.artist}{item.track.year ? ` · ${item.track.year}` : ''}</div>
                            
                            {/* Make reason line clickable to expand memory timeline */}
                            <button 
                              className="sig-reason-btn"
                              title="点击查看行为记忆时空轴"
                              onClick={() => setActiveLoopTimelineId(isExpanded ? null : trackKeyStr)}
                            >
                              — {item.displayNote}
                            </button>
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

                        {/* Inline sub-timeline loop memory details */}
                        {isExpanded && (
                          <div className="sig-loop-timeline">
                            <div className="loop-milestone-row" style={{ display: 'flex', justifyContent: 'space-between', width: '100%', alignItems: 'center' }}>
                              <span style={{ fontWeight: 600, color: 'var(--ayin-green-900)' }}>触发原因：{item.source === 'favorite' ? '主动偏好收藏' : item.source === 'loop' ? '高频重播循环' : '完整耐受聆听'}</span>
                              <span className="loop-time-stamp" style={{ marginLeft: '12px', flexShrink: 0 }}>{displayDate(portraitUpdatedAt ?? new Date().toISOString())}</span>
                            </div>
                            <p style={{ marginTop: '2px', lineHeight: '1.4' }}>
                              {item.source === 'favorite' && '你曾主动为它亮起红心，这首会被我珍重地放在偏好前排，在未来的日常 FM 中也更容易听到。'}
                              {item.source === 'loop' && `你在24小时内连续回头循环了这首歌，像一条闭眼都能走熟的林间小路，带着很强的依赖感。`}
                              {item.source === 'played' && '你没有跳过这首歌哪怕一秒钟。你的耳朵通过了它的前奏，在数字噪音时代，这份耐心极其难得。'}
                              {item.source === 'scene' && '你在特定的专注场景里接上过它，它成为了你那一刻必不可少的背景隔音板。'}
                              {(item.source === 'imported' || item.source === 'fallback') && '这首来自你首次导入的歌单深处，是形成你早期口味特征的最初锚点之一。'}
                            </p>
                          </div>
                        )}
                      </div>
                    )
                  })
                )}
              </div>
            </Section>

            {/* 章 8 · 爱听流派 (GENRE) */}
            {genreItemsFiltered.length > 0 && (
              <Section label="G E N R E">
                {genreItemsFiltered.slice(0, 5).map((genre) => (
                  <div className={`genre-row evidence-${genre.evidenceLevel}`} key={genre.name}>
                    <div className="genre-head">
                      <span className="genre-name">{genre.name}</span>
                      <span className={genre.trend === 'up' ? 'genre-trend trend-up' : genre.trend === 'down' ? 'genre-trend trend-down' : 'genre-trend trend-steady'}>
                        {genre.trend === 'up' ? '↑' : genre.trend === 'down' ? '↓' : '·'} {asPercent(genre.weight)}%
                      </span>
                    </div>
                    <div className="genre-bar-bg">
                      <div className="genre-bar-fill" style={{ width: `${asPercent(genre.weight)}%` }} />
                    </div>
                    {genre.note && <div className="genre-note">{genre.note}</div>}
                    {genre.representativeArtists.length > 0 && (
                      <div className="genre-chips">
                        {genre.representativeArtists.map((artist) => <span className="genre-chip" key={`${genre.name}-${artist}`}>{artist}</span>)}
                      </div>
                    )}
                  </div>
                ))}
              </Section>
            )}

            {/* 章 9 · 钟爱艺人 (ARTISTS) */}
            {artistItems.length > 0 && (
              <Section label="A R T I S T S">
                <div className="artist-list">
                  {artistItems.slice(0, 7).map((artist, index) => (
                    <div className={`artist-item evidence-${artist.evidenceLevel}`} key={artist.name}>
                      <span className="artist-rank">{String(index + 1).padStart(2, '0')}</span>
                      <div className="artist-name">
                        {artist.name}
                        <small>{artist.note ?? '还在观察'}</small>
                      </div>
                      <div className="affinity-bar">
                        <span className="affinity-fill" style={{ width: `${asPercent(artist.affinity)}%` }} />
                      </div>
                    </div>
                  ))}
                </div>
              </Section>
            )}

            {/* 章 6 · 情绪流过滤 (MOOD) */}
            {moodItems.length > 0 && (
              <Section label="M O O D">
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
              </Section>
            )}

            <footer className="page-foot" style={{ paddingBottom: '32px' }}>
              {portraitUpdatedAt
                ? `画像上次更新 · ${displayDate(portraitUpdatedAt)}`
                : '画像 · 尚未生成'}
              {profile.profile_meta?.structuredUpdatedAt && profile.profile_meta.structuredUpdatedAt !== portraitUpdatedAt &&
                ` · 结构刷新 ${displayDate(profile.profile_meta.structuredUpdatedAt)}`}
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
