import { useCallback, useEffect, useRef, useState } from 'react'
import type { EchoApi, RuntimeTaskSnapshot, UiBoundarySnapshot, YinyiEntry } from '../../types/ipc'
import type { AppPageProps } from '../appState'
import { BrandLogo, EmptyState } from '../components'
import { latestRunningRuntimeTask, useRuntimeTasks } from '../hooks/useRuntimeTasks'
import { pageLabels } from '../labels'
import { friendlyOperationError } from '../../shared/runtimeRecovery'
import { BoundaryState } from '../components/BoundaryState'
import { MeetingCanvas } from '../components/MeetingCanvas'
import { yinyiArrivalDuration } from './yinyiArrival'

interface YinyiPageProps extends AppPageProps {
  echo: EchoApi
  isActive: boolean
  openWithRandom: boolean
  boundary?: UiBoundarySnapshot
  arrivalDate?: string | null
  onArrivalSeen?: () => void
}

function isoDate(offset = 0, base = new Date()) {
  const date = new Date(base)
  date.setDate(date.getDate() + offset)
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function spacedDate(date: string) {
  return date.replace(/-/g, ' . ').split('').join(' ')
}

function YinyiArrival({ date, onDone }: { date: string; onDone: () => void }) {
  const [leaving, setLeaving] = useState(false)
  const [reducedMotion] = useState(() => window.matchMedia('(prefers-reduced-motion: reduce)').matches)
  const durationMs = yinyiArrivalDuration(reducedMotion)
  const doneRef = useRef(false)

  const fadeTimerRef = useRef<number | null>(null)

  useEffect(() => () => {
    if (fadeTimerRef.current !== null) window.clearTimeout(fadeTimerRef.current)
  }, [])

  const finish = useCallback(() => {
    if (doneRef.current) return
    doneRef.current = true
    setLeaving(true)
    fadeTimerRef.current = window.setTimeout(onDone, 320)
  }, [onDone])

  useEffect(() => {
    if (durationMs === 0) finish()
  }, [durationMs, finish])

  return (
    <div className={leaving ? 'yinyi-arrival leaving' : 'yinyi-arrival'} role="status" aria-label={`新的${pageLabels.yinyi}到了`}>
      <MeetingCanvas durationMs={Math.max(1, durationMs)} onComplete={durationMs === 0 ? undefined : finish} className="yinyi-arrival-field" />
      <div className="yinyi-arrival-copy">
        <span>ECHO · 新的{pageLabels.yinyi}</span>
        <strong>{spacedDate(date)}</strong>
      </div>
    </div>
  )
}

function YinyiWritingState({
  task,
  onCancel,
}: {
  task: RuntimeTaskSnapshot | null
  onCancel: (id: string) => void
}) {
  return (
    <div className="d2-yinyi-writing" aria-live="polite">
      <span className="d2-yinyi-writing-kicker">ECHO · 正在写</span>
      <div className="d2-yinyi-writing-lines" aria-hidden="true">
        <i />
        <i style={{ animationDelay: '160ms' }} />
        <i style={{ animationDelay: '320ms' }} />
        <i className="short" style={{ animationDelay: '480ms' }} />
      </div>
      <p>稍等一下。</p>
      {task?.cancellable && (
        <button className="d2-yinyi-writing-cancel" type="button" onClick={() => onCancel(task.id)}>
          停 下
        </button>
      )}
    </div>
  )
}

export function YinyiPage({ echo, isActive, openWithRandom, boundary, arrivalDate, onArrivalSeen }: YinyiPageProps) {
  const [date, setDate] = useState(isoDate())
  const [entry, setEntry] = useState<YinyiEntry | null>(null)
  const [range, setRange] = useState<YinyiEntry[]>([])
  const [loading, setLoading] = useState(false)
  const [notice, setNotice] = useState('')
  const dateInputRef = useRef<HTMLInputElement | null>(null)
  const wasActiveRef = useRef(false)
  const runtimeTasks = useRuntimeTasks(echo)
  const yinyiTask = latestRunningRuntimeTask(runtimeTasks, ['yinyi-generate'], { includeChildren: false })
  const yinyiGenerating = Boolean(yinyiTask)

  const load = useCallback(async (target = date) => {
    setLoading(true)
    setNotice('')
    try {
      const [nextEntry, nextRange] = await Promise.all([echo.yinyi.getByDate(target), echo.yinyi.getRange(30)])
      setEntry(nextEntry)
      setRange(nextRange)
    } finally {
      setLoading(false)
    }
  }, [date, echo])

  useEffect(() => {
    load(date).catch(() => undefined)
  }, [date, load])

  useEffect(() => {
    return echo.yinyi.onGenerated((payload) => {
      if (payload.date === date) load(date).catch(() => undefined)
      else echo.yinyi.getRange(30).then(setRange).catch(() => undefined)
    })
  }, [echo, date, load])

  async function generate() {
    setLoading(true)
    setNotice('')
    try {
      const next = await echo.yinyi.generate(date)
      setEntry(next)
      setRange(await echo.yinyi.getRange(30))
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      setNotice(
        /未来/.test(message)
          ? '那一天还没到，等它发生以后我再写。'
          : friendlyOperationError(error, '这封信刚才没写出来，稍后再试一次。'),
      )
    } finally {
      setLoading(false)
    }
  }

  const randomEntry = useCallback(async () => {
    const next = await echo.yinyi.getRandom()
    if (next) {
      setDate(next.date)
      setEntry(next)
    }
  }, [echo])

  useEffect(() => {
    if (arrivalDate) setDate(arrivalDate)
  }, [arrivalDate])

  useEffect(() => {
    const becameActive = isActive && !wasActiveRef.current
    wasActiveRef.current = isActive
    if (!becameActive || !openWithRandom || arrivalDate) return
    randomEntry().catch(() => undefined)
  }, [isActive, openWithRandom, randomEntry, arrivalDate])

  function shift(days: number) {
    setDate(isoDate(days, new Date(date)))
  }

  function renderEntry() {
    if (yinyiGenerating) {
      return (
        <YinyiWritingState
          task={yinyiTask}
          onCancel={(id) => { void echo.runtime.cancelTask(id) }}
        />
      )
    }

    if (loading) return <div className="quiet-line">Echo 正在翻日记本...</div>
    if (notice) return <div className="quiet-line">{notice}</div>

    if (entry?.meta?.status === 'failed') {
      if (entry.boundary) return <BoundaryState snapshot={entry.boundary} onAction={generate} />
      return (
        <EmptyState
          icon="…"
          title={`那天的${pageLabels.yinyi}我没写好。\n可能是我那时候走神了。\n要不你让我重写一次?`}
          action={<button className="primary-button empty-cta" onClick={generate}>重 新 生 成</button>}
          sign="— E C H O"
        />
      )
    }

    if (entry?.meta?.status === 'absent') {
      if (entry.boundary) return <BoundaryState snapshot={entry.boundary} onAction={generate} />
      return (
        <EmptyState
          muted
          title="那天我们没见。我等了你一会儿。"
          sign="— E C H O"
        />
      )
    }

    if (entry) {
      const paragraphs = entry.content.split(/\n+/).map((item) => item.trim()).filter(Boolean)
      const headline = paragraphs.length > 1 && paragraphs[0].length <= 30 ? paragraphs[0] : null
      const body = headline ? paragraphs.slice(1) : paragraphs
      return (
        <>
          {headline && <h2>{headline}</h2>}
          {body.map((paragraph, index) => (
            <p key={index}>{paragraph}</p>
          ))}
          <div className="d2-yinyi-sign">Echo · 写于 {entry.date}</div>
        </>
      )
    }

    if (range.length === 0) {
      if (boundary) return <BoundaryState snapshot={boundary} onAction={generate} />
      return (
        <EmptyState
          icon={<BrandLogo className="empty-logo" size={56} />}
          title={`我还没给你写过${pageLabels.yinyi}。\n每天 22 点我会坐下来记录关于你的一些小观察。\n今晚见面。`}
          body="(在设置里可以改时间)"
          sign="— E C H O"
        />
      )
    }

    return (
      <EmptyState
        muted
        title="那天我们没见。我等了你一会儿。"
        action={date === isoDate() ? <button className="primary-button empty-cta" onClick={generate}>生成这一篇</button> : undefined}
        sign="— E C H O"
      />
    )
  }

  const letterIndex = range.findIndex((item) => item.date === date) + 1
  const playedTracks = entry?.meta?.tracks ?? []
  const dismissedCount = entry?.meta?.dismissed_tracks?.length ?? 0

  return (
    <div className="d2-yinyi">
      {arrivalDate && (
        <YinyiArrival date={arrivalDate} onDone={() => onArrivalSeen?.()} />
      )}

      <div className="d2-yinyi-date">
        {spacedDate(date)} · {letterIndex ? `第 ${letterIndex} 封` : '还没写'}
      </div>

      <div className="d2-yinyi-layout">
        <aside className="d2-yinyi-index">
          <span>今天留下的声音</span>
          <strong>{playedTracks.length > 0 ? `${playedTracks.length} 首歌` : '一天的话不多'}</strong>
          {playedTracks.slice(0, 4).map((track) => (
            <em key={`${track.artist}-${track.title}`}>{track.artist} · {track.title}</em>
          ))}
          {dismissedCount > 0 && <em>{dismissedCount} 首被你跳过</em>}
          {!entry && !loading && !yinyiGenerating && <em>这天的记录还空着。</em>}
        </aside>

        <article className="d2-yinyi-letter" aria-label={`${pageLabels.yinyi}正文`}>
          {renderEntry()}
        </article>
      </div>

      <div className="d2-yinyi-actions">
        <button type="button" onClick={() => shift(-1)} disabled={loading || yinyiGenerating}>‹ 前一天</button>
        <button type="button" onClick={() => shift(1)} disabled={loading || yinyiGenerating || date >= isoDate()}>后一天 ›</button>
        <button type="button" onClick={() => { void randomEntry() }} disabled={loading || yinyiGenerating}>随手翻一页</button>
        <button
          type="button"
          onClick={() => {
            const input = dateInputRef.current
            if (!input) return
            if (typeof input.showPicker === 'function') input.showPicker()
            else input.focus()
          }}
        >
          选日期
        </button>
        <button type="button" onClick={generate} disabled={loading || yinyiGenerating || date > isoDate()}>
          {yinyiGenerating ? '正在写…' : '重新生成'}
        </button>
        {date !== isoDate() && (
          <button type="button" onClick={() => setDate(isoDate())}>回到今天</button>
        )}
        <input ref={dateInputRef} type="date" value={date} onChange={(event) => setDate(event.target.value)} aria-label="选择日期" />
        <span>{letterIndex ? `第 ${letterIndex} 篇 · 已陪伴 ${range.length} 天 · ` : ''}自动保存在本地</span>
      </div>
    </div>
  )
}
