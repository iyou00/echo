import type { ExplicitTrackFeedback } from '../../db/feedback'
import type { TodayTrackEvent } from '../../db/tracks'

function localTime(value?: string): string {
  if (!value) return ''
  const date = new Date(value)
  if (Number.isNaN(date.getTime())) return ''
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
}

function unique(values: string[]): string[] {
  return Array.from(new Set(values.filter(Boolean)))
}

export function buildMusicSessionSummary(tracks: TodayTrackEvent[], explicit: ExplicitTrackFeedback[]): string {
  const completed = tracks.filter((track) => track.queueStatus === 'completed')
  const skipped = tracks.filter((track) => track.queueStatus === 'skipped')
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
  const likedArtists = unique(explicit.filter((item) => item.action === 'more_like_this').map((item) => item.track.artist)).slice(0, 4)
  const missedArtists = unique(explicit.filter((item) => item.action === 'not_right').map((item) => item.track.artist)).slice(0, 4)
  const warnings: string[] = []
  if (skipped.length >= 2) warnings.push('今天切歌偏多，下一次推荐要明显换方向。')
  if (explicit.some((item) => item.action === 'not_right')) warnings.push('今天有明确“不对”的反馈，避免继续贴近这些歌的方向。')
  if (explicit.some((item) => item.action === 'more_like_this')) warnings.push('今天有“多来这种”的反馈，可以延续相近气质。')
  const diagnosis = [
    missedArtists.length > 0 ? `- 避免靠近:${missedArtists.join(' / ')}` : '- 避免靠近:暂无',
    likedArtists.length > 0 ? `- 可以延续:${likedArtists.join(' / ')}` : '- 可以延续:暂无',
    skipped.length >= 2 ? '- 下一步策略:先换语言、能量或曲风，扩大候选差异。' : '- 下一步策略:保持正常推荐节奏。',
  ]

  return [
    '<session_snapshot>',
    `当前播放:${playing ? `${playing.artist} / ${playing.title}` : '无'}`,
    completed.length > 0 ? `刚才完整听过:${completed.slice(-3).map((track) => `${track.artist} / ${track.title}`).join('；')}` : '刚才完整听过:暂无',
    skipped.length > 0 ? `刚才放下的歌:${skipped.slice(-3).map((track) => `${track.artist} / ${track.title}`).join('；')}` : '刚才放下的歌:暂无',
    warnings.length > 0 ? `- 会话提醒:${warnings.join(' ')}` : '- 会话提醒:暂无明显偏航。',
    '</session_snapshot>',
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
