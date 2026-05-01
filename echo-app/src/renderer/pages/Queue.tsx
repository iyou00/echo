import { useEffect, useState } from 'react'
import { ArrowUpToLine, Check, Heart, Play, Trash2, X } from 'lucide-react'
import type { ActiveScene, EchoApi, PlaybackState, QueueHistoryDay, Track } from '../../types/ipc'
import type { AppPageProps } from '../../App'
import { EmptyState } from '../components'
import { pageLabels } from '../labels'

interface QueuePageProps extends AppPageProps {
  queue: Track[]
  echo: EchoApi
  playbackState: PlaybackState
  setPlaybackState: (state: PlaybackState) => void
  refreshQueue: () => Promise<Track[]>
  autoPlayNext: boolean
  updateAutoPlayNext: (value: boolean) => Promise<void>
  currentScene: ActiveScene | null
  endScene: () => Promise<void>
}

function historyStatusLabel(status?: Track['queueStatus']) {
  if (status === 'completed') return '已听完'
  if (status === 'skipped') return '已切歌'
  return '可播放'
}

function trackKey(track?: Track | null): string {
  if (!track) return ''
  if (track.neteaseId) return `netease:${track.neteaseId}`
  if (track.id) return `id:${track.id}`
  return `name:${track.title.trim().toLowerCase()}::${track.artist.trim().toLowerCase()}`
}

function SceneTag({ track }: { track: Track }) {
  if (!track.sceneLabel) return null
  return <span className="q-scene-tag">{track.sceneLabel}</span>
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
  currentScene,
  endScene,
}: QueuePageProps) {
  const [tab, setTab] = useState<'now' | 'favorites' | 'past'>('now')
  const [dragIndex, setDragIndex] = useState<number | null>(null)
  const [autoPlaySaving, setAutoPlaySaving] = useState(false)
  const [history, setHistory] = useState<QueueHistoryDay[]>([])
  const [favorites, setFavorites] = useState<Track[]>([])
  const [openDays, setOpenDays] = useState<Set<string>>(new Set())
  const [historySelectMode, setHistorySelectMode] = useState(false)
  const [selectedHistoryDates, setSelectedHistoryDates] = useState<Set<string>>(new Set())
  const favoriteKeys = new Set(favorites.map(trackKey))
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
  const totalMinutes = Math.round([playing, ...rest].reduce((sum, track) => sum + (track?.durationMs ?? 0), 0) / 60000)

  useEffect(() => {
    echo.queue.history(7).then(setHistory).catch(() => setHistory([]))
  }, [echo, queue.length, playbackState.status])

  useEffect(() => {
    echo.favorites.list().then(setFavorites).catch(() => setFavorites([]))
  }, [echo, queue.length, history.length])

  async function applyState(next: PlaybackState) {
    setPlaybackState(next)
    await refreshQueue()
  }

  function playbackQueueIndex(track: Track): number {
    const key = trackKey(track)
    return playbackState.queue.findIndex((item) => trackKey(item) === key)
  }

  async function removeTrack(track: Track) {
    const index = playbackQueueIndex(track)
    if (index < 0) return
    await applyState(await echo.playback.removeFromQueue(index))
  }

  async function moveToNext(track: Track) {
    const index = playbackQueueIndex(track)
    if (index < 0) return
    await applyState(await echo.playback.reorderQueue(index, 0))
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
    const result = await echo.favorites.toggle(track)
    setFavorites(result.favorites)
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
    await playTrackWithContext(track, favorites)
  }

  async function playHistoryTrack(track: Track, dayTracks: Track[]) {
    await playTrackWithContext(track, dayTracks, false)
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

  function historyStatus(track: Track): { label: string; className: string } {
    const isCurrent = playbackState.current && trackKey(playbackState.current) === trackKey(track)
    if (isCurrent && (playbackState.status === 'playing' || playbackState.status === 'loading')) {
      return { label: '播放中', className: 'playing' }
    }
    if (isCurrent && playbackState.status === 'paused') {
      return { label: '已暂停', className: 'pending' }
    }
    const normalized = track.queueStatus === 'playing' ? 'pending' : track.queueStatus
    return { label: historyStatusLabel(normalized), className: normalized ?? 'pending' }
  }

  function nowStatus(track: Track): { label: string; className: string } {
    const isCurrent = currentKey && currentKey === trackKey(track)
    if (isCurrent && (playbackState.status === 'playing' || playbackState.status === 'loading')) {
      return { label: '播放中', className: 'playing' }
    }
    if (isCurrent && playbackState.status === 'paused') {
      return { label: '已暂停', className: 'pending' }
    }
    return { label: track.playUrl ? '可播放' : '播不出来', className: 'pending' }
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

  return (
    <div className="phone-surface queue-page">
      <div className="page-toolbar">
        <div className="tb-status">
          今日 {rest.length + (playing ? 1 : 0)} 首 · 总长 {totalMinutes || '-'} 分钟
          {currentScene && (
            <button className="queue-scene-pill" type="button" onClick={() => { void endScene() }} title="结束当前场景">
              {currentScene.label}中 · 结束
            </button>
          )}
        </div>
        <div className="tb-actions">
          {tab === 'now' && (
            <button
              className={autoPlayNext ? 'autoplay-toggle active' : 'autoplay-toggle'}
              type="button"
              role="switch"
              aria-checked={autoPlayNext}
              onClick={toggleAutoPlayNext}
              disabled={autoPlaySaving}
              title={autoPlayNext ? '当前歌播完后自动接着下一首' : '当前歌播完后停住，手动点下一首仍可播放'}
            >
              <span>自动连播</span>
              <i aria-hidden="true" />
            </button>
          )}
          {tab === 'past' && history.length > 0 && !historySelectMode && (
            <button className="tb-btn" onClick={() => setHistorySelectMode(true)} title={`按日期清空过往${pageLabels.queue}显示`}>
              清空过往
            </button>
          )}
          {tab === 'past' && historySelectMode && (
            <>
              <button className="tb-btn" onClick={clearSelectedHistory} disabled={selectedHistoryDates.size === 0} title="只清空过往页显示，不影响画像和标签">
                清空 {selectedHistoryDates.size || ''}
              </button>
              <button className="tb-btn icon-only" onClick={cancelHistorySelect} title="取消选择">
                <X size={13} />
              </button>
            </>
          )}
        </div>
      </div>

      <nav className="queue-tabs">
        <button className={tab === 'now' ? 'active' : ''} onClick={() => setTab('now')}>正在播放<span>{rest.length + (playing ? 1 : 0)}</span></button>
        <button className={tab === 'favorites' ? 'active' : ''} onClick={() => setTab('favorites')}>收藏<span>{favorites.length}</span></button>
        <button className={tab === 'past' ? 'active' : ''} onClick={() => setTab('past')}>过往<span>{history.length}</span></button>
      </nav>

      <div className="queue-scroll">
        {tab === 'now' && (!playing && rest.length === 0 ? (
          <EmptyState
            muted
            icon="♫"
            title={`${pageLabels.queue}空着——和我说点想听的?`}
            body='"放点慢的"、"我想睡了"、"来点热闹"…… 都行。'
            action={<button className="primary-button empty-cta" type="button" onClick={() => navigate('chat')}>去 {pageLabels.chat}</button>}
          />
        ) : (
          <section className="queue-section">
            <div className="queue-section-label">N O W &nbsp; P L A Y I N G</div>
            {playing && (
              <div className="now-playing">
                <div className="np-indicator"><span /><span /><span /></div>
                <div className="np-info">
                  <div className="np-title">{playing.title}</div>
                  <div className="np-meta">{playing.artist}{playing.year ? ` · ${playing.year}` : ''}</div>
                  {playing.reason && <div className="np-note">— {playing.reason}</div>}
                  <SceneTag track={playing} />
                </div>
                <div className="np-actions">
                  <button
                    className={favoriteKeys.has(trackKey(playing)) ? 'q-act-btn favorite active' : 'q-act-btn favorite'}
                    title={favoriteKeys.has(trackKey(playing)) ? '取消收藏' : '收藏'}
                    onClick={() => toggleFavorite(playing)}
                  >
                    <Heart size={13} fill={favoriteKeys.has(trackKey(playing)) ? 'currentColor' : 'none'} />
                  </button>
                  <div className={`queue-status ${nowStatus(playing).className}`} title={nowStatus(playing).label} />
                </div>
              </div>
            )}

            <div className="queue-list">
              {rest.map((track, index) => {
                const status = nowStatus(track)
                const playbackIndex = playbackQueueIndex(track)
                const canOperatePlaybackQueue = playbackIndex >= 0
                return (
                  <div
                    className={`q-item ${status.className} ${dragIndex === index ? 'dragging' : ''}`}
                    draggable={canOperatePlaybackQueue}
                    key={`${track.title}-${index}`}
                    onClick={() => playNowTrack(track)}
                    onDragStart={() => {
                      if (canOperatePlaybackQueue) setDragIndex(index)
                    }}
                    onDragOver={(event) => {
                      if (canOperatePlaybackQueue) event.preventDefault()
                    }}
                    onDrop={() => {
                      if (dragIndex !== null && canOperatePlaybackQueue) reorder(dragIndex, index)
                      setDragIndex(null)
                    }}
                    onDragEnd={() => setDragIndex(null)}
                  >
                    <span className="q-num">{String(index + 1).padStart(2, '0')}</span>
                    <span className="q-handle">⋮⋮</span>
                    <div className="q-body">
                      <div className="q-title">{track.title}</div>
                      <div className="q-meta">{track.artist}{track.year ? ` · ${track.year}` : ''}</div>
                      <SceneTag track={track} />
                      {track.reason && <div className="q-note">— {track.reason}</div>}
                    </div>
                    <div className="q-tail">
                      <div className={`queue-status ${status.className}`} title={status.label} />
                      <div className="q-actions" onClick={(event) => event.stopPropagation()}>
                        <button className="q-act-btn" title="播放" onClick={(event) => { event.stopPropagation(); void playNowTrack(track) }} disabled={!track.playUrl}>
                          <Play size={13} fill="currentColor" />
                        </button>
                        <button className={favoriteKeys.has(trackKey(track)) ? 'q-act-btn favorite active' : 'q-act-btn favorite'} title={favoriteKeys.has(trackKey(track)) ? '取消收藏' : '收藏'} onClick={(event) => { event.stopPropagation(); void toggleFavorite(track) }}>
                          <Heart size={13} fill={favoriteKeys.has(trackKey(track)) ? 'currentColor' : 'none'} />
                        </button>
                        <button className="q-act-btn" title="置顶下一首" onClick={(event) => { event.stopPropagation(); void moveToNext(track) }} disabled={!canOperatePlaybackQueue}>
                          <ArrowUpToLine size={13} />
                        </button>
                        <button className="q-act-btn" title="移除" onClick={(event) => { event.stopPropagation(); void removeTrack(track) }} disabled={!canOperatePlaybackQueue}>
                          <Trash2 size={13} />
                        </button>
                      </div>
                    </div>
                  </div>
                )
              })}
            </div>
          </section>
        ))}

        {tab === 'favorites' && (
          <section className="queue-section favorite-section">
            <div className="queue-section-label">F A V O R I T E S</div>
            {favorites.length === 0 ? (
              <EmptyState icon="♡" title="还没收藏过歌呢。" body={`在${pageLabels.chat}里听到喜欢的,点歌曲卡片右上的 ♡,我帮你留着。`} />
            ) : (
              <div className="queue-list">
                {favorites.map((track, index) => (
                  <div className="q-item favorite-item" key={`${trackKey(track)}-${index}`}>
                    <span className="q-num">{String(index + 1).padStart(2, '0')}</span>
                    <div className="q-body">
                      <div className="q-title">{track.title}</div>
                      <div className="q-meta">{track.artist}{track.year ? ` · ${track.year}` : track.album ? ` · ${track.album}` : ''}</div>
                      <SceneTag track={track} />
                      {(track.echoNote || track.reason) && <div className="q-note">— {track.echoNote ?? track.reason}</div>}
                    </div>
                    <div className="q-tail q-tail-favorite">
                      <div className="q-actions always">
                        <button className="q-act-btn" title="播放" onClick={() => playFavorite(track)} disabled={!track.playUrl}>
                          <Play size={13} fill="currentColor" />
                        </button>
                        <button className="q-act-btn favorite active" title="取消收藏" onClick={() => toggleFavorite(track)}>
                          <Heart size={13} fill="currentColor" />
                        </button>
                      </div>
                    </div>
                  </div>
                ))}
              </div>
            )}
          </section>
        )}

        {tab === 'past' && (
          <section className="queue-section past-section">
            <div className="queue-section-label">P A S T &nbsp; 7 &nbsp; D A Y S</div>
            {history.length === 0 ? (
              <EmptyState muted icon="…" title="过往还空着。" body="Echo 推荐过的歌曲会按日期收在这里，等你多听几次就会有了。" />
            ) : (
              history.map((day) => {
                const open = openDays.has(day.date)
                return (
                  <div className="history-day" key={day.date}>
                    <div className={selectedHistoryDates.has(day.date) ? 'history-head selected' : 'history-head'}>
                      {historySelectMode && (
                        <button
                          className="history-check"
                          type="button"
                          onClick={() => toggleHistoryDate(day.date)}
                          title={selectedHistoryDates.has(day.date) ? '取消选择' : '选择这个日期'}
                        >
                          {selectedHistoryDates.has(day.date) && <Check size={12} />}
                        </button>
                      )}
                      <button
                        className="history-toggle"
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
                        <span>{historySelectMode ? (selectedHistoryDates.has(day.date) ? '已选择' : '选择') : open ? '收起' : '展开'}</span>
                      </button>
                    </div>
                    {open && (
                      <div className="history-list">
                        {day.tracks.map((track, index) => (
                          (() => {
                            const status = historyStatus(track)
                            return (
                              <div className="q-item history-item" key={`${day.date}-${track.title}-${index}`}>
                                <span className="q-num">{String(index + 1).padStart(2, '0')}</span>
                                <div className="q-body">
                                  <div className="q-title">{track.title}</div>
                                  <div className="q-meta">{track.artist}{track.year ? ` · ${track.year}` : ''}</div>
                                  <SceneTag track={track} />
                                  {(track.echoNote || track.reason) && <div className="q-note">— {track.echoNote ?? track.reason}</div>}
                                </div>
                                <div className="q-tail q-tail-history">
                                  <div className={`queue-status ${status.className}`} title={status.label} />
                                  <div className="q-time">{status.label}</div>
                                  <div className="q-actions always">
                                    <button className="q-act-btn" title="播放" onClick={() => playHistoryTrack(track, day.tracks)}>
                                      <Play size={13} fill="currentColor" />
                                    </button>
                                    <button className={favoriteKeys.has(trackKey(track)) ? 'q-act-btn favorite active' : 'q-act-btn favorite'} title={favoriteKeys.has(trackKey(track)) ? '取消收藏' : '收藏'} onClick={() => toggleFavorite(track)}>
                                      <Heart size={13} fill={favoriteKeys.has(trackKey(track)) ? 'currentColor' : 'none'} />
                                    </button>
                                  </div>
                                </div>
                              </div>
                            )
                          })()
                        ))}
                      </div>
                    )}
                  </div>
                )
              })
            )}
          </section>
        )}
        <footer className="queue-foot">共 {tab === 'past' ? history.reduce((sum, day) => sum + day.tracks.length, 0) : tab === 'favorites' ? favorites.length : rest.length + (playing ? 1 : 0)} 首 · 由 Echo 编排</footer>
      </div>
    </div>
  )
}
