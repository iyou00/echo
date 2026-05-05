import { useRef, useState } from 'react'
import { Play, RefreshCw, Settings } from 'lucide-react'
import type { EchoApi, PlaybackState, TasteProfile, Track } from '../../types/ipc'
import type { AppPageProps } from '../../App'
import { BrandLogo, EmptyState, Section } from '../components'

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

function sleep(ms: number) { return new Promise((r) => setTimeout(r, ms)) }

export function EchoProfilePage({ echo, navigate, profile, setPlaybackState, refreshQueue, refreshProfile }: EchoProfileProps) {
  const [busy, setBusy] = useState(false)
  const [phase, setPhase] = useState<'idle' | 'out' | 'loading' | 'in'>('idle')
  const [playingKey, setPlayingKey] = useState('')
  const playingKeyRef = useRef('')
  const statusTimerRef = useRef<ReturnType<typeof setTimeout>>()
  const [status, setStatus] = useState<'idle' | 'success' | 'error'>('idle')
  const [statusMessage, setStatusMessage] = useState('')
  const portraitUpdatedAt = profile?.profile_meta?.updatedAt ?? profile?.profile_meta?.structuredUpdatedAt

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

    // Phase 1: 旧画像模糊消失
    setPhase('out')
    await sleep(400)

    // Phase 2: 加载态（模糊中）
    setPhase('loading')

    try {
      await echo.taste.regeneratePortrait()

      try {
        await refreshProfile()
      } catch {
        // 画像已生成成功，只是本地刷新失败，下次进入页面会自动加载
      }

      // Phase 3: 新画像从模糊中显现
      setPhase('in')
      await sleep(400)

      setPhase('idle')
      showStatus('success', '已刷新', 2000)
    } catch (error) {
      setPhase('in')
      await sleep(400)
      setPhase('idle')
      showStatus('error', error instanceof Error ? error.message : '画像刷新失败')
    } finally {
      setBusy(false)
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

  return (
    <div className="phone-surface profile-page">
      <div className="page-toolbar">
        <div className="tb-status">Echo 眼里的你</div>
        <div className="tb-actions">
          <button className={`tb-btn icon-only${busy ? ' spinning' : ''}`} onClick={regenerate} disabled={busy} title="重新生成画像">
            <RefreshCw size={14} />
          </button>
          <button className="tb-btn icon-only" onClick={() => navigate('settings')} title="设置">
            <Settings size={14} />
          </button>
        </div>
      </div>

      <div className="scroll-panel">
        {!profile ? (
          <EmptyState
            icon={<BrandLogo className="empty-logo" size={56} />}
            className="profile-empty"
            title={busy ? '我正在读你的歌单……第一遍读得慢一点,你别催。' : '我还没听过你的歌呢。你给我导一份歌单,我读一下,然后我们再正经聊。'}
            body={busy ? '大概再等 20 秒。' : undefined}
            sign={busy ? undefined : '— Echo · 等你'}
            action={!busy && <button className="primary-button empty-cta" onClick={() => navigate('settings')}>导 入 歌 单</button>}
          />
        ) : (
          <>
            <Section className="portrait-section">
              <BrandLogo className={`avatar-big${busy ? ' avatar-breathing' : ''}`} size={56} />
              <div className={`portrait-content ${phase}`}>
                {phase === 'idle' || phase === 'in' ? (
                  <p className="portrait-text">{profile.echo_portrait}</p>
                ) : (
                  <p className="portrait-text portrait-loading">正在透过音乐看你,请稍等。</p>
                )}
              </div>
              <div className="portrait-sign">
                — Echo · {busy ? '正在写' : (portraitUpdatedAt ? `写于 ${displayDate(portraitUpdatedAt)}` : '初次见面')}
                {status !== 'idle' && <span className={`portrait-status ${status}`}>{statusMessage}</span>}
              </div>
            </Section>

            <Section label="S I G N A T U R E · 7">
              <div className="signature-list">
                {profile.signature_tracks.slice(0, 7).map((track, index) => (
                  <div className="sig-track" key={`${track.title}-${index}`}>
                    <div className="sig-num">{String(index + 1).padStart(2, '0')}</div>
                    <div className="sig-track-body">
                      <div className="sig-title">{track.title}</div>
                      <div className="sig-meta">{track.artist}{track.year ? ` · ${track.year}` : ''}</div>
                      {track.reason && <div className="sig-reason">— {track.reason}</div>}
                    </div>
                    <button
                      className="sig-play"
                      title="播放这首代表曲目"
                      onClick={() => playSignature(track)}
                      disabled={playingKey === `${track.id ?? track.neteaseId ?? ''}:${track.title}:${track.artist}`}
                    >
                      <Play size={10} fill="currentColor" />
                    </button>
                  </div>
                ))}
              </div>
            </Section>

            {profile.genres.length > 0 && (
            <Section label="G E N R E">
              {profile.genres.map((genre) => (
                <div className="genre-row" key={genre.name}>
                  <div className="genre-head">
                    <span className="genre-name">{genre.name}</span>
                    <span className={genre.trend === 'up' ? 'genre-trend trend-up' : genre.trend === 'down' ? 'genre-trend trend-down' : 'genre-trend trend-steady'}>
                      {genre.trend === 'up' ? '↑' : genre.trend === 'down' ? '↓' : '·'} {asPercent(genre.weight)}%
                    </span>
                  </div>
                  <div className="genre-bar-bg">
                    <div className="genre-bar-fill" style={{ width: `${asPercent(genre.weight)}%` }} />
                  </div>
                  {genre.note && <div className="genre-note">— {genre.note}</div>}
                </div>
              ))}
            </Section>
            )}

            {profile.artists.length > 0 && (
            <Section label="A R T I S T S">
              <div className="artist-list">
                {profile.artists.map((artist, index) => (
                  <div className="artist-item" key={artist.name}>
                    <span className="artist-rank">{String(index + 1).padStart(2, '0')}</span>
                    <div className="artist-name">
                      {artist.name}
                      <small>{artist.notes ?? artist.last_played ?? 'Echo 正在观察'}</small>
                    </div>
                    <div className="affinity-bar">
                      <span className="affinity-fill" style={{ width: `${asPercent(artist.affinity)}%` }} />
                    </div>
                  </div>
                ))}
              </div>
            </Section>
            )}

            {profile.moods.length > 0 && (
            <Section label="M O O D">
              <div className="moods">
                {profile.moods.map((mood) => (
                  <span className="mood" key={mood.tag} style={{ fontSize: `${12 + Math.round(asPercent(mood.frequency) / 8)}px` }}>
                    {mood.tag}
                  </span>
                ))}
              </div>
            </Section>
            )}

            <footer className="page-foot">
              {portraitUpdatedAt
                ? `画像上次更新 · ${displayDate(portraitUpdatedAt)}`
                : '画像 · 尚未生成'}
              {profile.profile_meta?.structuredUpdatedAt && profile.profile_meta.structuredUpdatedAt !== portraitUpdatedAt &&
                ` · 结构刷新 ${displayDate(profile.profile_meta.structuredUpdatedAt)}`}
            </footer>
          </>
        )}
      </div>
    </div>
  )
}
