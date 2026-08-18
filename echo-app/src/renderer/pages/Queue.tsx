import { useCallback, useEffect, useRef, useState } from 'react'
import type { EchoApi, PlaybackState, QueueHistoryDay, Track, UiBoundarySnapshot } from '../../types/ipc'
import type { AppPageProps } from '../appState'
import { pageLabels } from '../labels'
import { trackIdentity as trackKey } from '../../shared/trackIdentity'
import { BoundaryState } from '../components/BoundaryState'

const FAVORITE_PAGE_SIZE = 50

function formatClock(ms: number) {
  if (!Number.isFinite(ms) || ms < 0) return '0:00'
  const total = Math.floor(ms / 1000)
  const minutes = Math.floor(total / 60)
  const seconds = total % 60
  return `${minutes}:${String(seconds).padStart(2, '0')}`
}

function formatClockOfDay(value: string) {
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

function pageList(current: number, total: number): (number | '…')[] {
  if (total <= 9) return Array.from({ length: total }, (_, index) => index + 1)
  const marks = Array.from(new Set([1, total, current - 1, current, current + 1]))
    .filter((n) => n >= 1 && n <= total)
    .sort((a, b) => a - b)
  const out: (number | '…')[] = []
  let prev = 0
  for (const n of marks) {
    if (n - prev > 1) out.push('…')
    out.push(n)
    prev = n
  }
  return out
}

function asFreshPlaybackTrack(track: Track, sourceContext: NonNullable<Track['sourceContext']>): Track {
  return {
    ...track,
    sourceContext,
    agentActionId: undefined,
    agentActionItemId: undefined,
    stageContextId: undefined,
    playbackInstanceId: undefined,
  }
}

interface QueuePageProps extends AppPageProps {
  queue: Track[]
  echo: EchoApi
  playbackState: PlaybackState
  setPlaybackState: (state: PlaybackState) => void
  refreshQueue: () => Promise<Track[]>
  autoPlayNext: boolean
  updateAutoPlayNext: (value: boolean) => Promise<void>
  boundary?: UiBoundarySnapshot
}


export function QueuePage({
  queue,
  echo,
  playbackState,
  setPlaybackState,
  refreshQueue,
  navigate,
  autoPlayNext,
  updateAutoPlayNext,
  boundary,
}: QueuePageProps) {
  const [tab, setTab] = useState<'now' | 'favorites' | 'past'>('now')
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [autoPlaySaving, setAutoPlaySaving] = useState(false)
  const [history, setHistory] = useState<QueueHistoryDay[]>([])
  const [favorites, setFavoritesState] = useState<Track[]>([])
  const [favoriteTotal, setFavoriteTotal] = useState(0)
  const [favoriteKeys, setFavoriteKeys] = useState<Set<string>>(new Set())
  const [favoritesLoading, setFavoritesLoading] = useState(false)
  const [favoritePage, setFavoritePage] = useState(1)
  const [openDays, setOpenDays] = useState<Set<string>>(new Set())
  const [historySelectMode, setHistorySelectMode] = useState(false)
  const [selectedHistoryDates, setSelectedHistoryDates] = useState<Set<string>>(new Set())
  const [notice, setNotice] = useState('')
  const noticeTimerRef = useRef<number | null>(null)
  const favoritesRef = useRef<Track[]>([])
  const favoritePageRef = useRef(1)
  const currentKey = trackKey(playbackState.current)
  const queueCurrent = currentKey ? queue.find((track) => trackKey(track) === currentKey) : undefined
  const playing = queueCurrent ?? queue.find((track) => track.queueStatus === 'playing')
  const playingKey = trackKey(playing)
  const restSeen = new Set<string>()
  const rest = queue.filter((track) => {
    const key = trackKey(track)
    if (!key || key === playingKey || restSeen.has(key)) return false
    restSeen.add(key)
    return true
  })
  const playbackHistoryKey = `${trackKey(playbackState.current)}:${playbackState.status}:${playbackState.history.length}`

  useEffect(() => {
    return () => {
      if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current)
    }
  }, [])

  function showNotice(message: string) {
    setNotice(message)
    if (noticeTimerRef.current !== null) window.clearTimeout(noticeTimerRef.current)
    noticeTimerRef.current = window.setTimeout(() => {
      setNotice('')
      noticeTimerRef.current = null
    }, 4000)
  }

  function queueErrorMessage(error: unknown, fallback: string): string {
    return error instanceof Error && error.message.trim() ? error.message : fallback
  }

  async function runQueueAction(action: () => Promise<void>, fallback: string) {
    try {
      await action()
    } catch (error) {
      console.warn('[queue] action failed', error)
      showNotice(queueErrorMessage(error, fallback))
    }
  }

  const setFavoriteList = useCallback((next: Track[]) => {
    favoritesRef.current = next
    setFavoritesState(next)
  }, [])

  useEffect(() => {
    if (tab !== 'past') return
    let alive = true
    const timer = window.setTimeout(() => {
      echo.queue.history(7)
        .then((items) => {
          if (alive) setHistory(items)
        })
        .catch(() => {
          if (alive) setHistory([])
        })
    }, 250)
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [echo, playbackHistoryKey, tab])

  const refreshFavorites = useCallback(async (page?: number) => {
    const target = Math.max(1, page ?? favoritePageRef.current)
    favoritePageRef.current = target
    setFavoritePage(target)
    setFavoritesLoading(true)
    try {
      const [items, total, keys] = await Promise.all([
        echo.favorites.list({ limit: FAVORITE_PAGE_SIZE, offset: (target - 1) * FAVORITE_PAGE_SIZE }),
        echo.favorites.count(),
        echo.favorites.listKeys(),
      ])
      setFavoriteTotal(total)
      setFavoriteKeys(new Set(keys))
      const seen = new Set<string>()
      setFavoriteList(items.filter((track) => {
        const key = trackKey(track)
        if (!key || seen.has(key)) return false
        seen.add(key)
        return true
      }))
    } finally {
      setFavoritesLoading(false)
    }
  }, [echo, setFavoriteList])

  useEffect(() => {
    refreshFavorites().catch(() => {
      setFavoriteList([])
      setFavoriteTotal(0)
      setFavoriteKeys(new Set())
    })
  }, [refreshFavorites, setFavoriteList])

  useEffect(() => {
    return echo.favorites.onChanged((payload) => {
      const key = trackKey(payload.track)
      setFavoriteTotal(payload.total)
      setFavoriteKeys((current) => {
        const next = new Set(current)
        if (key) {
          if (payload.favorited) next.add(key)
          else next.delete(key)
        }
        return next
      })
      const totalPages = Math.max(1, Math.ceil(payload.total / FAVORITE_PAGE_SIZE))
      refreshFavorites(Math.min(favoritePageRef.current, totalPages)).catch((error) => {
        console.warn('[queue] refresh favorites failed', error)
      })
    })
  }, [echo, refreshFavorites])

  async function applyState(next: PlaybackState) {
    setPlaybackState(next)
    await refreshQueue()
  }

  function playbackQueueIndex(track: Track): number {
    const key = trackKey(track)
    return playbackState.queue.findIndex((item) => trackKey(item) === key)
  }

  async function removeTrack(track: Track) {
    await applyState(await echo.playback.removeTrackFromQueue(track))
  }

  async function reorder(fromIndex: number, toIndex: number) {
    if (fromIndex === toIndex) return
    const fromTrack = rest[fromIndex]
    const toTrack = rest[toIndex]
    if (!fromTrack || !toTrack) return
    const fromPlaybackIndex = playbackQueueIndex(fromTrack)
    const toPlaybackIndex = playbackQueueIndex(toTrack)
    if (fromPlaybackIndex < 0 || toPlaybackIndex < 0) return
    await applyState(await echo.playback.reorderQueue(fromPlaybackIndex, toPlaybackIndex))
  }

  async function toggleFavorite(track: Track) {
    await echo.favorites.toggle(track)
    setFavoriteTotal(await echo.favorites.count())
    setFavoriteKeys(new Set(await echo.favorites.listKeys()))
    await refreshFavorites()
  }

  async function enqueueContextAfter(track: Track, contextTracks: Track[]) {
    const current = trackKey(track)
    const currentIndex = contextTracks.findIndex((item) => trackKey(item) === current)
    const nextTracks = currentIndex >= 0 ? contextTracks.slice(currentIndex + 1) : contextTracks
    const queued = new Set<string>()
    let latestState: PlaybackState | null = null

    for (const nextTrack of nextTracks) {
      const key = trackKey(nextTrack)
      if (!key || key === current || queued.has(key)) continue
      queued.add(key)
      try {
        latestState = await echo.playback.enqueue(nextTrack)
      } catch {
        // 单首失效时继续尝试后面的歌，让连播尽量不断。
      }
    }

    if (latestState) setPlaybackState(latestState)
  }

  async function playTrackWithContext(track: Track, contextTracks: Track[], requireExistingUrl = true) {
    if (requireExistingUrl && !track.playUrl) return
    const next = await echo.playback.play(track)
    setPlaybackState(next)
    await enqueueContextAfter(track, contextTracks)
    await refreshQueue()
  }

  async function playFavorite(track: Track) {
    await playTrackWithContext(
      asFreshPlaybackTrack(track, 'favorite'),
      favorites.map((item) => asFreshPlaybackTrack(item, 'queue')),
      false,
    )
  }

  async function playHistoryTrack(track: Track, dayTracks: Track[]) {
    await playTrackWithContext(
      asFreshPlaybackTrack(track, 'history'),
      dayTracks.map((item) => asFreshPlaybackTrack(item, 'queue')),
      false,
    )
  }

  async function playNowTrack(track: Track) {
    if (!track.playUrl) return
    if (currentKey && currentKey === trackKey(track)) {
      if (playbackState.status === 'paused') await applyState(await echo.playback.resume())
      return
    }
    await playTrackWithContext(track, [playing, ...rest].filter((item): item is Track => Boolean(item)))
  }

  async function toggleAutoPlayNext() {
    if (autoPlaySaving) return
    const enabling = !autoPlayNext
    setAutoPlaySaving(true)
    try {
      await updateAutoPlayNext(enabling)
      if (enabling && playbackState.current) {
        await enqueueContextAfter(playbackState.current, [playing, ...rest].filter((item): item is Track => Boolean(item)))
        await refreshQueue()
      }
    } finally {
      setAutoPlaySaving(false)
    }
  }

  function historyStatus(track: Track): { className: string } {
    const isCurrent = playbackState.current && trackKey(playbackState.current) === trackKey(track)
    if (isCurrent && (playbackState.status === 'playing' || playbackState.status === 'loading')) {
      return { className: 'playing' }
    }
    if (isCurrent && playbackState.status === 'paused') {
      return { className: 'pending' }
    }
    const normalized = track.queueStatus === 'playing' ? 'pending' : track.queueStatus
    return { className: normalized ?? 'pending' }
  }

  async function clearQueue() {
    setPlaybackState(await echo.playback.clearQueue())
    await refreshQueue()
  }

  function toggleHistoryDate(date: string) {
    setSelectedHistoryDates((items) => {
      const next = new Set(items)
      if (next.has(date)) next.delete(date)
      else next.add(date)
      return next
    })
  }

  async function clearSelectedHistory() {
    const dates = Array.from(selectedHistoryDates)
    if (dates.length === 0) return
    const nextHistory = await echo.queue.clearHistoryDates(dates)
    setHistory(nextHistory)
    setSelectedHistoryDates(new Set())
    setHistorySelectMode(false)
    setOpenDays((items) => {
      const next = new Set(items)
      for (const date of dates) next.delete(date)
      return next
    })
  }

  function cancelHistorySelect() {
    setSelectedHistoryDates(new Set())
    setHistorySelectMode(false)
  }

  const queueListRef = useRef<HTMLDivElement>(null)
  const [codaVisible, setCodaVisible] = useState(false)

  useEffect(() => {
    if (tab !== 'now' || rest.length === 0) {
      setCodaVisible(false)
      return
    }
    const el = queueListRef.current
    if (!el || typeof ResizeObserver === 'undefined') return
    const measure = () => {
      setCodaVisible(window.innerHeight - el.getBoundingClientRect().bottom >= 240)
    }
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(el)
    window.addEventListener('resize', measure)
    return () => {
      observer.disconnect()
      window.removeEventListener('resize', measure)
    }
  }, [tab, rest.length])

  const queueCount = rest.length + (playing ? 1 : 0)
  const pastTotal = history.reduce((sum, day) => sum + day.tracks.length, 0)
  const queueEmpty = !playing && rest.length === 0 && favoriteTotal === 0
  const npProgress = playbackState.duration > 0 ? Math.min(100, (playbackState.position / playbackState.duration) * 100) : 0
  const favoriteTotalPages = Math.max(1, Math.ceil(favoriteTotal / FAVORITE_PAGE_SIZE))

  return (
    <div className="d2-queue">
      {queueEmpty ? (
        boundary
          ? <BoundaryState snapshot={boundary} onAction={() => navigate('chat')} />
          : (
            <div className="qf-empty">
              <div className="ring" aria-hidden="true">♪</div>
              <h2>{pageLabels.queue}还空着。</h2>
              <p>想听什么，对 Echo 说一声，歌会到这里排队。收藏过的歌住在「收藏」页签里。</p>
              <div className="qf-empty-cta">
                <button className="qf-btn" type="button" onClick={() => runQueueAction(async () => { await echo.chat.send('随便来一首'); navigate('chat') }, '这会儿没能起歌，稍后再试试')}>让 Echo 挑一首</button>
                <button className="qf-btn plain" type="button" onClick={() => navigate('chat')}>回到此刻</button>
              </div>
            </div>
          )
      ) : (
        <>
          <div className="qf-kicker">音 乐 与 队 列</div>
          <div className="q-titlebar">
            <h1>队列与收藏</h1>
            <div className="tools">
              <button
                className={autoPlayNext ? 'd2-toggle on' : 'd2-toggle'}
                type="button"
                role="switch"
                aria-checked={autoPlayNext}
                onClick={() => runQueueAction(toggleAutoPlayNext, '自动连播设置失败')}
                disabled={autoPlaySaving}
                title={autoPlayNext ? '当前歌播完后自动接着下一首' : '当前歌播完后停住，手动点下一首仍可播放'}
              >
                <span>自动连播</span>
                <i aria-hidden="true" />
              </button>
              {rest.length > 0 && (
                <button
                  className="qf-btn danger"
                  type="button"
                  onClick={() => runQueueAction(clearQueue, '清空队列失败')}
                  title="清空排在后面的歌，正在播放的不动"
                >
                  清空队列
                </button>
              )}
            </div>
          </div>

          {playing && (
            <div className="np-strip">
              <div className="np-cov">{playing.artworkUrl ? <img src={playing.artworkUrl} alt="" /> : null}</div>
              <div className="np-info">
                <span className="np-t">{playing.title}</span>
                <span className="np-a">{playing.artist}{playing.sceneLabel ? ` · ${playing.sceneLabel}` : ''}</span>
              </div>
              <div className="np-bar" aria-hidden="true"><i style={{ width: `${npProgress}%` }} /></div>
              <span className="np-time">{formatClock(playbackState.position)} / {formatClock(playbackState.duration)}</span>
            </div>
          )}

          {notice && <div className="d2-queue-notice" role="alert">{notice}</div>}

          <div className="q-tabs" role="tablist" aria-label="队列视图">
            <button type="button" role="tab" aria-selected={tab === 'now'} className={tab === 'now' ? 'on' : ''} onClick={() => setTab('now')}>队 列 <i>{queueCount}</i></button>
            <button type="button" role="tab" aria-selected={tab === 'favorites'} className={tab === 'favorites' ? 'on' : ''} onClick={() => setTab('favorites')}>收 藏 <i>{favoriteTotal}</i></button>
            <button type="button" role="tab" aria-selected={tab === 'past'} className={tab === 'past' ? 'on' : ''} onClick={() => setTab('past')}>听 过 <i>{pastTotal}</i></button>
          </div>

          {tab === 'now' && (
            <div ref={queueListRef}>
              {rest.map((track, index) => {
                const playbackIndex = playbackQueueIndex(track)
                const canReorderPlaybackQueue = playbackIndex >= 0
                const favorited = favoriteKeys.has(trackKey(track))
                return (
                  <div
                    className={`q-row clickable${dragIndex === index ? ' dragging' : ''}`}
                    draggable={canReorderPlaybackQueue}
                    key={`${track.title}-${index}`}
                    role="button"
                    tabIndex={0}
                    aria-label={`播放 ${track.title}`}
                    onClick={() => runQueueAction(() => playNowTrack(track), '播放失败')}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        runQueueAction(() => playNowTrack(track), '播放失败')
                      }
                    }}
                    onDragStart={() => {
                      if (canReorderPlaybackQueue) setDragIndex(index)
                    }}
                    onDragOver={(event) => {
                      if (canReorderPlaybackQueue) event.preventDefault()
                    }}
                    onDrop={() => {
                      if (dragIndex !== null && canReorderPlaybackQueue) {
                        const fromIndex = dragIndex
                        void runQueueAction(() => reorder(fromIndex, index), '队列排序失败')
                      }
                      setDragIndex(null)
                    }}
                    onDragEnd={() => setDragIndex(null)}
                  >
                    <span className="drag" aria-hidden="true" onClick={(event) => event.stopPropagation()}>⠿</span>
                    <div className="mini-cov">{track.artworkUrl ? <img src={track.artworkUrl} alt="" /> : '封面'}</div>
                    <div className="q-meta">
                      <div className="t">{track.title}</div>
                      <div className="a">{track.artist}{track.year ? ` · ${track.year}` : ''}{track.sceneLabel ? ` · ${track.sceneLabel}` : ''}{!track.playUrl ? ' · 播不出来' : ''}</div>
                    </div>
                    <div className="ops" onClick={(event) => event.stopPropagation()}>
                      <button
                        className={favorited ? 'op-i fav-on' : 'op-i'}
                        type="button"
                        title={favorited ? '取消收藏' : '收藏'}
                        onClick={() => runQueueAction(() => toggleFavorite(track), '收藏状态更新失败')}
                      >
                        ♥
                      </button>
                      <button
                        className="op-i"
                        type="button"
                        title="移除"
                        onClick={() => runQueueAction(() => removeTrack(track), '移除失败')}
                      >
                        ×
                      </button>
                    </div>
                  </div>
                )
              })}
              {codaVisible && (
                <div className="queue-coda">
                  <div className="curve">
                    <svg viewBox="0 0 380 64" fill="none" preserveAspectRatio="none">
                      <path d="M6 52 C 90 52, 120 14, 190 30 S 300 50, 374 12" stroke="#184734" strokeWidth="1.4" />
                      <path d="M6 14 C 90 14, 120 52, 190 36 S 300 16, 374 54" stroke="#e45036" strokeWidth="1.4" />
                    </svg>
                  </div>
                  <div className="line">队列短，是因为今天才刚开始。</div>
                  <div className="cap">播完这几首，自动连播会接着挑 · ECHO</div>
                </div>
              )}
            </div>
          )}

          {tab === 'favorites' && (
            favorites.length === 0 && !favoritesLoading ? (
              <p className="qf-muted">还没收藏过歌呢。在{pageLabels.chat}里听到喜欢的，点歌曲卡片右上的 ♡，我帮你留着。</p>
            ) : (
              <>
                {favoritesLoading && favorites.length === 0 && <p className="qf-muted" role="status">正在读取收藏…</p>}
                {favorites.map((track, index) => (
                  <div
                    className="q-row clickable no-drag"
                    key={`${trackKey(track)}-${index}`}
                    role="button"
                    tabIndex={0}
                    aria-label={`播放 ${track.title}`}
                    onClick={() => runQueueAction(() => playFavorite(track), '播放失败')}
                    onKeyDown={(event) => {
                      if (event.key === 'Enter' || event.key === ' ') {
                        event.preventDefault()
                        runQueueAction(() => playFavorite(track), '播放失败')
                      }
                    }}
                  >
                    <div className="mini-cov">{track.artworkUrl ? <img src={track.artworkUrl} alt="" /> : '封面'}</div>
                    <div className="q-meta">
                      <div className="t">{track.title}</div>
                      <div className="a">{track.artist}{track.album ? ` · ${track.album}` : track.year ? ` · ${track.year}` : ''}{track.sceneLabel ? ` · ${track.sceneLabel}` : ''}</div>
                    </div>
                    <div className="ops" onClick={(event) => event.stopPropagation()}>
                      <button
                        className="op-i"
                        type="button"
                        title="插到队列"
                        onClick={() => runQueueAction(async () => {
                          setPlaybackState(await echo.playback.enqueue(asFreshPlaybackTrack(track, 'favorite')))
                          await refreshQueue()
                        }, '加入队列失败')}
                      >
                        ＋
                      </button>
                      <button
                        className="op-i fav-on"
                        type="button"
                        title="取消收藏"
                        onClick={() => runQueueAction(() => toggleFavorite(track), '收藏状态更新失败')}
                      >
                        ♥
                      </button>
                    </div>
                  </div>
                ))}
                {favoriteTotalPages > 1 && (
                  <div className="pager">
                    <button
                      type="button"
                      disabled={favoritePage <= 1 || favoritesLoading}
                      onClick={() => runQueueAction(() => refreshFavorites(favoritePage - 1), '收藏加载失败')}
                      aria-label="上一页"
                    >‹</button>
                    {pageList(favoritePage, favoriteTotalPages).map((item, itemIndex) => (
                      typeof item === 'number' ? (
                        <button
                          key={item}
                          className={item === favoritePage ? 'cur' : ''}
                          type="button"
                          disabled={favoritesLoading}
                          onClick={() => runQueueAction(() => refreshFavorites(item), '收藏加载失败')}
                        >{item}</button>
                      ) : <span key={`gap-${itemIndex}`}>…</span>
                    ))}
                    <button
                      type="button"
                      disabled={favoritePage >= favoriteTotalPages || favoritesLoading}
                      onClick={() => runQueueAction(() => refreshFavorites(favoritePage + 1), '收藏加载失败')}
                      aria-label="下一页"
                    >›</button>
                    <span>共 {favoriteTotal} 首 · 每页 {FAVORITE_PAGE_SIZE}</span>
                  </div>
                )}
              </>
            )
          )}

          {tab === 'past' && (
            history.length === 0 ? (
              <p className="qf-muted">过往还空着。Echo 推荐过的歌曲会按日期收在这里，等你多听几次就会有了。</p>
            ) : (
              <>
                <div className="past-tools">
                  {!historySelectMode ? (
                    <button
                      className="past-tool-link"
                      type="button"
                      onClick={() => setHistorySelectMode(true)}
                      title={`按日期清空过往${pageLabels.queue}显示`}
                    >
                      按日期清除
                    </button>
                  ) : (
                    <>
                      <button
                        className="past-tool-link"
                        type="button"
                        onClick={() => runQueueAction(clearSelectedHistory, '清空过往失败')}
                        disabled={selectedHistoryDates.size === 0}
                        title="只清空过往页显示，不影响画像和标签"
                      >
                        清空 {selectedHistoryDates.size || ''} 天
                      </button>
                      <button className="past-tool-link" type="button" onClick={cancelHistorySelect} title="取消选择">取消</button>
                    </>
                  )}
                </div>
                {history.map((day) => {
                  const open = openDays.has(day.date)
                  const selected = selectedHistoryDates.has(day.date)
                  return (
                    <div className="qf-day" key={day.date}>
                      <div className={selected ? 'ev-group qf-day-head selected' : 'ev-group qf-day-head'}>
                        {historySelectMode && (
                          <button
                            className={selected ? 'd2-queue-check selected' : 'd2-queue-check'}
                            type="button"
                            onClick={() => toggleHistoryDate(day.date)}
                            title={selected ? '取消选择' : '选择这个日期'}
                            aria-pressed={selected}
                          >
                            {selected ? '✓' : ''}
                          </button>
                        )}
                        <button
                          className="qf-day-toggle"
                          type="button"
                          onClick={() => {
                            if (historySelectMode) {
                              toggleHistoryDate(day.date)
                              return
                            }
                            const next = new Set(openDays)
                            if (next.has(day.date)) next.delete(day.date)
                            else next.add(day.date)
                            setOpenDays(next)
                          }}
                        >
                          <span>{day.date} · {day.tracks.length} 首</span>
                          <small>{historySelectMode ? (selected ? '已选择' : '选择') : open ? '收起' : '展开'}</small>
                        </button>
                      </div>
                      {open && day.tracks.map((track, index) => {
                        const status = historyStatus(track)
                        const favorited = favoriteKeys.has(trackKey(track))
                        return (
                          <div
                            className={`past-row clickable ${status.className}`}
                            key={`${day.date}-${track.title}-${index}`}
                            role="button"
                            tabIndex={0}
                            aria-label={`再听一次 ${track.title}`}
                            onClick={() => runQueueAction(() => playHistoryTrack(track, day.tracks), '播放失败')}
                            onKeyDown={(event) => {
                              if (event.key === 'Enter' || event.key === ' ') {
                                event.preventDefault()
                                runQueueAction(() => playHistoryTrack(track, day.tracks), '播放失败')
                              }
                            }}
                          >
                            <div className="mini-cov">{track.artworkUrl ? <img src={track.artworkUrl} alt="" /> : '封面'}</div>
                            <span className="t">{track.title} · {track.artist}</span>
                            <div className="ops" onClick={(event) => event.stopPropagation()}>
                              <button
                                className="op-i"
                                type="button"
                                title="再听一次"
                                onClick={() => runQueueAction(() => playHistoryTrack(track, day.tracks), '播放失败')}
                              >
                                ↺
                              </button>
                              <button
                                className={favorited ? 'op-i fav-on' : 'op-i'}
                                type="button"
                                title={favorited ? '取消收藏' : '收藏'}
                                onClick={() => runQueueAction(() => toggleFavorite(track), '收藏状态更新失败')}
                              >
                                ♥
                              </button>
                            </div>
                            {track.recommendedAt ? <time>{formatClockOfDay(track.recommendedAt)}</time> : null}
                          </div>
                        )
                      })}
                    </div>
                  )
                })}
              </>
            )
          )}

          <footer className="d2-queue-foot">共 {tab === 'past' ? pastTotal : tab === 'favorites' ? favoriteTotal : queueCount} 首 · 由 Echo 编排</footer>
        </>
      )}
    </div>
  )
}
