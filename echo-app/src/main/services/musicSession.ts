import { listTodayExplicitTrackFeedback } from '../db/feedback'
import { loadTodayTrackEvents } from '../db/tracks'

function localTime(value?: string): string {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
}

export function buildTodayMusicSessionSummary(): string {
  const tracks = loadTodayTrackEvents(80)
  const explicit = listTodayExplicitTrackFeedback(40)
  const recommended = tracks.filter((track) => track.source === 'recommended_by_echo')
  const completed = tracks.filter((track) => track.queueStatus === 'completed').length
  const skipped = tracks.filter((track) => track.queueStatus === 'skipped').length
  const playing = tracks.find((track) => track.queueStatus === 'playing')
  const lastTracks = tracks.slice(-8).map((track) => {
    const status = track.queueStatus ? ` · ${track.queueStatus}` : ''
    const note = track.echoNote ? ` · ${track.echoNote}` : ''
    return `- ${localTime(track.listenedAt)} ${track.artist} / ${track.title}${status}${note}`
  })
  const feedbackLines = explicit.slice(0, 8).map((item) => {
    const label = item.action === 'more_like_this' ? '想多听这种' : '觉得不对'
    return `- ${localTime(item.createdAt)} ${label}: ${item.track.artist} / ${item.track.title}${item.context ? ` · ${item.context}` : ''}`
  })
  const likedArtists = Array.from(new Set(explicit.filter((item) => item.action === 'more_like_this').map((item) => item.track.artist).filter(Boolean))).slice(0, 4)
  const missedArtists = Array.from(new Set(explicit.filter((item) => item.action === 'not_right').map((item) => item.track.artist).filter(Boolean))).slice(0, 4)
  const warnings: string[] = []
  if (skipped >= 2) warnings.push('今天已经有多次切歌，下一次推荐要明显换方向。')
  if (explicit.some((item) => item.action === 'not_right')) warnings.push('今天有明确“不对”的反馈，避免继续贴近这些歌的方向。')
  if (explicit.some((item) => item.action === 'more_like_this')) warnings.push('今天有“多来这种”的反馈，可以延续相近气质。')
  const diagnosis = [
    missedArtists.length > 0 ? `- 避免靠近:${missedArtists.join(' / ')}` : '- 避免靠近:暂无',
    likedArtists.length > 0 ? `- 可以延续:${likedArtists.join(' / ')}` : '- 可以延续:暂无',
    skipped >= 2 ? '- 下一步策略:先换语言、能量或曲风，不要只换同类歌曲。' : '- 下一步策略:保持正常推荐节奏。',
  ]

  return [
    `- 今日推荐:${recommended.length} 首`,
    `- 今日听完:${completed} 首`,
    `- 今日切歌:${skipped} 首`,
    `- 当前播放:${playing ? `${playing.artist} / ${playing.title}` : '无'}`,
    warnings.length > 0 ? `- 会话提醒:${warnings.join(' ')}` : '- 会话提醒:暂无明显偏航。',
    '',
    '<recent_session_tracks>',
    lastTracks.length > 0 ? lastTracks.join('\n') : '(暂无)',
    '</recent_session_tracks>',
    '',
    '<explicit_feedback_today>',
    feedbackLines.length > 0 ? feedbackLines.join('\n') : '(暂无)',
    '</explicit_feedback_today>',
    '',
    '<session_diagnosis>',
    diagnosis.join('\n'),
    '</session_diagnosis>',
  ].join('\n')
}
