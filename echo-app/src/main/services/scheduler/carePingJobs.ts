import cron, { type ScheduledTask } from 'node-cron'
import type { CareFrequency, CarePingScheduleItem } from '../../../types/ipc'
import {
  deferCarePingPlan,
  listCarePingSchedule,
  restoreCarePingPlan,
  updateCarePingPlanStatus,
  upsertCarePingPlan,
  type CarePingScheduleRecord,
} from '../../db/carePingSchedule'
import { insertScheduledJob } from '../../db/scheduledJobs'
import { getSettings } from '../../db/settings'
import { recordSchedulerHealth } from '../health'
import { reconcileCarePingOutcomes, runCarePingSlot } from '../carePings'
import { stableInt } from '../recommendation/deterministic'
import { runSchedulerResultTask } from './runtimeTask'

let carePingTasks: ScheduledTask[] = []
let carePingRolloverTask: ScheduledTask | null = null
let carePingWatchdogTask: ScheduledTask | null = null
const runningCarePingPlanIds = new Set<number>()

interface CarePingWindow {
  key: string
  label: string
  startHour: number
  endHour: number
}

const CARE_PING_WINDOWS: CarePingWindow[] = [
  { key: 'morning', label: '上午提醒', startHour: 9, endHour: 11 },
  { key: 'afternoon', label: '午后提醒', startHour: 14, endHour: 15 },
  { key: 'evening', label: '傍晚提醒', startHour: 16, endHour: 18 },
  { key: 'night', label: '夜间提醒', startHour: 20, endHour: 21 },
]

const CARE_PING_WINDOW_KEYS: Record<CareFrequency, string[]> = {
  gentle: ['afternoon', 'night'],
  normal: ['morning', 'afternoon', 'night'],
  frequent: ['morning', 'afternoon', 'evening', 'night'],
}

const CARE_PING_CATCHUP_GRACE_MS = 45 * 60 * 1000

function todayIso(): string {
  return localIsoDate(new Date())
}

function localIsoDate(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function plannedAtKey(date: Date): string {
  return `${localIsoDate(date)} ${String(date.getHours()).padStart(2, '0')}:${String(date.getMinutes()).padStart(2, '0')}`
}

function parsePlannedAt(value: string): Date {
  const [datePart, timePart] = value.split(' ')
  const [year, month, day] = datePart.split('-').map(Number)
  const [hour, minute] = timePart.split(':').map(Number)
  return new Date(year, month - 1, day, hour, minute, 0, 0)
}

function effectivePlannedAt(record: CarePingScheduleRecord): Date {
  return record.eligibleAfter ? new Date(record.eligibleAfter) : parsePlannedAt(record.plannedAt)
}

function carePingWindowEndAt(record: CarePingScheduleRecord): Date {
  const window = CARE_PING_WINDOWS.find((candidate) => candidate.key === record.windowKey)
  const [year, month, day] = record.date.split('-').map(Number)
  return new Date(year, month - 1, day, window?.endHour ?? 23, 0, 0, 0)
}

function randomPlannedAt(window: CarePingWindow, date: string): string | null {
  const [year, month, day] = date.split('-').map(Number)
  const start = new Date(year, month - 1, day, window.startHour, 0, 0, 0)
  const end = new Date(year, month - 1, day, window.endHour, 0, 0, 0)
  const now = new Date()
  const min = localIsoDate(now) === date ? Math.max(start.getTime(), now.getTime() + 2 * 60 * 1000) : start.getTime()
  const max = end.getTime() - 60 * 1000
  if (min > max) return null
  const totalMinutes = Math.floor((max - min) / 60000)
  const offset = stableInt(`${date}:care-ping:${window.key}:${window.startHour}-${window.endHour}`, totalMinutes + 1)
  const picked = new Date(min + offset * 60000)
  picked.setSeconds(0, 0)
  return plannedAtKey(picked)
}

function activeCarePingWindows(frequency: CareFrequency): CarePingWindow[] {
  const keys = new Set(CARE_PING_WINDOW_KEYS[frequency])
  return CARE_PING_WINDOWS.filter((window) => keys.has(window.key))
}

function shouldCatchUpCarePing(record: CarePingScheduleRecord, now = new Date()): boolean {
  const planned = effectivePlannedAt(record)
  const age = now.getTime() - planned.getTime()
  return age >= 0 && age <= CARE_PING_CATCHUP_GRACE_MS
}

function shouldExpireCarePing(record: CarePingScheduleRecord, now = new Date()): boolean {
  const planned = effectivePlannedAt(record)
  return now.getTime() - planned.getTime() > CARE_PING_CATCHUP_GRACE_MS
}

function technicalMessage(error: unknown): string {
  if (error instanceof Error) return error.message
  return typeof error === 'string' ? error : ''
}

function recordCarePingSchedulerFailure(message: string, error: unknown): void {
  recordSchedulerHealth('care-ping', 'degraded', message, technicalMessage(error))
}

export function rescheduleCarePings(): void {
  carePingTasks.forEach((task) => task.stop())
  carePingTasks = []
  carePingRolloverTask?.stop()
  carePingRolloverTask = cron.schedule('5 0 * * *', () => rescheduleCarePings())
  carePingWatchdogTask?.stop()
  carePingWatchdogTask = cron.schedule('* * * * *', () => {
    runCarePingWatchdog().catch((error) => {
      recordCarePingSchedulerFailure('watchdog 执行失败。', error)
    })
  })

  const settings = getSettings()
  if (!settings.carePings.enabled) return
  const date = todayIso()
  const existing = new Map(listCarePingSchedule(date).map((item) => [item.windowKey, item]))
  const activeWindows = activeCarePingWindows(settings.carePings.frequency)
  const activeKeys = new Set(activeWindows.map((window) => window.key))

  for (const record of Array.from(existing.values())) {
    if (activeKeys.has(record.windowKey) || record.status !== 'planned') continue
    updateCarePingPlanStatus(record.id, 'skipped', '当前频率已关闭这个提醒时段。')
  }

  const now = new Date()
  const records = activeWindows
    .map((window) => {
      const current = existing.get(window.key)
      if (current) {
        const planned = effectivePlannedAt(current)
        if (current.status === 'skipped' && current.message === '当前频率已关闭这个提醒时段。' && planned.getTime() > now.getTime()) {
          return restoreCarePingPlan(current.id, true)
        }
        if (current.status === 'skipped' && current.message === 'App 未在计划时间运行，已错过这次主动通知。' && shouldCatchUpCarePing(current, now)) {
          return restoreCarePingPlan(current.id)
        }
        return current
      }
      const plannedAt = randomPlannedAt(window, date)
      if (!plannedAt) {
        const fallback = `${date} ${String(window.endHour).padStart(2, '0')}:00`
        const plan = upsertCarePingPlan(date, window.key, window.label, fallback)
        if (shouldCatchUpCarePing(plan, now)) return plan
        updateCarePingPlanStatus(plan.id, 'skipped', '今天这个提醒时段已经过去。')
        insertScheduledJob('care_ping', fallback, 'skipped', `${window.label}时段已错过。`)
        return null
      }
      return upsertCarePingPlan(date, window.key, window.label, plannedAt)
    })
    .filter((item): item is CarePingScheduleRecord => Boolean(item))

  for (const record of records) {
    if (record.status !== 'planned') continue
    const planned = effectivePlannedAt(record)
    if (planned.getTime() <= now.getTime()) {
      if (shouldCatchUpCarePing(record, now)) {
        executeCarePingPlan(record).catch((error) => {
          recordCarePingSchedulerFailure(`${record.label}补发失败。`, error)
        })
      } else {
        updateCarePingPlanStatus(record.id, 'skipped', 'App 未在计划时间运行，已错过这次主动通知。')
        insertScheduledJob('care_ping', record.plannedAt, 'skipped', `${record.label}已错过。`)
      }
      continue
    }

    carePingTasks.push(cron.schedule(`${planned.getMinutes()} ${planned.getHours()} * * *`, () => {
      executeCarePingPlan(record).catch((error) => {
        recordCarePingSchedulerFailure(`${record.label}执行失败。`, error)
      })
    }))
  }
}

async function runCarePingWatchdog(): Promise<void> {
  reconcileCarePingOutcomes()
  const settings = getSettings()
  if (!settings.carePings.enabled) return
  const activeKeys = new Set(activeCarePingWindows(settings.carePings.frequency).map((window) => window.key))
  const now = new Date()

  for (const record of listCarePingSchedule(todayIso())) {
    if (record.status !== 'planned') continue
    if (!activeKeys.has(record.windowKey)) continue
    if (shouldCatchUpCarePing(record, now)) {
      await executeCarePingPlan(record)
      continue
    }
    if (shouldExpireCarePing(record, now)) {
      updateCarePingPlanStatus(record.id, 'skipped', '主动关心补发窗口已过。')
      insertScheduledJob('care_ping', record.plannedAt, 'skipped', `${record.label}补发窗口已过。`)
    }
  }
}

export function listTodayCarePingPlans(): CarePingScheduleItem[] {
  return listCarePingSchedule(todayIso()).map((item) => ({
    id: item.id,
    label: item.label,
    plannedAt: item.plannedAt,
    status: item.status,
    message: item.message,
  }))
}

async function executeCarePingPlan(record: CarePingScheduleRecord): Promise<void> {
  if (record.date !== todayIso()) return
  if (runningCarePingPlanIds.has(record.id)) return
  runningCarePingPlanIds.add(record.id)
  try {
    const result = await runCarePingPlanTask(record)
    if (result.status === 'deferred') {
      const deferred = result.deferredUntil && result.decisionCode
        ? deferCarePingPlan(record.id, result.deferredUntil, result.decisionCode)
        : false
      if (!deferred) {
        updateCarePingPlanStatus(record.id, 'skipped', '这次主动关心不再继续延后。')
        insertScheduledJob('care_ping', record.plannedAt, 'skipped', '这次主动关心不再继续延后。')
      }
      return
    }
    updateCarePingPlanStatus(record.id, result.status, result.message, result.error)
    insertScheduledJob('care_ping', record.plannedAt, result.status, result.message, result.error)
    if (result.status === 'completed') {
      recordSchedulerHealth('care-ping', 'ok', '已发送。')
    }
    if (result.status === 'failed') {
      recordSchedulerHealth('care-ping', 'degraded', '生成失败。', result.error)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : '主动通知定时任务失败'
    updateCarePingPlanStatus(record.id, 'failed', '主动通知定时任务失败。', message)
    insertScheduledJob('care_ping', record.plannedAt, 'failed', '主动通知定时任务失败。', message)
    recordSchedulerHealth('care-ping', 'error', '运行失败。', message)
  } finally {
    runningCarePingPlanIds.delete(record.id)
  }
}

function runCarePingPlanTask(record: CarePingScheduleRecord): Promise<Awaited<ReturnType<typeof runCarePingSlot>>> {
  return runSchedulerResultTask({
    kind: 'care-ping',
    phase: 'care-ping',
    sourceName: `${record.label}:${record.plannedAt}`,
    uniqueKey: `care-ping:${record.id}`,
  }, async (context) => {
    const planned = parsePlannedAt(record.plannedAt)
    return runCarePingSlot({
      key: record.windowKey,
      label: record.label,
      hour: planned.getHours(),
      minute: planned.getMinutes(),
    }, {
      signal: context.signal,
      evaluationWindowEndAt: record.deferCount === 0 ? carePingWindowEndAt(record).toISOString() : undefined,
    })
  })
}

export const carePingJobsTestHelpers = {
  effectivePlannedAt,
  carePingWindowEndAt,
  shouldCatchUpCarePing,
  shouldExpireCarePing,
}

export function stopCarePingScheduler(): void {
  carePingTasks.forEach((task) => task.stop())
  carePingTasks = []
  carePingRolloverTask?.stop()
  carePingRolloverTask = null
  carePingWatchdogTask?.stop()
  carePingWatchdogTask = null
  runningCarePingPlanIds.clear()
}
