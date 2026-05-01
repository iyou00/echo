import { Heart, Pause, Play, ThumbsDown, ThumbsUp } from 'lucide-react'
import type { ReactNode } from 'react'
import type { ActiveScene, PlaybackStatus, SceneDefinition, SceneKey, Track } from '../types/ipc'
import { brand } from '../brand'

export function PageHeader({
  title,
  kicker,
  onBack,
  actions,
}: {
  title: string
  kicker?: string
  onBack?: () => void
  actions?: ReactNode
}) {
  return (
    <header className="page-header">
      {onBack ? (
        <button className="ghost-button" onClick={onBack}>
          ◁ 返回
        </button>
      ) : (
        <div className="header-spacer" />
      )}
      <div className="page-title">
        {title}
        {kicker && <small>{kicker}</small>}
      </div>
      <div className="header-actions">{actions}</div>
    </header>
  )
}

export function Section({ label, children, className = '' }: { label?: string; children: ReactNode; className?: string }) {
  return (
    <section className={`section ${className}`}>
      {label && <div className="section-label">{label}</div>}
      {children}
    </section>
  )
}

export function EchoAvatar({ large = false }: { large?: boolean }) {
  return <BrandLogo className={large ? 'echo-avatar large' : 'echo-avatar'} size={large ? 56 : 32} />
}

export function HeaderAvatar({ offline = false }: { offline?: boolean }) {
  return (
    <div className="hdr-avatar" aria-hidden="true">
      <BrandLogo className="hdr-avatar-logo" size={32} />
      <span className={offline ? 'hdr-avatar-status offline' : 'hdr-avatar-status'} />
    </div>
  )
}

export function BrandLogo({ size = 32, className = '', decorative = true }: { size?: number; className?: string; decorative?: boolean }) {
  return (
    <img
      className={className || 'brand-logo'}
      src={size > 128 ? brand.logo256 : brand.logo64}
      width={size}
      height={size}
      alt={decorative ? '' : brand.name}
      aria-hidden={decorative}
      draggable={false}
    />
  )
}

export function WindowControls({
  onMinimize,
  onToggleMaximize,
  onClose,
}: {
  onMinimize: () => void
  onToggleMaximize: () => void
  onClose: () => void
}) {
  return (
    <div className="window-ctrls">
      <button className="wc-btn" type="button" onClick={onMinimize} title="最小化">
        <span className="wc-icon wc-min" />
      </button>
      <button className="wc-btn" type="button" onClick={onToggleMaximize} title="最大化">
        <span className="wc-icon wc-max" />
      </button>
      <button className="wc-btn wc-close" type="button" onClick={onClose} title="关闭">
        <span className="wc-icon wc-x" />
      </button>
    </div>
  )
}

export function SceneRail({
  scenes,
  currentScene,
  onStart,
  onEnd,
  compact = false,
}: {
  scenes: SceneDefinition[]
  currentScene: ActiveScene | null
  onStart: (key: SceneKey) => void
  onEnd: () => void
  compact?: boolean
}) {
  const activeKey = currentScene?.key
  return (
    <div className={compact ? 'scene-rail compact' : 'scene-rail'}>
      {currentScene && (
        <div className="scene-current">
          <span>当前：{currentScene.label}中</span>
          <small>{currentScene.line}</small>
          <button type="button" onClick={onEnd}>结束</button>
        </div>
      )}
      <div className="scene-scroll" aria-label="场景模式">
        {scenes.map((scene) => (
          <button
            type="button"
            key={scene.key}
            className={activeKey === scene.key ? 'scene-chip active' : 'scene-chip'}
            onClick={() => onStart(scene.key)}
            title={scene.line}
          >
            <span>{compact ? scene.label : scene.shortLabel}</span>
          </button>
        ))}
      </div>
    </div>
  )
}

function formatDuration(ms?: number) {
  if (!ms || ms <= 0) return ''
  const total = Math.floor(ms / 1000)
  const m = Math.floor(total / 60)
  const s = total % 60
  return `${m}:${s.toString().padStart(2, '0')}`
}

export function TrackCard({
  track,
  compact = false,
  onPlay,
  onToggleFavorite,
  onFeedback,
  isCurrent = false,
  playbackStatus = 'idle',
  favorited = false,
  feedbackState,
}: {
  track: Track
  compact?: boolean
  onPlay?: (track: Track) => void
  onToggleFavorite?: (track: Track) => void
  onFeedback?: (track: Track, action: 'more_like_this' | 'not_right') => void
  isCurrent?: boolean
  playbackStatus?: PlaybackStatus
  favorited?: boolean
  feedbackState?: 'more_like_this' | 'not_right'
}) {
  const isPlaying = isCurrent && playbackStatus === 'playing'
  const isPaused = isCurrent && playbackStatus === 'paused'
  const isLoading = isCurrent && playbackStatus === 'loading'
  const canPlay = Boolean(track.playUrl)
  const actionTitle = !canPlay ? '暂无播放链接' : isPlaying ? '暂停' : isPaused ? '继续播放' : '播放'
  const stateClass = !canPlay ? 'unplayable' : isPlaying ? 'playing' : isPaused ? 'paused' : isLoading ? 'loading' : 'ready'

  function handleAction() {
    if (!canPlay) return
    onPlay?.(track)
  }

  return (
    <div
      className={`${compact ? 'track-card compact' : 'track-card'} ${isCurrent ? 'current' : ''} ${stateClass}`}
      role="button"
      tabIndex={0}
      onClick={handleAction}
      onKeyDown={(event) => {
        if (event.key === 'Enter' || event.key === ' ') handleAction()
      }}
      aria-label={`${track.title} - ${actionTitle}`}
    >
      <button className="play-mini" type="button" title={actionTitle} onClick={(event) => {
        event.stopPropagation()
        handleAction()
      }} disabled={!canPlay || isLoading}>
        {isPlaying ? <Pause size={12} fill="currentColor" /> : <Play size={12} fill="currentColor" />}
      </button>
      <div className="track-info">
        <div className="track-title">{track.title}</div>
        <div className="track-meta">
          {track.artist}
          {track.year ? ` · ${track.year}` : track.album ? ` · ${track.album}` : ''}
        </div>
      </div>
      <div className="track-card-side">
        {(onFeedback || onToggleFavorite) && (
          <div className="track-card-actions" onClick={(event) => event.stopPropagation()}>
            {onFeedback && (
              <>
                <button
                  className={feedbackState === 'more_like_this' ? 'feedback-mini active' : 'feedback-mini'}
                  type="button"
                  title="多来这种"
                  aria-label="多来这种"
                  onClick={() => onFeedback(track, 'more_like_this')}
                >
                  <ThumbsUp size={12} />
                </button>
                <button
                  className={feedbackState === 'not_right' ? 'feedback-mini active miss' : 'feedback-mini miss'}
                  type="button"
                  title="这首不对"
                  aria-label="这首不对"
                  onClick={() => onFeedback(track, 'not_right')}
                >
                  <ThumbsDown size={12} />
                </button>
              </>
            )}
            {onToggleFavorite && (
              <button
                className={favorited ? 'favorite-mini active' : 'favorite-mini'}
                type="button"
                title={favorited ? '取消收藏' : '收藏'}
                aria-label={favorited ? '取消收藏' : '收藏'}
                onClick={() => onToggleFavorite(track)}
              >
                <Heart size={13} fill={favorited ? 'currentColor' : 'none'} />
              </button>
            )}
          </div>
        )}
        {track.durationMs ? <span className="track-duration">{formatDuration(track.durationMs)}</span> : null}
      </div>
    </div>
  )
}

export function EmptyState({
  title,
  body,
  action,
  icon = 'E',
  sign,
  muted = false,
  className = '',
}: {
  title: string
  body?: string
  action?: ReactNode
  icon?: ReactNode
  sign?: string
  muted?: boolean
  className?: string
}) {
  return (
    <div className={`empty-state ${muted ? 'muted' : ''} ${className}`}>
      <div className="empty-dot">{icon}</div>
      <h3>{title}</h3>
      {body && <p>{body}</p>}
      {action}
      {sign && <div className="empty-sign">{sign}</div>}
    </div>
  )
}

export function WaveBars({ count = 36, active = false }: { count?: number; active?: boolean }) {
  return (
    <div className={active ? 'wave-bars active' : 'wave-bars'} aria-hidden="true">
      {Array.from({ length: count }).map((_, index) => (
        <span key={index} style={{ height: `${26 + ((index * 17) % 60)}%` }} />
      ))}
    </div>
  )
}
