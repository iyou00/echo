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

function formatClockOfDay(value?: string) {
  if (!value) return ''
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
  const [tab, setTab] = useState<'favorites' | 'past'>('favorites')
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [autoPlaySaving, setAutoPlaySaving] = useState(false)
  const [history, setHistory] = useState<QueueHistoryDay[]>([])
  const [favorites, setFavoritesState] = useState<Track[]>([])
  const [favoriteTotal, setFavoriteTotal] = useState(0)
  const [favoriteKeys, setFavoriteKeys] = useState<Set<string>>(new Set())
  const [favoritesLoading, setFavoritesLoading] = useState(false)
  const [favoritePage, setFavoritePage] = useState(1)
  const [openDays, setOpenDays] = useState<Set<string>>(new Set())
  const [libSearch, setLibSearch] = useState('')
  const [searchPool, setSearchPool] = useState<Track[] | null>(null)
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
    let alive = true
    const timer = window.setTimeout(() => {
      echo.queue.history(7)
        .then((items) => {
          if (!alive) return
          setHistory(items)
          setOpenDays((current) => (current.size ? current : new Set(items[0]?.date ? [items[0].date] : [])))
        })
        .catch(() => {
          if (alive) setHistory([])
        })
    }, 250)
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [echo, playbackHistoryKey])

  useEffect(() => {
    const q = libSearch.trim().toLowerCase()
    if (!q) {
      setSearchPool(null)
      return
    }
    let alive = true
    const timer = window.setTimeout(() => {
      echo.favorites.list({ limit: 200, offset: 0 })
        .then((items) => { if (alive) setSearchPool(items) })
        .catch(() => { if (alive) setSearchPool([]) })
    }, 250)
    return () => {
      alive = false
      window.clearTimeout(timer)
    }
  }, [libSearch, echo])

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

  async function clearOneDay(date: string) {
    const nextHistory = await echo.queue.clearHistoryDates([date])
    setHistory(nextHistory)
    setOpenDays((items) => {
      const next = new Set(items)
      next.delete(date)
      return next
    })
  }



  const pastTotal = history.reduce((sum, day) => sum + day.tracks.length, 0)
  const queueEmpty = !playing && rest.length === 0 && favoriteTotal === 0
  const npProgress = playbackState.duration > 0 ? Math.min(100, (playbackState.position / playbackState.duration) * 100) : 0
  const favoriteTotalPages = Math.max(1, Math.ceil(favoriteTotal / FAVORITE_PAGE_SIZE))

  const searchQuery = libSearch.trim().toLowerCase()
  const searchHits = searchPool && searchQuery
    ? searchPool.filter((track) => track.title.toLowerCase().includes(searchQuery) || track.artist.toLowerCase().includes(searchQuery))
    : null

  return (
    <div className="d2-queue">
      {queueEmpty ? (
        boundary
          ? <BoundaryState snapshot={boundary} onAction={() => navigate('chat')} />
          : (
            <div className="qf-empty">
              <div className="ring" aria-hidden="true">♪</div>
              <h2>{pageLabels.queue}还空着。</h2>
              <p>想听什么，对 Echo 说一声，歌会到这里排队。收藏过的歌住在「我的曲库」里。</p>
              <div className="qf-empty-cta">
                <button className="qf-btn" type="button" onClick={() => runQueueAction(async () => { await echo.chat.send('随便来一首'); navigate('chat') }, '这会儿没能起歌，稍后再试试')}>让 Echo 挑一首</button>
                <button className="qf-btn plain" type="button" onClick={() => navigate('chat')}>回到此刻</button>
              </div>
            </div>
          )
      ) : (
        <>
          <div className="qf-kicker">音 乐</div>

          <section className="session-card">
            <div className="session-head">
              <h1>正在排的</h1>
              <span className="session-meta">{rest.length > 0 ? `接下来 ${rest.length} 首 · 播完的自动进「听过」` : '没有排着的了'}</span>
              <div className="session-actions">
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
                    onClick={() => runQueueAction(clearQueue, '清空待播失败')}
                    title="清掉排着的歌，正在放的不动"
                  >
                    清空待播
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

            <div>
              {rest.length === 0 ? (
                <div className="queue-zone-empty">排着的都放完了。<br />想听什么，对 Echo 说一声，或去下面曲库里挑一首。</div>
              ) : (
                rest.map((track, index) => {
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
                })
              )}
            </div>
          </section>

          <div className="sub-kicker">我 的 曲 库<span className="n">· 收藏与听过</span></div>
          <div className="lib-tools">
            <div className="lib-search">
              <span aria-hidden="true">⌕</span>
              <input value={libSearch} onChange={(event) => { setLibSearch(event.target.value); if (event.target.value.trim()) setTab('favorites') }} placeholder="搜歌名 / 歌手…" maxLength={40} />
            </div>
            <div className="lib-tabs" role="tablist" aria-label="曲库视图">
              <button type="button" role="tab" aria-selected={tab === 'favorites'} className={tab === 'favorites' ? 'lib-tab on' : 'lib-tab'} onClick={() => setTab('favorites')}>收 藏 <i>{favoriteTotal}</i></button>
              <button type="button" role="tab" aria-selected={tab === 'past'} className={tab === 'past' ? 'lib-tab on' : 'lib-tab'} onClick={() => setTab('past')}>听 过 <i>{pastTotal}</i></button>
            </div>
          </div>

          {tab === 'favorites' && (
            searchHits ? (
              searchHits.length === 0 ? (
                <p className="qf-muted">曲库里没有「{libSearch.trim()}」。换个别的方式叫它试试。</p>
              ) : (
                <>
                  <p className="qf-muted">匹配到 {searchHits.length} 首</p>
                  {searchHits.slice(0, 100).map((track, index) => (
                    <div className="q-row clickable no-drag" key={`${trackKey(track)}-s-${index}`} role="button" tabIndex={0} aria-label={`播放 ${track.title}`} onClick={() => runQueueAction(() => playFavorite(track), '播放失败')}
                      onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); runQueueAction(() => playFavorite(track), '播放失败') } }}>
                      <div className="mini-cov">{track.artworkUrl ? <img src={track.artworkUrl} alt="" /> : '封面'}</div>
                      <div className="q-meta">
                        <div className="t">{track.title}</div>
                        <div className="a">{track.artist}{track.album ? ` · ${track.album}` : track.year ? ` · ${track.year}` : ''}</div>
                      </div>
                      <div className="ops" onClick={(event) => event.stopPropagation()}>
                        <button className="op-i" type="button" title="插到队列" onClick={() => runQueueAction(async () => { setPlaybackState(await echo.playback.enqueue(asFreshPlaybackTrack(track, 'favorite'))); await refreshQueue() }, '加入队列失败')}>＋</button>
                        <button className="op-i fav-on" type="button" title="取消收藏" onClick={() => runQueueAction(() => toggleFavorite(track), '收藏状态更新失败')}>♥</button>
                      </div>
                    </div>
                  ))}
                </>
              )
            ) : (
              favorites.length === 0 && !favoritesLoading ? (
                <p className="qf-muted">还没收藏过歌呢。在{pageLabels.chat}里听到喜欢的，点歌曲卡片右上的 ♡，我帮你留着。</p>
              ) : (
                <>
                  {favoritesLoading && favorites.length === 0 && <p className="qf-muted" role="status">正在读取收藏…</p>}
                  {favorites.map((track, index) => (
                    <div className="q-row clickable no-drag" key={`${trackKey(track)}-${index}`} role="button" tabIndex={0} aria-label={`播放 ${track.title}`} onClick={() => runQueueAction(() => playFavorite(track), '播放失败')}
                      onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); runQueueAction(() => playFavorite(track), '播放失败') } }}>
                      <div className="mini-cov">{track.artworkUrl ? <img src={track.artworkUrl} alt="" /> : '封面'}</div>
                      <div className="q-meta">
                        <div className="t">{track.title}</div>
                        <div className="a">{track.artist}{track.album ? ` · ${track.album}` : track.year ? ` · ${track.year}` : ''}{track.sceneLabel ? ` · ${track.sceneLabel}` : ''}</div>
                      </div>
                      <div className="ops" onClick={(event) => event.stopPropagation()}>
                        <button className="op-i" type="button" title="插到队列" onClick={() => runQueueAction(async () => { setPlaybackState(await echo.playback.enqueue(asFreshPlaybackTrack(track, 'favorite'))); await refreshQueue() }, '加入队列失败')}>＋</button>
                        <button className="op-i fav-on" type="button" title="取消收藏" onClick={() => runQueueAction(() => toggleFavorite(track), '收藏状态更新失败')}>♥</button>
                      </div>
                    </div>
                  ))}
                  {favoriteTotalPages > 1 && (
                    <div className="pager">
                      <button type="button" disabled={favoritePage <= 1 || favoritesLoading} onClick={() => runQueueAction(() => refreshFavorites(favoritePage - 1), '收藏加载失败')} aria-label="上一页">‹</button>
                      {pageList(favoritePage, favoriteTotalPages).map((item, itemIndex) => (
                        typeof item === 'number' ? (
                          <button key={item} className={item === favoritePage ? 'cur' : ''} type="button" disabled={favoritesLoading} onClick={() => runQueueAction(() => refreshFavorites(item), '收藏加载失败')}>{item}</button>
                        ) : <span key={`gap-${itemIndex}`}>…</span>
                      ))}
                      <button type="button" disabled={favoritePage >= favoriteTotalPages || favoritesLoading} onClick={() => runQueueAction(() => refreshFavorites(favoritePage + 1), '收藏加载失败')} aria-label="下一页">›</button>
                      <span>共 {favoriteTotal} 首 · 每页 {FAVORITE_PAGE_SIZE}</span>
                    </div>
                  )}
                </>
              )
            )
          )}

          {tab === 'past' && (
            history.length === 0 ? (
              <p className="qf-muted">最近还没有留下听过的歌。Echo 推过的会按日期收在这里。</p>
            ) : (
              history.map((day) => {
                const open = openDays.has(day.date)
                return (
                  <div className="qf-day" key={day.date}>
                    <div className="ev-group qf-day-head">
                      <button className="qf-day-toggle" type="button" onClick={() => { const next = new Set(openDays); if (next.has(day.date)) next.delete(day.date); else next.add(day.date); setOpenDays(next) }}>
                        <span>{day.date} · {day.tracks.length} 首</span>
                      </button>
                      <button className="clear-day" type="button" onClick={() => runQueueAction(() => clearOneDay(day.date), '清除失败')} title="只清掉这天的过往记录，不影响画像">清除这天</button>
                    </div>
                    {open && day.tracks.map((track, index) => {
                      const status = historyStatus(track)
                      const favorited = favoriteKeys.has(trackKey(track))
                      return (
                        <div className={`past-row clickable ${status.className}`} key={`${day.date}-${track.title}-${index}`} role="button" tabIndex={0} aria-label={`再听一次 ${track.title}`} onClick={() => runQueueAction(() => playHistoryTrack(track, day.tracks), '播放失败')}
                          onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); runQueueAction(() => playHistoryTrack(track, day.tracks), '播放失败') } }}>
                          <div className="mini-cov">{track.artworkUrl ? <img src={track.artworkUrl} alt="" /> : '封面'}</div>
                          <span className="t">{track.title} · {track.artist}</span>
                          <div className="ops" onClick={(event) => event.stopPropagation()}>
                            <button className="op-i" type="button" title="再听一次" onClick={() => runQueueAction(() => playHistoryTrack(track, day.tracks), '播放失败')}>↺</button>
                            <button className={favorited ? 'op-i fav-on' : 'op-i'} type="button" title={favorited ? '取消收藏' : '收藏'} onClick={() => runQueueAction(() => toggleFavorite(track), '收藏状态更新失败')}>♥</button>
                          </div>
                          {(track.queueStatusAt ?? track.recommendedAt) ? <time>{formatClockOfDay(track.queueStatusAt ?? track.recommendedAt)}</time> : null}
                        </div>
                      )
                    })}
                  </div>
                )
              })
            )
          )}
        </>
      )}
    </div>
  )
}
