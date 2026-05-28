import cron, { type ScheduledTask } from 'node-cron'
import { getSettings } from '../db/settings'
import type { SchedulerCatchupReport, SchedulerCatchupResult } from '../../types/ipc'
import { recordSchedulerHealth } from './health'
import {
  TASTE_PORTRAIT_TIME,
  TASTE_STRUCTURED_TIME,
  runTastePortraitRuntimeJob,
  runTasteProfileCatchup,
  runTasteStructuredRuntimeJob,
} from './scheduler/tasteProfileJobs'
import {
  parseGenerateAt,
  runYinyiCatchup,
  runYinyiDailyTask,
} from './scheduler/yinyiJobs'
import {
  listTodayCarePingPlans,
  rescheduleCarePings,
  stopCarePingScheduler,
} from './scheduler/carePingJobs'

export { listTodayCarePingPlans, rescheduleCarePings }

let yinyiTask: ScheduledTask | null = null
let tasteStructuredTask: ScheduledTask | null = null
let tastePortraitTask: ScheduledTask | null = null

function todayIso(): string {
  return localIsoDate(new Date())
}

function localIsoDate(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function technicalMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return typeof error === 'string' ? error : ''
}

function recordScheduledFailure(area: Parameters<typeof recordSchedulerHealth>[0], message: string, error: unknown): void {
  recordSchedulerHealth(area, 'degraded', message, technicalMessage(error))
}

export function registerScheduler(): void {
  rescheduleYinyi()
  rescheduleCarePings()
  rescheduleTasteProfile()
  recordSchedulerHealth('scheduler', 'ok', '已恢复。')
}

export function rescheduleYinyi(): void {
  yinyiTask?.stop()
  yinyiTask = null

  const { hour, minute } = parseGenerateAt(getSettings().yinyi.generateAt)
  yinyiTask = cron.schedule(`${minute} ${hour} * * *`, async () => {
    await runYinyiDailyTask(todayIso()).catch((error) => {
      recordScheduledFailure('yinyi', '执行失败。', error)
    })
  })
}

export function rescheduleTasteProfile(): void {
  tasteStructuredTask?.stop()
  tastePortraitTask?.stop()

  tasteStructuredTask = cron.schedule(`${TASTE_STRUCTURED_TIME.minute} ${TASTE_STRUCTURED_TIME.hour} * * *`, () => {
    runTasteStructuredRuntimeJob(todayIso()).catch((error) => {
      recordScheduledFailure('taste-structured', '执行失败。', error)
    })
  })
  tastePortraitTask = cron.schedule(`${TASTE_PORTRAIT_TIME.minute} ${TASTE_PORTRAIT_TIME.hour} * * *`, () => {
    runTastePortraitRuntimeJob(todayIso()).catch((error) => {
      recordScheduledFailure('taste-portrait', '执行失败。', error)
    })
  })
}

export function stopScheduler(): void {
  yinyiTask?.stop()
  yinyiTask = null
  stopCarePingScheduler()
  tasteStructuredTask?.stop()
  tasteStructuredTask = null
  tastePortraitTask?.stop()
  tastePortraitTask = null
}

export async function runStartupCatchup(): Promise<SchedulerCatchupReport> {
  const results: SchedulerCatchupResult[] = []
  results.push(await runYinyiCatchup())
  const tasteResults = await runTasteProfileCatchup().catch((error) => {
    const message = error instanceof Error ? error.message : '画像补偿任务失败'
    return [{
      ok: false,
      job: 'taste_profile_portrait' as const,
      date: todayIso(),
      status: 'failed' as const,
      message,
    }]
  })
  results.push(...tasteResults)
  const primary = results[0] ?? { ok: true, job: 'yinyi_daily' as const, date: todayIso(), status: 'skipped' as const, message: '没有需要补偿的任务。' }
  return {
    ok: results.every((result) => result.ok || result.status === 'skipped'),
    primary,
    results,
  }
}
