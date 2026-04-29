import { FormEvent, useState } from 'react'
import { Play, RefreshCw, Settings } from 'lucide-react'
import type { EchoApi, PlaybackState, TasteProfile, TasteQuestion, Track } from '../../types/ipc'
import type { AppPageProps } from '../../App'
import { BrandLogo, EmptyState, Section } from '../components'

interface EchoProfileProps extends AppPageProps {
  echo: EchoApi
  profile: TasteProfile | null
  questions: TasteQuestion[]
  setPlaybackState: (state: PlaybackState) => void
  refreshQueue: () => Promise<Track[]>
  refreshProfile: () => Promise<void>
}

function asPercent(value: number) {
  return Math.max(0, Math.min(100, Math.round(value <= 1 ? value * 100 : value)))
}

function displayDate(value?: string) {
  if (!value) return new Date().toLocaleDateString('zh-CN')
  return new Date(value).toLocaleDateString('zh-CN')
}

export function EchoProfilePage({ echo, navigate, profile, questions, setPlaybackState, refreshQueue, refreshProfile }: EchoProfileProps) {
  const [answering, setAnswering] = useState<Record<number, string>>({})
  const [busy, setBusy] = useState(false)
  const [playingKey, setPlayingKey] = useState('')

  async function regenerate() {
    setBusy(true)
    try {
      await echo.taste.regeneratePortrait()
      await refreshProfile()
    } finally {
      setBusy(false)
    }
  }

  async function answerQuestion(event: FormEvent, question: TasteQuestion) {
    event.preventDefault()
    const answer = answering[question.id]?.trim()
    if (!answer) return
    await echo.taste.answerQuestion(question.id, answer)
    setAnswering((items) => ({ ...items, [question.id]: '' }))
    await refreshProfile()
  }

  async function playSignature(track: Track) {
    const key = `${track.id ?? track.neteaseId ?? ''}:${track.title}:${track.artist}`
    setPlayingKey(key)
    try {
      const next = await echo.playback.play(track)
      setPlaybackState(next)
      await refreshQueue()
    } finally {
      setPlayingKey('')
    }
  }

  return (
    <div className="phone-surface profile-page">
      <div className="page-toolbar">
        <div className="tb-status">Echo 眼里的你</div>
        <div className="tb-actions">
          <button className="tb-btn icon-only" onClick={regenerate} disabled={busy} title="重新生成画像">
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
              <BrandLogo className="avatar-big" size={56} />
              <p className="portrait-text">{profile.echo_portrait}</p>
              <div className="portrait-sign">— Echo · 写于 {new Date().toLocaleDateString('zh-CN')}</div>
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

            <Section label="M O O D">
              <div className="moods">
                {profile.moods.map((mood) => (
                  <span className="mood" key={mood.tag} style={{ fontSize: `${12 + Math.round(asPercent(mood.frequency) / 8)}px` }}>
                    {mood.tag}
                  </span>
                ))}
              </div>
            </Section>

            <Section>
              <div className="questions">
                <div className="section-label">E C H O 问 你</div>
                <p>这几处我还没有判断准，你随手补一句就行。</p>
                {questions.filter((question) => question.status === 'pending').map((question) => (
                  <form className="question-item" key={question.id} onSubmit={(event) => answerQuestion(event, question)}>
                    <div className="q-mark">Q</div>
                    <div className="q-body">
                      <div className="q-text">{question.content}</div>
                      <div className="q-actions">
                        <input
                          value={answering[question.id] ?? ''}
                          onChange={(event) => setAnswering((items) => ({ ...items, [question.id]: event.target.value }))}
                          placeholder="你的答案"
                        />
                        <button className="q-btn" type="submit">回答</button>
                      </div>
                    </div>
                  </form>
                ))}
                {questions.every((question) => question.status !== 'pending') && <div className="quiet-line">今天的问题已经回答完了。</div>}
              </div>
            </Section>

            <footer className="page-foot">
              画像上次更新 · {displayDate(profile.profile_meta?.updatedAt ?? profile.profile_meta?.structuredUpdatedAt)} · 结构刷新 {displayDate(profile.profile_meta?.structuredUpdatedAt)}
            </footer>
          </>
        )}
      </div>
    </div>
  )
}
