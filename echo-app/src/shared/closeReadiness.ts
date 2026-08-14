import type { CloseReadiness, PlaybackState, RuntimeTaskSnapshot } from '../types/ipc'
import { createUiBoundary } from './uiBoundary'

export function buildCloseReadiness(
  playback: PlaybackState,
  tasks: RuntimeTaskSnapshot[],
): CloseReadiness {
  const activities: CloseReadiness['activities'] = []
  if (playback.current && (playback.status === 'playing' || playback.status === 'loading')) {
    activities.push({
      kind: 'playback',
      sourceId: playback.current.playbackInstanceId,
      label: `正在播放《${playback.current.title}》`,
    })
  }
  for (const task of tasks.filter((item) => item.status === 'running')) {
    activities.push({
      kind: 'task',
      sourceId: task.id,
      label: task.sourceName ? `${task.sourceName}：${task.message ?? '正在进行'}` : task.message ?? '有任务正在进行',
    })
  }
  return {
    activities,
    boundary: activities.length > 0
      ? createUiBoundary('close_busy', { sourceId: activities[0]?.sourceId })
      : undefined,
  }
}
