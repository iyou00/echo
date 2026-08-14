import type { UiBoundarySnapshot } from '../../types/ipc'
import { createUiBoundary } from '../../shared/uiBoundary'
import { loadActiveStageContext } from '../domain/stageContext/repository'
import { getState as getPlaybackState } from './playback'
import { getRecentTasks } from '../runtime/runtime'
import { getServiceHealth } from './health'
import { getProductReadiness } from './scheduler/readiness'
import { getRange as getYinyiRange } from './yinyi'
import { buildCloseReadiness } from '../../shared/closeReadiness'

export function getUiBoundaries(online: boolean): UiBoundarySnapshot[] {
  const readiness = getProductReadiness()
  const playback = getPlaybackState()
  const health = getServiceHealth()
  const recentFailedTask = getRecentTasks('user').find((task) => task.status === 'failed')
  const result: UiBoundarySnapshot[] = []

  if (!online) result.push(createUiBoundary('offline'))
  if (!readiness.llmConfigured) {
    result.push(createUiBoundary('model_missing'))
  } else if (health.some((item) => item.service === 'llm' && item.status === 'error')) {
    result.push(createUiBoundary('model_invalid'))
  }
  if (!readiness.musicLibraryReady) result.push(createUiBoundary('music_empty'))
  if (!readiness.profileReady) result.push(createUiBoundary('taste_empty'))
  if (!playback.current && playback.queue.length === 0) result.push(createUiBoundary('queue_empty'))
  if (!loadActiveStageContext()) result.push(createUiBoundary('context_empty'))
  if (getYinyiRange(1).length === 0) result.push(createUiBoundary('yinyi_empty'))
  if (recentFailedTask) {
    result.push(createUiBoundary('task_failed', {
      sourceId: recentFailedTask.id,
      occurredAt: recentFailedTask.updatedAt,
      retryable: recentFailedTask.errorKind !== 'canceled',
    }))
  }
  return result
}

export function getCloseReadiness() {
  return buildCloseReadiness(getPlaybackState(), getRecentTasks('user'))
}
