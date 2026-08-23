import { useEffect, useRef, useState } from 'react'
import type { EchoApi, PlaybackState, TasteProfile, TasteQuestion, Track, UiBoundarySnapshot } from '../../types/ipc'
import type { AppPageProps } from '../appState'
import { latestRunningRuntimeTask, useRuntimeTasks } from '../hooks/useRuntimeTasks'
import { friendlyOperationError } from '../../shared/runtimeRecovery'
import { BoundaryState } from '../components/BoundaryState'
import {
  findPortraitClueMatch,
  profileEvidenceSourceLabel,
  profileItemIsPositiveDisplaySignal,
  profileAsPercent as asPercent,
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

function displayDateTime(value?: string) {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  const clock = date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
  if (date.toDateString() === new Date().toDateString()) return `今天 ${clock}`
  return `${date.toLocaleDateString('zh-CN')} ${clock}`
}

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)) }

function statsEvidence(profile?: TasteProfile | null): ProfileStatsEvidence | undefined {
  return profile?.profile_meta?.statsEvidence
}

function energyLabel(percent: number) {
  if (percent >= 66) return '偏高能'
  if (percent <= 38) return '偏安静'
  return '中等能量'
}

function discoveryLabel(value: number) {
  const percent = asPercent(value)
  if (percent >= 64) return '更愿意探索'
  if (percent <= 38) return '偏熟悉安全'
  return '探索适中'
}

// —— 声音指纹：五维数据驱动的五色墨团 ——
// 五瓣各自一色墨，轮廓由数值外推，噪声扰动让每次落墨独一无二。

const DIM_META = [
  { key: '语言', color: '#184734', icon: 'speech' },
  { key: '情绪', color: '#315bd6', icon: 'heart' },
  { key: '年代', color: '#8a5a2b', icon: 'clock' },
  { key: '场景', color: '#6d597a', icon: 'moon' },
  { key: '探索', color: '#e45036', icon: 'compass' },
] as const

const DIM_ICONS: Record<string, string> = {
  speech: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M4 5h16v10H9l-5 4V5z"/><path d="M8 9h8M8 12h5" stroke-linecap="round"/></svg>',
  heart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M12 20s-7-4.6-9-8.8C1.8 8 3.4 5 6.5 5c2 0 3.4 1.2 4.2 2.6L12 9l1.3-1.4C14.1 6.2 15.5 5 17.5 5c3.1 0 4.7 3 3.5 6.2C19 15.4 12 20 12 20z"/></svg>',
  clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="8.5"/><path d="M12 7v5l3.5 2" stroke-linecap="round"/></svg>',
  moon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><path d="M20 13.5A8 8 0 1 1 10.5 4 6.5 6.5 0 0 0 20 13.5z"/></svg>',
  compass: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6"><circle cx="12" cy="12" r="9"/><path d="M15.5 8.5l-2 5-5 2 2-5 5-2z"/></svg>',
}

interface FingerprintProps {
  values: number[]  // 0-1 × 5，与 DIM_META 对齐
  seed: number      // 噪声相位（画像版本驱动，每版指纹独一无二）
  hoverIdx: number  // -1 无悬停
  size?: number
}

function fingerprintPath(values: number[], seed: number, size: number, hoverIdx: number): { blob: string; wedges: string[] } {
  const cx = size / 2
  const cy = size / 2
  const n = values.length
  const SEG_PER_DIM = 8
  const total = n * SEG_PER_DIM
  const pts: Array<[number, number]> = []
  for (let i = 0; i < total; i++) {
    const seg = i / total
    const dimIdx = Math.floor(seg * n)
    const localT = seg * n - dimIdx
    const a = values[dimIdx] ?? 0.4
    const b = values[(dimIdx + 1) % n] ?? 0.4
    const blend = a * (1 - localT) + b * localT
    const baseR = size * 0.17 + blend * size * 0.19
    const angle = seg * Math.PI * 2 - Math.PI / 2
    const wob = Math.sin(seg * Math.PI * 2 * 7 + seed) * size * 0.02 + Math.sin(seg * Math.PI * 2 * 13 + seed * 1.7) * size * 0.012
    const r = baseR + wob
    pts.push([cx + Math.cos(angle) * r, cy + Math.sin(angle) * r])
  }
  let d = `M ${pts[0][0].toFixed(1)} ${pts[0][1].toFixed(1)}`
  for (let i = 0; i < pts.length; i++) {
    const p0 = pts[(i - 1 + pts.length) % pts.length]
    const p1 = pts[i]
    const p2 = pts[(i + 1) % pts.length]
    const p3 = pts[(i + 2) % pts.length]
    const c1x = p1[0] + (p2[0] - p0[0]) / 6
    const c1y = p1[1] + (p2[1] - p0[1]) / 6
    const c2x = p2[0] - (p3[0] - p1[0]) / 6
    const c2y = p2[1] - (p3[1] - p1[1]) / 6
    d += ` C ${c1x.toFixed(1)} ${c1y.toFixed(1)}, ${c2x.toFixed(1)} ${c2y.toFixed(1)}, ${p2[0].toFixed(1)} ${p2[1].toFixed(1)}`
  }
  d += ' Z'

  const rMax = size * 0.6
  const wedges: string[] = []
  for (let i = 0; i < n; i++) {
    const a0 = (i / n) * Math.PI * 2 - Math.PI / 2
    const a1 = ((i + 1) / n) * Math.PI * 2 - Math.PI / 2
    const x0 = cx + Math.cos(a0) * rMax
    const y0 = cy + Math.sin(a0) * rMax
    const x1 = cx + Math.cos(a1) * rMax
    const y1 = cy + Math.sin(a1) * rMax
    wedges.push(`<path d="M ${cx} ${cy} L ${x0.toFixed(1)} ${y0.toFixed(1)} A ${rMax} ${rMax} 0 0 1 ${x1.toFixed(1)} ${y1.toFixed(1)} Z" fill="url(#fpDim${i})" opacity="${i === hoverIdx ? 0.95 : 0.55}"/>`)
  }
  return { blob: d, wedges }
}

function SoundFingerprint({ values, seed, hoverIdx, size = 320 }: FingerprintProps) {
  const safeValues = values.length === 5 ? values : [...values, ...Array(5 - values.length).fill(0.4)]
  const { blob, wedges } = fingerprintPath(safeValues, seed, size, hoverIdx)
  const cx = size / 2
  const cy = size / 2
  const n = 5
  const gradientDefs = DIM_META.map((meta, i) =>
    `<linearGradient id="fpDim${i}" x1="0%" y1="0%" x2="100%" y2="100%"><stop offset="0%" stop-color="${meta.color}" stop-opacity="0.78"/><stop offset="100%" stop-color="${meta.color}" stop-opacity="0.38"/></linearGradient>`,
  ).join('')
  const labels = DIM_META.map((meta, i) => {
    const a = (i / n) * Math.PI * 2 - Math.PI / 2
    const lx = cx + Math.cos(a) * (size * 0.44)
    const ly = cy + Math.sin(a) * (size * 0.44)
    return `<text x="${lx.toFixed(0)}" y="${ly.toFixed(0)}" text-anchor="middle" font-size="${Math.round(size * 0.032)}" letter-spacing="2" fill="${i === hoverIdx ? '#e45036' : '#6e766f'}">${meta.key}</text>`
  }).join('')
  return (
    <svg viewBox={`0 0 ${size} ${size}`} className="fingerprint-svg" role="img" aria-label="你的声音指纹">
      <defs>
        <radialGradient id="fpInk" cx="42%" cy="38%">
          <stop offset="0%" stop-color="#243128" stop-opacity="0.85"/>
          <stop offset="100%" stop-color="#184734" stop-opacity="0.25"/>
        </radialGradient>
        {gradientDefs}
        <clipPath id="fpClip"><path d={blob} /></clipPath>
      </defs>
      <path d={blob} fill="#184734" opacity="0.10" transform={`translate(${size * 0.015},${size * 0.03}) scale(1.03) translate(${-size * 0.015},${-size * 0.024})`} />
      <g clipPath="url(#fpClip)">{wedges.map((w, i) => <g key={i} dangerouslySetInnerHTML={{ __html: w }} />)}</g>
      <path d={blob} fill="url(#fpInk)" stroke="#184734" strokeWidth="1.6" strokeOpacity="0.9" style={{ mixBlendMode: 'multiply' }} />
      {hoverIdx >= 0 && (() => {
        const a = (hoverIdx / n) * Math.PI * 2 - Math.PI / 2
        return <circle cx={cx + Math.cos(a) * size * 0.1} cy={cy + Math.sin(a) * size * 0.1} r={size * 0.016} fill="#e45036" />
      })()}
      <circle cx={cx} cy={cy} r={size * 0.009} fill="#e45036" />
      <g dangerouslySetInnerHTML={{ __html: labels }} />
    </svg>
  )
}

export function EchoProfilePage({ echo, navigate, profile, refreshProfile, boundary }: EchoProfileProps) {
  const [busy, setBusy] = useState(false)
  const [phase, setPhase] = useState<'idle' | 'loading' | 'in'>('idle')
  const statusTimerRef = useRef<ReturnType<typeof setTimeout>>()
  const mountedRef = useRef(true)
  const [status, setStatus] = useState<'idle' | 'success' | 'error'>('idle')
  const [statusMessage, setStatusMessage] = useState('')

  const [questions, setQuestions] = useState<TasteQuestion[]>([])
  const [questionSaving, setQuestionSaving] = useState(false)
  const [clueEvidence, setClueEvidence] = useState<{ title: string; detail: string; source: string } | null>(null)
  const [languageDist, setLanguageDist] = useState<Array<{ language: string; ratio: number }>>([])
  const [hoverDim, setHoverDim] = useState(-1)


  // Retained task and cancellation hook
  const runtimeTasks = useRuntimeTasks(echo)
  const profileTask = latestRunningRuntimeTask(runtimeTasks, ['taste-refresh'], { includeChildren: false })
  const profileTaskRunning = Boolean(profileTask)
  const profileBusy = busy || profileTaskRunning

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

  useEffect(() => {
    let active = true
    echo.taste.getLanguageDistribution()
      .then((items) => { if (active) setLanguageDist(items) })
      .catch(() => { if (active) setLanguageDist([]) })
    return () => { active = false }
  }, [echo, profile?.profile_meta?.structuredUpdatedAt])

  const portraitUpdatedAt = profile?.profile_meta?.portraitUpdatedAt ?? profile?.profile_meta?.updatedAt ?? profile?.profile_meta?.structuredUpdatedAt
  const display = profile?.display
  
  const genreItems = profile
    ? (display?.genreItems?.length ? display.genreItems : profile.genres.map((genre) => ({ ...genre, representativeArtists: [] as string[], note: undefined, evidenceLevel: 'weak' as const, source: 'fallback' as const })))
    : []
  
  const artistItems = profile
    ? (display?.artistItems?.length ? display.artistItems : profile.artists.map((artist) => ({ name: artist.name, affinity: artist.affinity, note: artist.notes ?? '还在观察', evidenceLevel: 'weak' as const, source: 'fallback' as const })))
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



  const moodItems = profile?.display?.moodItems?.length
    ? profile.display.moodItems.filter(profileItemIsPositiveDisplaySignal)
    : []

  const eraEntries = profile?.era_preference
    ? Object.entries(profile.era_preference)
        .filter(([, value]) => Number.isFinite(value) && value > 0)
        .sort((a, b) => b[1] - a[1])
    : []
  const topEra = eraEntries[0]
  const sceneItems = profile?.scenes?.filter((scene) => scene.tag.trim() && scene.frequency > 0).slice(0, 5) ?? []

  const energyValue = profile?.energy_preference ?? 0
  const energyPercent = asPercent(energyValue)
  const energyKnown = energyValue > 0
  const portraitPhase = profileBusy && phase === 'idle' ? 'loading' : phase

  const recentInsights = profile?.insights?.recentChanges ?? []

  // —— 指纹五维数值（0-1）：全部来自画像真实字段 ——
  const languageTop = languageDist[0]?.ratio ?? 0.4
  const moodTop = moodItems[0]?.frequency ?? 0
  const eraTop = topEra ? Math.min(1, (topEra[1] ?? 0) * 1.6) : 0
  const sceneTop = sceneItems[0] ? Math.min(1, sceneItems[0].frequency * 1.8) : 0
  const discovery = Math.min(1, Math.max(0, profile?.discovery_appetite ?? 0.5))
  const fingerprintValues = [languageTop, moodTop, eraTop, sceneTop, discovery]
  const fingerprintSeed = (portraitUpdatedAt ? Date.parse(portraitUpdatedAt) % 100 : 7) / 7
  const statEvidence = statsEvidence(profile)
  const maxTracks = Math.max(statEvidence?.importedTrackCount ?? 0, statEvidence?.semanticTrackCount ?? 0)

  const glossRows: Array<{ dim: string; main: string; sub: string; ticks: number; icon: string; idx: number }> = [
    { dim: '语 言', main: languageDist.length ? `${languageDist[0].language}为主` : '还在观察', sub: languageDist[1] ? `${languageDist[1].language}不设防` : '', ticks: Math.max(1, Math.round(languageTop * 5)), icon: DIM_ICONS.speech, idx: 0 },
    { dim: '情 绪 底 色', main: moodItems.length ? moodItems.slice(0, 2).map((mood) => mood.tag).join('、') : '还在观察', sub: energyKnown ? energyLabel(energyPercent) : '', ticks: Math.max(1, Math.round(Math.min(1, moodTop * 1.5) * 5)), icon: DIM_ICONS.heart, idx: 1 },
    { dim: '年 代 与 新 旧', main: topEra ? `${topEra[0]} 的声音最多` : '还在观察', sub: eraEntries[1] ? `也有 ${eraEntries[1][0]}` : '', ticks: Math.max(1, Math.round(eraTop * 5)), icon: DIM_ICONS.clock, idx: 2 },
    { dim: '常 去 场 景', main: sceneItems.length ? sceneItems.slice(0, 2).map((scene) => scene.tag).join('、') : '还在观察', sub: '', ticks: Math.max(1, Math.round(Math.min(1, sceneTop) * 5)), icon: DIM_ICONS.moon, idx: 3 },
    { dim: '探 索 倾 向', main: discoveryLabel(profile?.discovery_appetite ?? 0.5), sub: '', ticks: Math.max(1, Math.round(discovery * 5)), icon: DIM_ICONS.compass, idx: 4 },
  ]

  async function answerWith(id: number, answer: string) {
    if (questionSaving) return
    setQuestionSaving(true)
    try {
      await echo.taste.answerQuestion(id, answer)
      setQuestions((current) => current.filter((item) => item.id !== id))
      showStatus('success', '我记下了，这比我自己猜要准。', 2600)
      await refreshProfile()
    } catch (error) {
      showStatus('error', friendlyOperationError(error, '这次回答没有记下来。'), 3000)
    } finally {
      if (mountedRef.current) setQuestionSaving(false)
    }
  }

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
          <div className="pf-kicker">E C H O 眼 里 的 你</div>

          {/* —— 信头：指纹与主句并置 —— */}
          <div className="letterhead">
            <div className="fingerprint-wrap">
              <SoundFingerprint values={fingerprintValues} seed={fingerprintSeed} hoverIdx={hoverDim} />
              <div className="fp-caption">
                <b>你的声音指纹</b>
                {maxTracks > 0 ? ` · 由 ${maxTracks} 首歌落下` : ''}
              </div>
            </div>
            <div className="portrait-block">
              {portraitPhase === 'loading' ? (
                <div className="d2-profile-skeleton" role="status" aria-label="画像生成中">
                  <span className="long" />
                  <span className="mid" />
                  <span className="short" />
                </div>
              ) : (
                <div className="portrait-text">
                  {profile.echo_portrait.split(/(，|。|、|！|？|”|“)/).map((segment, index) => {
                    const match = findPortraitClueMatch(
                      segment,
                      artistItems.map((artist) => artist.name),
                      genreItems.map((genre) => genre.name),
                    )
                    if (match) {
                      return (
                        <button type="button" key={index} className="d2-profile-mark" onClick={() => triggerClueEvidence(segment)}>
                          {segment}
                        </button>
                      )
                    }
                    return <span key={index}>{segment}</span>
                  })}
                </div>
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

              <div className="portrait-meta">
                <span className="updated">{portraitUpdatedAt ? `画像更新于 ${displayDateTime(portraitUpdatedAt)}` : '画像 · 尚未生成'}</span>
                <div className="portrait-actions">
                  <button type="button" className="pf-btn" onClick={regenerate} disabled={profileBusy}>{profileBusy ? '正在重写…' : '重写这封信'}</button>
                </div>
              </div>
            </div>
          </div>

          {/* —— 指纹的注解 —— */}
          <div className="gloss">
            <div className="gloss-title">指 纹 的 注 解</div>
            {glossRows.map((row) => (
              <div
                className="gloss-row"
                key={row.dim}
                onMouseEnter={() => setHoverDim(row.idx)}
                onMouseLeave={() => setHoverDim(-1)}
              >
                <span className="gloss-dim">{row.dim}</span>
                <span className="gloss-main">
                  {row.main}
                  {row.sub && <span className="sub">{row.sub}</span>}
                  <span className="ticks" aria-hidden="true">
                    {Array.from({ length: 5 }, (_, t) => <i key={t} className={t < row.ticks ? 'on' : ''} />)}
                  </span>
                </span>
                <span className="dim-icon" aria-hidden="true" dangerouslySetInnerHTML={{ __html: row.icon }} />
              </div>
            ))}
          </div>

          {/* —— 这周的新线索：画像走向 —— */}
          <div className="trend-section">
            <div className="gloss-title">这 周 的 新 线 索<span className="n">· 画像正在往哪里长</span></div>
            {recentInsights.length > 0 ? recentInsights.slice(0, 4).map((insight) => (
              <div className="trend-row" key={insight.id}>
                <svg className="trend-spark" viewBox="0 0 120 36" preserveAspectRatio="none" aria-hidden="true">
                  <path
                    d={insight.direction === 'up' ? 'M2 28 C 24 26, 44 18, 62 20 S 92 12, 118 8' : 'M2 10 C 24 12, 44 20, 62 18 S 92 26, 118 28'}
                    fill="none"
                    stroke={insight.direction === 'up' ? '#184734' : '#315bd6'}
                    strokeWidth="1.6"
                  />
                  <circle cx="118" cy={insight.direction === 'up' ? 8 : 28} r="2.5" fill={insight.direction === 'up' ? '#e45036' : '#315bd6'} />
                </svg>
                <div className="trend-text">
                  <strong>{insight.statement}</strong>
                  <small>{insight.evidenceLabel}{insight.confidence === 'strong' ? ' · 很确定' : ''}</small>
                </div>
              </div>
            )) : (
              <p className="d2-profile-muted">这周还没有形成新的走向。多听几首，线索会自己浮上来。</p>
            )}
          </div>

          {/* —— Echo 还想问你的 —— */}
          {questions[0] && (
            <div className="ask-section">
              <div className="gloss-title">E C H O 还 想 问 你 的</div>
              <div className="ask-card">
                <q>{questions[0].content}</q>
                <div className="ask-actions">
                  <button type="button" className="pf-btn ask-btn" disabled={questionSaving} onClick={() => { void answerWith(questions[0].id, '是这个方向') }}>是这个方向</button>
                  <button type="button" className="pf-btn ask-btn" disabled={questionSaving} onClick={() => { void answerWith(questions[0].id, '不太对，先别这么想') }}>不太对</button>
                  <button type="button" className="pf-btn ask-btn plain" disabled={questionSaving} onClick={() => { setQuestions((current) => current.filter((item) => item.id !== questions[0].id)) }}>跳过</button>
                </div>
              </div>
            </div>
          )}
        </>
      )}
    </div>
  )
}

