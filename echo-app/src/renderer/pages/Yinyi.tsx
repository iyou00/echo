import { useCallback, useEffect, useRef, useState } from 'react'
import type { EchoApi, YinyiEntry } from '../../types/ipc'
import type { AppPageProps } from '../../App'
import { BrandLogo, EmptyState } from '../components'
import { pageLabels } from '../labels'

interface YinyiPageProps extends AppPageProps {
  echo: EchoApi
  isActive: boolean
  openWithRandom: boolean
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

export function YinyiPage({ echo, isActive, openWithRandom }: YinyiPageProps) {
  const [date, setDate] = useState(isoDate())
  const [entry, setEntry] = useState<YinyiEntry | null>(null)
  const [range, setRange] = useState<YinyiEntry[]>([])
  const [loading, setLoading] = useState(false)
  const dateInputRef = useRef<HTMLInputElement | null>(null)
  const wasActiveRef = useRef(false)

  const load = useCallback(async (target = date) => {
    setLoading(true)
    try {
      const [nextEntry, nextRange] = await Promise.all([echo.yinyi.getByDate(target), echo.yinyi.getRange(30)])
      setEntry(nextEntry)
      setRange(nextRange)
    } finally {
      setLoading(false)
    }
  }, [date, echo])

  useEffect(() => {
    load(date)
  }, [date, load])

  useEffect(() => {
    return echo.yinyi.onGenerated((payload) => {
      if (payload.date === date) load(date)
      else echo.yinyi.getRange(30).then(setRange).catch(() => undefined)
    })
  }, [echo, date, load])

  async function generate() {
    setLoading(true)
    try {
      const next = await echo.yinyi.generate(date)
      setEntry(next)
      setRange(await echo.yinyi.getRange(30))
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
    if (!becameActive || !openWithRandom) return
    randomEntry().catch(() => undefined)
  }, [isActive, openWithRandom, randomEntry])

  function shift(days: number) {
    setDate(isoDate(days, new Date(date)))
  }

  function renderEntry() {
    if (loading) return <div className="quiet-line">Echo 正在翻日记本...</div>

    if (entry?.meta?.status === 'failed') {
      return (
        <EmptyState
          icon="…"
          title={`那天的${pageLabels.yinyi}我没写好。\n可能是我那时候走神了。\n要不你让我重写一次?`}
          body={entry.meta.error}
          action={<button className="primary-button empty-cta" onClick={generate}>重 新 生 成</button>}
          sign="— E C H O"
        />
      )
    }

    if (entry?.meta?.status === 'absent') {
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
          <button className="tb-btn" onClick={generate} disabled={loading}>生 成</button>
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
