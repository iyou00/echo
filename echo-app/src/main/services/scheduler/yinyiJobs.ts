import { BrowserWindow } from 'electron'
import type { SchedulerCatchupResult, YinyiEntry } from '../../../types/ipc'
import { getLatestScheduledJob, insertScheduledJob } from '../../db/scheduledJobs'
import { getSettings } from '../../db/settings'
import { recordSchedulerHealth } from '../health'
import { generateYinyi, getByDate } from '../yinyi'
import { getProductReadiness, yinyiReadiness } from './readiness'
import { runSchedulerResultTask } from './runtimeTask'

function todayIso(): string {
  return localIsoDate(new Date())
}

function localIsoDate(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

export function parseGenerateAt(value: string): { hour: number; minute: number } {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value)
  if (!match) return { hour: 22, minute: 0 }
  const hour = Math.min(23, Math.max(0, Number(match[1])))
  const minute = Math.min(59, Math.max(0, Number(match[2])))
  return { hour, minute }
}

export function scheduledYinyiDateForNow(): string {
  const { hour, minute } = parseGenerateAt(getSettings().yinyi.generateAt)
  const now = new Date()
  const scheduled = new Date(now)
  scheduled.setHours(hour, minute, 0, 0)
  if (now.getTime() >= scheduled.getTime()) return todayIso()
  scheduled.setDate(scheduled.getDate() - 1)
  return localIsoDate(scheduled)
}

export function yinyiCatchupCompletedMessage(date: string, firstUseDate: string, now = new Date()): string {
  if (date >= localIsoDate(now)) return '风信已生成。'
  return date <= firstUseDate ? '风信已生成。' : '已补写最近缺失的风信。'
}

export function shouldSkipExistingYinyi(entry: YinyiEntry | null): boolean {
  return Boolean(entry && entry.meta?.status !== 'failed')
}

export function shouldSkipCompletedYinyiJob(entry: YinyiEntry | null, latestStatus?: string): boolean {
  return latestStatus === 'completed' && entry?.meta?.status !== 'failed'
}

function broadcastYinyiGenerated(date: string, status: string): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('yinyi:generated', { date, status })
  }
}

export function runYinyiDailyTask(date: string): Promise<SchedulerCatchupResult> {
  return runSchedulerResultTask({
    kind: 'yinyi-generate',
    phase: 'generate',
    sourceName: `daily:${date}`,
    uniqueKey: `yinyi-daily:${date}`,
  }, async (context) => {
    const readiness = yinyiReadiness(date)
    if (!readiness.ready) {
      return { ok: true, job: 'yinyi_daily', date, status: 'skipped', message: readiness.reason ?? '这一天暂时不需要生成风信。' }
    }
    try {
      const entry = await generateYinyi(date, { signal: context.signal })
      const status = entry.meta?.status === 'failed' ? 'failed' : entry.meta?.status === 'absent' ? 'skipped' : 'completed'
      const message = status === 'completed' ? '风信已生成。' : status === 'skipped' ? '当天没有足够内容写风信。' : '风信生成失败。'
      insertScheduledJob('yinyi_daily', entry.date, status, message, entry.meta?.error)
      if (status !== 'skipped') {
        recordSchedulerHealth('yinyi', status === 'completed' ? 'ok' : 'degraded', status === 'completed' ? '已生成。' : '生成失败。', entry.meta?.error)
      }
      broadcastYinyiGenerated(entry.date, entry.meta?.status ?? 'ok')
      return { ok: status !== 'failed', job: 'yinyi_daily', date: entry.date, status, message }
    } catch (error) {
      const message = error instanceof Error ? error.message : '风信定时任务失败'
      insertScheduledJob('yinyi_daily', date, 'failed', '风信生成失败。', message)
      recordSchedulerHealth('yinyi', 'error', '运行失败。', message)
      return { ok: false, job: 'yinyi_daily', date, status: 'failed', message }
    }
  })
}

async function runYinyiCatchupJob(signal?: AbortSignal): Promise<SchedulerCatchupResult> {
  const date = scheduledYinyiDateForNow()
  const readiness = yinyiReadiness(date)
  if (!readiness.ready) {
    return { ok: true, job: 'yinyi_daily', date, status: 'skipped', message: readiness.reason ?? '没有需要补写的风信。' }
  }
  const existing = getByDate(date)
  if (shouldSkipExistingYinyi(existing)) {
    insertScheduledJob('yinyi_daily', date, 'skipped', '这一天已经有风信了。')
    recordSchedulerHealth('yinyi', 'ok', '运行正常。')
    return { ok: true, job: 'yinyi_daily', date, status: 'skipped', message: '这一天已经有风信了。' }
  }

  const latest = getLatestScheduledJob('yinyi_daily', date)
  if (shouldSkipCompletedYinyiJob(existing, latest?.status)) {
    return { ok: true, job: 'yinyi_daily', date, status: 'skipped', message: '补偿任务已经完成过。' }
  }

  try {
    const entry = await generateYinyi(date, { signal })
    const status = entry.meta?.status === 'failed' ? 'failed' : entry.meta?.status === 'absent' ? 'skipped' : 'completed'
    const firstUseDate = getProductReadiness().firstUseDate
    const message = status === 'completed'
      ? yinyiCatchupCompletedMessage(date, firstUseDate)
      : status === 'skipped'
        ? '当天没有足够内容写风信。'
        : '补写风信失败，已留下可重生成占位。'
    insertScheduledJob('yinyi_daily', date, status, message, entry.meta?.error)
    if (status !== 'skipped') {
      recordSchedulerHealth('yinyi', status === 'completed' ? 'ok' : 'degraded', status === 'completed' ? message : '补写失败。', entry.meta?.error)
    }
    broadcastYinyiGenerated(entry.date, entry.meta?.status ?? 'ok')
    return { ok: status !== 'failed', job: 'yinyi_daily', date, status, message }
  } catch (error) {
    const message = error instanceof Error ? error.message : '补偿任务失败'
    insertScheduledJob('yinyi_daily', date, 'failed', '补偿任务失败。', message)
    recordSchedulerHealth('yinyi', 'error', '运行失败。', message)
    return { ok: false, job: 'yinyi_daily', date, status: 'failed', message }
  }
}

export function runYinyiCatchup(): Promise<SchedulerCatchupResult> {
  const date = scheduledYinyiDateForNow()
  return runSchedulerResultTask({
    kind: 'yinyi-generate',
    phase: 'catchup',
    sourceName: `catchup:${date}`,
    uniqueKey: `yinyi-catchup:${date}`,
  }, (context) => runYinyiCatchupJob(context.signal))
}
