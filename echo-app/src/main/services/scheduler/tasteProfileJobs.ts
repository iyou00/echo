import type { SchedulerCatchupResult, TasteProfile } from '../../../types/ipc'
import { getLatestCorrectionCreatedAt } from '../../db/events'
import { getFeedbackSignalCount, getLatestFeedbackUpdatedAt } from '../../db/feedback'
import { getLatestScheduledJob, insertScheduledJob } from '../../db/scheduledJobs'
import { getTasteProfile } from '../../db/taste'
import { recordSchedulerHealth } from '../health'
import { refreshStructuredProfile, regeneratePortrait } from '../taste'
import { tastePortraitReadiness, tasteStructuredReadiness } from './readiness'
import { runSchedulerResultTask } from './runtimeTask'

export const TASTE_STRUCTURED_TIME = { hour: 17, minute: 0 }
export const TASTE_PORTRAIT_TIME = { hour: 17, minute: 30 }

function localIsoDate(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function todayIso(): string {
  return localIsoDate(new Date())
}

function scheduledDateForFixedTime(hour: number, minute: number): string {
  const now = new Date()
  const scheduled = new Date(now)
  scheduled.setHours(hour, minute, 0, 0)
  if (now.getTime() >= scheduled.getTime()) return todayIso()
  scheduled.setDate(scheduled.getDate() - 1)
  return localIsoDate(scheduled)
}

function toTime(value?: string | null): number {
  if (!value) return 0
  const normalized = value.includes('T') ? value : `${value.replace(' ', 'T')}Z`
  const time = new Date(normalized).getTime()
  return Number.isNaN(time) ? 0 : time
}

function hasNewTasteSignalsSinceStructuredSnapshot(
  profile: TasteProfile,
  feedbackSignalCount: number,
  latestFeedbackAt: string | null,
  latestCorrectionAt: string | null,
): boolean {
  const lastSignalCount = profile.profile_meta?.signalCount ?? 0
  const lastSignalRevision = profile.profile_meta?.structuredSignalRevision ?? 0
  const signalRevision = profile.profile_meta?.signalRevision ?? 0
  const structuredUpdatedAt = profile.profile_meta?.structuredUpdatedAt
  const signalUpdatedAt = profile.profile_meta?.signalUpdatedAt
  return signalRevision > lastSignalRevision
    || feedbackSignalCount > lastSignalCount
    || toTime(latestFeedbackAt) > toTime(structuredUpdatedAt)
    || toTime(latestCorrectionAt) > toTime(structuredUpdatedAt)
    || toTime(signalUpdatedAt) > toTime(structuredUpdatedAt)
}

function hasNewTasteSignalsSinceLastStructured(): boolean {
  const profile = getTasteProfile()
  if (!profile) return false
  return hasNewTasteSignalsSinceStructuredSnapshot(
    profile,
    getFeedbackSignalCount(),
    getLatestFeedbackUpdatedAt(),
    getLatestCorrectionCreatedAt(),
  )
}

function hasNewTasteSignalsSincePortraitSnapshot(
  profile: TasteProfile,
  feedbackSignalCount: number,
  latestFeedbackAt: string | null,
  latestCorrectionAt: string | null,
): boolean {
  const updatedAt = lastPortraitUpdatedAt(profile)
  const lastPortraitSignalCount = profile.profile_meta?.portraitSignalCount ?? 0
  const lastPortraitSignalRevision = profile.profile_meta?.portraitSignalRevision ?? 0
  const signalRevision = profile.profile_meta?.signalRevision ?? 0
  const signalUpdatedAt = profile.profile_meta?.signalUpdatedAt
  if (!updatedAt) return true
  return signalRevision > lastPortraitSignalRevision
    || feedbackSignalCount > lastPortraitSignalCount
    || toTime(latestFeedbackAt) > toTime(updatedAt)
    || toTime(latestCorrectionAt) > toTime(updatedAt)
    || toTime(signalUpdatedAt) > toTime(updatedAt)
}

function hasNewTasteSignalsSinceLastPortrait(): boolean {
  const profile = getTasteProfile()
  if (!profile) return false
  return hasNewTasteSignalsSincePortraitSnapshot(
    profile,
    getFeedbackSignalCount(),
    getLatestFeedbackUpdatedAt(),
    getLatestCorrectionCreatedAt(),
  )
}

function lastPortraitUpdatedAt(profile: TasteProfile): string | undefined {
  return profile.profile_meta?.portraitUpdatedAt ?? profile.profile_meta?.updatedAt
}

async function runTasteStructuredJob(date: string): Promise<SchedulerCatchupResult> {
  const readiness = tasteStructuredReadiness()
  if (!readiness.ready) {
    return { ok: true, job: 'taste_profile_structured', date, status: 'skipped', message: readiness.reason ?? '暂时不需要刷新结构画像。' }
  }
  const latest = getLatestScheduledJob('taste_profile_structured', date)
  if (!hasNewTasteSignalsSinceLastStructured()) {
    if (latest?.status === 'completed') {
      return { ok: true, job: 'taste_profile_structured', date, status: latest.status, message: latest.message ?? '结构画像今天已经处理过。' }
    }
    if (latest?.status === 'skipped') {
      return { ok: true, job: 'taste_profile_structured', date, status: 'skipped', message: latest.message ?? '今天没有新增口味信号，跳过结构刷新。' }
    }
    insertScheduledJob('taste_profile_structured', date, 'skipped', '今天没有新增口味信号，跳过结构刷新。')
    return { ok: true, job: 'taste_profile_structured', date, status: 'skipped', message: '今天没有新增口味信号，跳过结构刷新。' }
  }
  try {
    const profile = refreshStructuredProfile('scheduled_structured')
    const status = profile ? 'completed' : 'skipped'
    const message = profile ? '结构画像已刷新。' : '结构画像暂无可刷新内容。'
    insertScheduledJob('taste_profile_structured', date, status, message)
    recordSchedulerHealth('taste-structured', 'ok', message)
    return { ok: true, job: 'taste_profile_structured', date, status, message }
  } catch (error) {
    const message = error instanceof Error ? error.message : '结构画像刷新失败'
    insertScheduledJob('taste_profile_structured', date, 'failed', '结构画像刷新失败。', message)
    recordSchedulerHealth('taste-structured', 'degraded', '刷新失败。', message)
    return { ok: false, job: 'taste_profile_structured', date, status: 'failed', message }
  }
}

export function runTasteStructuredRuntimeJob(date: string): Promise<SchedulerCatchupResult> {
  return runSchedulerResultTask({
    kind: 'taste-refresh',
    phase: 'structured-profile',
    sourceName: `structured:${date}`,
    uniqueKey: `taste-structured:${date}`,
  }, () => runTasteStructuredJob(date))
}

async function runTastePortraitJob(date: string, signal?: AbortSignal): Promise<SchedulerCatchupResult> {
  const readiness = tastePortraitReadiness()
  if (!readiness.ready) {
    return { ok: true, job: 'taste_profile_portrait', date, status: 'skipped', message: readiness.reason ?? '暂时不需要刷新画像文案。' }
  }
  const latest = getLatestScheduledJob('taste_profile_portrait', date)
  if (!hasNewTasteSignalsSinceLastPortrait()) {
    if (latest?.status === 'completed') {
      return { ok: true, job: 'taste_profile_portrait', date, status: latest.status, message: latest.message ?? '画像文案今天已经处理过。' }
    }
    if (latest?.status === 'skipped') {
      return { ok: true, job: 'taste_profile_portrait', date, status: 'skipped', message: latest.message ?? '今天没有新增口味信号，跳过文案刷新。' }
    }
    insertScheduledJob('taste_profile_portrait', date, 'skipped', '今天没有新增口味信号，跳过文案刷新。')
    return { ok: true, job: 'taste_profile_portrait', date, status: 'skipped', message: '今天没有新增口味信号，跳过文案刷新。' }
  }
  try {
    const structured = await runTasteStructuredJob(date)
    if (!structured.ok && structured.status === 'failed') {
      insertScheduledJob('taste_profile_portrait', date, 'failed', '结构画像刷新失败，已停止画像文案刷新。', structured.message)
      recordSchedulerHealth('taste-portrait', 'degraded', '结构画像刷新失败，已停止文案刷新。', structured.message)
      return {
        ok: false,
        job: 'taste_profile_portrait',
        date,
        status: 'failed',
        message: '结构画像刷新失败，已停止画像文案刷新。',
      }
    }
    const profile = await regeneratePortrait({ refreshStructured: false, signal })
    const retained = profile?.profile_meta?.portraitRefreshOutcome === 'retained'
    const status = profile && !retained ? 'completed' : 'skipped'
    const message = retained ? '新画像未通过质量检查，已保留原画像。' : profile ? '画像文案已刷新。' : '画像文案暂无可刷新内容。'
    insertScheduledJob('taste_profile_portrait', date, status, message)
    recordSchedulerHealth('taste-portrait', 'ok', message)
    return { ok: true, job: 'taste_profile_portrait', date, status, message }
  } catch (error) {
    const message = error instanceof Error ? error.message : '画像文案刷新失败'
    insertScheduledJob('taste_profile_portrait', date, 'failed', '画像文案刷新失败。', message)
    recordSchedulerHealth('taste-portrait', 'degraded', '刷新失败。', message)
    return { ok: false, job: 'taste_profile_portrait', date, status: 'failed', message }
  }
}

export function runTastePortraitRuntimeJob(date: string): Promise<SchedulerCatchupResult> {
  return runSchedulerResultTask({
    kind: 'taste-refresh',
    phase: 'portrait',
    sourceName: `portrait:${date}`,
    uniqueKey: `taste-portrait:${date}`,
  }, (context) => runTastePortraitJob(date, context.signal))
}

export async function runTasteProfileCatchup(): Promise<SchedulerCatchupResult[]> {
  const results: SchedulerCatchupResult[] = []
  const structuredDate = scheduledDateForFixedTime(TASTE_STRUCTURED_TIME.hour, TASTE_STRUCTURED_TIME.minute)
  const portraitDate = scheduledDateForFixedTime(TASTE_PORTRAIT_TIME.hour, TASTE_PORTRAIT_TIME.minute)

  if (structuredDate === todayIso()) {
    results.push(await runTasteStructuredRuntimeJob(structuredDate))
  }
  if (portraitDate === todayIso()) {
    results.push(await runTastePortraitRuntimeJob(portraitDate))
  }
  return results
}

export const tasteProfileJobsTestHelpers = {
  hasNewTasteSignalsSincePortraitSnapshot,
  hasNewTasteSignalsSinceStructuredSnapshot,
  lastPortraitUpdatedAt,
}
