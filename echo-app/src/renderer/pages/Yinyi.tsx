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

  const finish = useCallback(() => {
    if (doneRef.current) return
    doneRef.current = true
    setLeaving(true)
    window.setTimeout(onDone, 320)
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
    <div className="yinyi-writing" aria-live="polite">
      <div className="writing-ink" aria-hidden="true">
        <span />
        <span />
        <span />
      </div>
      <div className="writing-copy">
        <div className="writing-title">正在写</div>
        <div className="writing-subtitle">稍等一下。</div>
      </div>
      <div className="writing-paper" aria-hidden="true">
        <span className="writing-line wide" />
        <span className="writing-line mid" />
        <span className="writing-line long" />
        <span className="writing-line short" />
      </div>
      {task?.cancellable && (
        <button className="writing-cancel" type="button" onClick={() => onCancel(task.id)}>
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
    const becameActive = isActive && !wasActiveRef.current
    wasActiveRef.current = isActive
    if (!becameActive) return
    if (arrivalDate) {
      setDate(arrivalDate)
      return
    }
    if (!openWithRandom) return
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
      return (
        <div className="entry-body">
          {entry.content.split(/\n+/).map((paragraph, index) => (
            <p key={index}>{paragraph}</p>
          ))}
        </div>
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

  return (
    <div className="phone-surface yinyi-page">
      {arrivalDate && (
        <YinyiArrival date={arrivalDate} onDone={() => onArrivalSeen?.()} />
      )}
      <div className="page-toolbar">
        <div className="tb-status">第 {range.findIndex((item) => item.date === date) + 1 || '-'} 篇 · 已陪伴 {range.length} 天</div>
        <div className="tb-actions">
          <span className="date-picker">
            <button
              className="tb-btn icon-only"
              type="button"
              title="跳转日期"
              onClick={() => {
                const input = dateInputRef.current
                if (!input) return
                if (typeof input.showPicker === 'function') input.showPicker()
                else input.focus()
              }}
            >
              ◷
            </button>
            <input ref={dateInputRef} type="date" value={date} onChange={(event) => setDate(event.target.value)} />
          </span>
          <button className="tb-btn icon-only" onClick={randomEntry} title="随手翻一页">⤴</button>
          <button className={`tb-btn yinyi-generate-btn${yinyiGenerating ? ' writing' : ''}`} onClick={generate} disabled={loading || yinyiGenerating || date > isoDate()}>
            {yinyiGenerating ? (
              <>
                <span className="tb-pulse-dot" aria-hidden="true" />
                正在写
              </>
            ) : '生 成'}
          </button>
          <button className="tb-btn" onClick={() => setDate(isoDate())}>今 日</button>
        </div>
      </div>

      <button className="page-hot left" onClick={() => shift(-1)} title="前一天"><span className="page-arrow">‹</span></button>
      <button className="page-hot right" onClick={() => shift(1)} title="后一天"><span className="page-arrow">›</span></button>

      <div className="yinyi-scroll">
        <div className="book">
          <article className="paper-page">
            <div className="page-head">
              <span className="date-stamp">{spacedDate(date)}</span>
              <span className="date-weather">{new Date(`${date}T12:00:00`).toLocaleDateString('zh-CN', { weekday: 'short' })}</span>
            </div>

            <div className="entry">
              {renderEntry()}
            </div>

            {entry && entry.meta?.status === 'ok' && (
                <div className="entry-foot">
                <div className="sign">— E C H O</div>
                <div className="today-played">
                  <span className="today-played-label">T O D A Y &nbsp; P L A Y E D</span>
                  {(entry.meta?.tracks ?? []).slice(0, 3).map((track) => (
                    <div key={`${track.artist}-${track.title}`}><span className="t">{track.artist} · {track.title}</span></div>
                  ))}
                </div>
              </div>
            )}
          </article>
        </div>
      </div>
    </div>
  )
}
