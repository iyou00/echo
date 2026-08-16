import type { SchedulerCatchupResult } from '../../../types/ipc'
import { getLatestScheduledJob, insertScheduledJob } from '../../db/scheduledJobs'
import { getSettings } from '../../db/settings'
import { recordSchedulerHealth } from '../health'
import { runDreamReview } from '../dream/review'
import { refreshLearnedCasesSnapshot } from '../chat/learnedCasesContext'
import { runSchedulerResultTask } from './runtimeTask'

function localIsoDate(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function todayIso(): string {
  return localIsoDate(new Date())
}

export function parseReviewAt(value: string): { hour: number; minute: number } {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value)
  if (!match) return { hour: 23, minute: 30 }
  const hour = Math.min(23, Math.max(0, Number(match[1])))
  const minute = Math.min(59, Math.max(0, Number(match[2])))
  return { hour, minute }
}

export function scheduledDreamDateForNow(): string {
  const settings = getSettings()
  const { hour, minute } = parseReviewAt(settings.dream.reviewAt)
  const now = new Date()
  const scheduled = new Date(now)
  scheduled.setHours(hour, minute, 0, 0)
  if (now.getTime() >= scheduled.getTime()) return todayIso()
  scheduled.setDate(scheduled.getDate() - 1)
  return localIsoDate(scheduled)
}

export function dreamReadiness(date: string): { ready: boolean; reason?: string } {
  const settings = getSettings()
  if (!settings.dream.enabled) return { ready: false, reason: '夜间复盘未开启。' }
  if (!settings.llm.baseUrl || !settings.llm.apiKey || !settings.llm.model) {
    return { ready: false, reason: '模型未配置。' }
  }
  if (date < localIsoDate(new Date(new Date(settings.meta.firstUsedAt).getTime() + 24 * 60 * 60 * 1000))) {
    return { ready: false, reason: '首次使用当天不复盘。' }
  }
  return { ready: true }
}

export function runDreamDailyTask(date: string): Promise<SchedulerCatchupResult> {
  return runSchedulerResultTask({
    kind: 'dream-review',
    phase: 'review',
    sourceName: `daily:${date}`,
    uniqueKey: `dream-review:${date}`,
  }, async (context) => {
    const readiness = dreamReadiness(date)
    if (!readiness.ready) {
      return { ok: true, job: 'dream_review', date, status: 'skipped', message: readiness.reason ?? '无需复盘。' }
    }
    try {
      const result = await runDreamReview(date, { signal: context.signal })
      if (result.status === 'failed') {
        // 失败不记 completed：次日启动 catchup 会重试当天。
        insertScheduledJob('dream_review', date, 'failed', result.message)
        recordSchedulerHealth('dream', 'degraded', '复盘失败。', result.message)
        return { ok: false, job: 'dream_review', date, status: 'failed', message: result.message }
      }
      if (result.status === 'skipped') {
        insertScheduledJob('dream_review', date, 'skipped', result.message)
        return { ok: true, job: 'dream_review', date, status: 'skipped', message: result.message }
      }
      insertScheduledJob('dream_review', date, 'completed', result.message)
      recordSchedulerHealth('dream', 'ok', result.message)
      refreshLearnedCasesSnapshot()
      return { ok: true, job: 'dream_review', date, status: 'completed', message: result.message }
    } catch (error) {
      const message = error instanceof Error ? error.message : '夜间复盘任务失败'
      insertScheduledJob('dream_review', date, 'failed', '夜间复盘失败。', message)
      recordSchedulerHealth('dream', 'error', '运行失败。', message)
      return { ok: false, job: 'dream_review', date, status: 'failed', message }
    }
  })
}

export async function runDreamCatchup(): Promise<SchedulerCatchupResult> {
  const date = scheduledDreamDateForNow()
  const readiness = dreamReadiness(date)
  if (!readiness.ready) {
    return { ok: true, job: 'dream_review', date, status: 'skipped', message: readiness.reason ?? '无需补跑复盘。' }
  }
  const latest = getLatestScheduledJob('dream_review', date)
  if (latest?.status === 'completed' || latest?.status === 'skipped') {
    return { ok: true, job: 'dream_review', date, status: 'skipped', message: '复盘已进行过。' }
  }
  return runDreamDailyTask(date)
}

export const dreamJobsTestHelpers = {
  parseReviewAt,
  scheduledDreamDateForNow,
}
