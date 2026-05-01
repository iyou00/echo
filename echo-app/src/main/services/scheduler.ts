import cron, { type ScheduledTask } from 'node-cron'
import { BrowserWindow } from 'electron'
import { getSettings } from '../db/settings'
import type { CareFrequency, CarePingScheduleItem, SchedulerCatchupReport, SchedulerCatchupResult } from '../../types/ipc'
import { getByDate, generateYinyi } from './yinyi'
import { runCarePingSlot } from './carePings'
import { getLatestScheduledJob, insertScheduledJob } from '../db/scheduledJobs'
import {
  listCarePingSchedule,
  restoreCarePingPlan,
  updateCarePingPlanStatus,
  upsertCarePingPlan,
  type CarePingScheduleRecord,
} from '../db/carePingSchedule'
import { recordHealth } from './health'
import { getTasteProfile } from '../db/taste'
import { getFeedbackSignalCount, getLatestFeedbackUpdatedAt } from '../db/feedback'
import { refreshStructuredProfile, regeneratePortrait } from './taste'

let yinyiTask: ScheduledTask | null = null
let carePingTasks: ScheduledTask[] = []
let carePingRolloverTask: ScheduledTask | null = null
let carePingWatchdogTask: ScheduledTask | null = null
let tasteStructuredTask: ScheduledTask | null = null
let tastePortraitTask: ScheduledTask | null = null
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
const TASTE_STRUCTURED_TIME = { hour: 17, minute: 0 }
const TASTE_PORTRAIT_TIME = { hour: 17, minute: 30 }

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

function randomPlannedAt(window: CarePingWindow, date: string): string | null {
  const [year, month, day] = date.split('-').map(Number)
  const start = new Date(year, month - 1, day, window.startHour, 0, 0, 0)
  const end = new Date(year, month - 1, day, window.endHour, 0, 0, 0)
  const now = new Date()
  const min = localIsoDate(now) === date ? Math.max(start.getTime(), now.getTime() + 2 * 60 * 1000) : start.getTime()
  const max = end.getTime() - 60 * 1000
  if (min > max) return null
  const totalMinutes = Math.floor((max - min) / 60000)
  const picked = new Date(min + Math.floor(Math.random() * (totalMinutes + 1)) * 60000)
  picked.setSeconds(0, 0)
  return plannedAtKey(picked)
}

function activeCarePingWindows(frequency: CareFrequency): CarePingWindow[] {
  const keys = new Set(CARE_PING_WINDOW_KEYS[frequency])
  return CARE_PING_WINDOWS.filter((window) => keys.has(window.key))
}

function shouldCatchUpCarePing(record: CarePingScheduleRecord, now = new Date()): boolean {
  const planned = parsePlannedAt(record.plannedAt)
  const age = now.getTime() - planned.getTime()
  return age >= 0 && age <= CARE_PING_CATCHUP_GRACE_MS
}

function shouldExpireCarePing(record: CarePingScheduleRecord, now = new Date()): boolean {
  const planned = parsePlannedAt(record.plannedAt)
  return now.getTime() - planned.getTime() > CARE_PING_CATCHUP_GRACE_MS
}

function parseGenerateAt(value: string): { hour: number; minute: number } {
  const match = /^(\d{1,2}):(\d{2})$/.exec(value)
  if (!match) return { hour: 22, minute: 0 }
  const hour = Math.min(23, Math.max(0, Number(match[1])))
  const minute = Math.min(59, Math.max(0, Number(match[2])))
  return { hour, minute }
}

function scheduledDateForNow(): string {
  const { hour, minute } = parseGenerateAt(getSettings().yinyi.generateAt)
  const now = new Date()
  const scheduled = new Date(now)
  scheduled.setHours(hour, minute, 0, 0)
  if (now.getTime() >= scheduled.getTime()) return todayIso()
  scheduled.setDate(scheduled.getDate() - 1)
  return localIsoDate(scheduled)
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

function broadcastYinyiGenerated(date: string, status: string): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('yinyi:generated', { date, status })
  }
}

export function registerScheduler(): void {
  rescheduleYinyi()
  rescheduleCarePings()
  rescheduleTasteProfile()
  recordHealth('scheduler', 'ok', '定时任务已恢复。')
}

export function rescheduleYinyi(): void {
  yinyiTask?.stop()
  yinyiTask = null

  const { hour, minute } = parseGenerateAt(getSettings().yinyi.generateAt)
  yinyiTask = cron.schedule(`${minute} ${hour} * * *`, async () => {
    try {
      const entry = await generateYinyi(todayIso())
      const status = entry.meta?.status === 'failed' ? 'failed' : 'completed'
      insertScheduledJob('yinyi_daily', entry.date, status, status === 'completed' ? '风信已生成。' : '风信生成失败。', entry.meta?.error)
      recordHealth('scheduler', status === 'completed' ? 'ok' : 'degraded', status === 'completed' ? '定时风信已生成。' : '定时风信生成失败。', entry.meta?.error)
      broadcastYinyiGenerated(entry.date, entry.meta?.status ?? 'ok')
    } catch (error) {
      const message = error instanceof Error ? error.message : '风信定时任务失败'
      insertScheduledJob('yinyi_daily', todayIso(), 'failed', '风信生成失败。', message)
      recordHealth('scheduler', 'error', '定时任务运行失败。', message)
    }
  })
}

export function rescheduleTasteProfile(): void {
  tasteStructuredTask?.stop()
  tastePortraitTask?.stop()

  tasteStructuredTask = cron.schedule(`${TASTE_STRUCTURED_TIME.minute} ${TASTE_STRUCTURED_TIME.hour} * * *`, () => {
    runTasteStructuredJob(todayIso()).catch(() => undefined)
  })
  tastePortraitTask = cron.schedule(`${TASTE_PORTRAIT_TIME.minute} ${TASTE_PORTRAIT_TIME.hour} * * *`, () => {
    runTastePortraitJob(todayIso()).catch(() => undefined)
  })
}

function hasNewTasteSignalsSinceLastStructured(): boolean {
  const profile = getTasteProfile()
  if (!profile) return false
  const lastSignalCount = profile.profile_meta?.signalCount ?? 0
  const latestFeedbackAt = getLatestFeedbackUpdatedAt()
  const structuredUpdatedAt = profile.profile_meta?.structuredUpdatedAt
  return getFeedbackSignalCount() > lastSignalCount || toTime(latestFeedbackAt) > toTime(structuredUpdatedAt)
}

function hasNewTasteSignalsSinceLastPortrait(date: string): boolean {
  const profile = getTasteProfile()
  if (!profile) return false
  const updatedAt = profile.profile_meta?.updatedAt
  const lastPortraitSignalCount = profile.profile_meta?.portraitSignalCount ?? 0
  const latestFeedbackAt = getLatestFeedbackUpdatedAt()
  if (!updatedAt) return true
  if (updatedAt.slice(0, 10) !== date) return true
  return getFeedbackSignalCount() > lastPortraitSignalCount || toTime(latestFeedbackAt) > toTime(updatedAt)
}

async function runTasteStructuredJob(date: string): Promise<SchedulerCatchupResult> {
  const latest = getLatestScheduledJob('taste_profile_structured', date)
  if (latest?.status === 'completed') {
    return { ok: true, job: 'taste_profile_structured', date, status: latest.status, message: latest.message ?? '结构画像今天已经处理过。' }
  }
  if (!getTasteProfile()) {
    if (latest?.status === 'skipped') {
      return { ok: true, job: 'taste_profile_structured', date, status: 'skipped', message: latest.message ?? '还没有画像，跳过结构刷新。' }
    }
    insertScheduledJob('taste_profile_structured', date, 'skipped', '还没有画像，跳过结构刷新。')
    return { ok: true, job: 'taste_profile_structured', date, status: 'skipped', message: '还没有画像，跳过结构刷新。' }
  }
  if (!hasNewTasteSignalsSinceLastStructured()) {
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
    recordHealth('scheduler', 'ok', message)
    return { ok: true, job: 'taste_profile_structured', date, status, message }
  } catch (error) {
    const message = error instanceof Error ? error.message : '结构画像刷新失败'
    insertScheduledJob('taste_profile_structured', date, 'failed', '结构画像刷新失败。', message)
    recordHealth('scheduler', 'degraded', '结构画像刷新失败。', message)
    return { ok: false, job: 'taste_profile_structured', date, status: 'failed', message }
  }
}

async function runTastePortraitJob(date: string): Promise<SchedulerCatchupResult> {
  const latest = getLatestScheduledJob('taste_profile_portrait', date)
  if (latest?.status === 'completed') {
    return { ok: true, job: 'taste_profile_portrait', date, status: latest.status, message: latest.message ?? '画像文案今天已经处理过。' }
  }
  if (!getTasteProfile()) {
    if (latest?.status === 'skipped') {
      return { ok: true, job: 'taste_profile_portrait', date, status: 'skipped', message: latest.message ?? '还没有画像，跳过文案刷新。' }
    }
    insertScheduledJob('taste_profile_portrait', date, 'skipped', '还没有画像，跳过文案刷新。')
    return { ok: true, job: 'taste_profile_portrait', date, status: 'skipped', message: '还没有画像，跳过文案刷新。' }
  }
  if (!hasNewTasteSignalsSinceLastPortrait(date)) {
    if (latest?.status === 'skipped') {
      return { ok: true, job: 'taste_profile_portrait', date, status: 'skipped', message: latest.message ?? '今天没有新增口味信号，跳过文案刷新。' }
    }
    insertScheduledJob('taste_profile_portrait', date, 'skipped', '今天没有新增口味信号，跳过文案刷新。')
    return { ok: true, job: 'taste_profile_portrait', date, status: 'skipped', message: '今天没有新增口味信号，跳过文案刷新。' }
  }
  try {
    await runTasteStructuredJob(date)
    const profile = await regeneratePortrait({ refreshStructured: false })
    const status = profile ? 'completed' : 'skipped'
    const message = profile ? '画像文案已刷新。' : '画像文案暂无可刷新内容。'
    insertScheduledJob('taste_profile_portrait', date, status, message)
    recordHealth('scheduler', 'ok', message)
    return { ok: true, job: 'taste_profile_portrait', date, status, message }
  } catch (error) {
    const message = error instanceof Error ? error.message : '画像文案刷新失败'
    insertScheduledJob('taste_profile_portrait', date, 'failed', '画像文案刷新失败。', message)
    recordHealth('scheduler', 'degraded', '画像文案刷新失败。', message)
    return { ok: false, job: 'taste_profile_portrait', date, status: 'failed', message }
  }
}

export function rescheduleCarePings(): void {
  carePingTasks.forEach((task) => task.stop())
  carePingTasks = []
  carePingRolloverTask?.stop()
  carePingRolloverTask = cron.schedule('5 0 * * *', () => rescheduleCarePings())
  carePingWatchdogTask?.stop()
  carePingWatchdogTask = cron.schedule('* * * * *', () => {
    runCarePingWatchdog().catch(() => undefined)
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
        const planned = parsePlannedAt(current.plannedAt)
        if (current.status === 'skipped' && current.message === '当前频率已关闭这个提醒时段。' && planned.getTime() > now.getTime()) {
          restoreCarePingPlan(current.id)
          return { ...current, status: 'planned' as const, message: '', error: '', ranAt: null }
        }
        if (current.status === 'skipped' && current.message === 'App 未在计划时间运行，已错过这次主动通知。' && shouldCatchUpCarePing(current, now)) {
          restoreCarePingPlan(current.id)
          return { ...current, status: 'planned' as const, message: '', error: '', ranAt: null }
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
    const planned = parsePlannedAt(record.plannedAt)
    if (planned.getTime() <= now.getTime()) {
      if (shouldCatchUpCarePing(record, now)) {
        executeCarePingPlan(record).catch(() => undefined)
      } else {
        updateCarePingPlanStatus(record.id, 'skipped', 'App 未在计划时间运行，已错过这次主动通知。')
        insertScheduledJob('care_ping', record.plannedAt, 'skipped', `${record.label}已错过。`)
      }
      continue
    }

    carePingTasks.push(cron.schedule(`${planned.getMinutes()} ${planned.getHours()} * * *`, () => {
      executeCarePingPlan(record).catch(() => undefined)
    }))
  }
}

async function runCarePingWatchdog(): Promise<void> {
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
    const planned = parsePlannedAt(record.plannedAt)
    const result = await runCarePingSlot({
      key: record.windowKey,
      label: record.label,
      hour: planned.getHours(),
      minute: planned.getMinutes(),
    })
    updateCarePingPlanStatus(record.id, result.status, result.message, result.error)
    insertScheduledJob('care_ping', record.plannedAt, result.status, result.message, result.error)
    if (result.status === 'completed') {
      recordHealth('scheduler', 'ok', '主动通知已发送。')
    }
    if (result.status === 'failed') {
      recordHealth('scheduler', 'degraded', '主动通知生成失败。', result.error)
    }
  } catch (error) {
    const message = error instanceof Error ? error.message : '主动通知定时任务失败'
    updateCarePingPlanStatus(record.id, 'failed', '主动通知定时任务失败。', message)
    insertScheduledJob('care_ping', record.plannedAt, 'failed', '主动通知定时任务失败。', message)
    recordHealth('scheduler', 'error', '定时任务运行失败。', message)
  } finally {
    runningCarePingPlanIds.delete(record.id)
  }
}

export function stopScheduler(): void {
  yinyiTask?.stop()
  yinyiTask = null
  carePingTasks.forEach((task) => task.stop())
  carePingTasks = []
  carePingRolloverTask?.stop()
  carePingRolloverTask = null
  carePingWatchdogTask?.stop()
  carePingWatchdogTask = null
  tasteStructuredTask?.stop()
  tasteStructuredTask = null
  tastePortraitTask?.stop()
  tastePortraitTask = null
  runningCarePingPlanIds.clear()
}

async function runYinyiCatchup(): Promise<SchedulerCatchupResult> {
  const date = scheduledDateForNow()
  const existing = getByDate(date)
  if (existing) {
    insertScheduledJob('yinyi_daily', date, 'skipped', '这一天已经有风信了。')
    recordHealth('scheduler', 'ok', '定时任务已恢复。')
    return { ok: true, job: 'yinyi_daily', date, status: 'skipped', message: '这一天已经有风信了。' }
  }

  const latest = getLatestScheduledJob('yinyi_daily', date)
  if (latest?.status === 'completed') {
    return { ok: true, job: 'yinyi_daily', date, status: 'skipped', message: '补偿任务已经完成过。' }
  }

  try {
    const entry = await generateYinyi(date)
    const status = entry.meta?.status === 'failed' ? 'failed' : 'completed'
    const message = status === 'completed' ? '已补写最近缺失的风信。' : '补写风信失败，已留下可重生成占位。'
    insertScheduledJob('yinyi_daily', date, status, message, entry.meta?.error)
    recordHealth('scheduler', status === 'completed' ? 'ok' : 'degraded', status === 'completed' ? '定时任务已恢复。' : '补写风信失败。', entry.meta?.error)
    broadcastYinyiGenerated(entry.date, entry.meta?.status ?? 'ok')
    return { ok: status === 'completed', job: 'yinyi_daily', date, status, message }
  } catch (error) {
    const message = error instanceof Error ? error.message : '补偿任务失败'
    insertScheduledJob('yinyi_daily', date, 'failed', '补偿任务失败。', message)
    recordHealth('scheduler', 'error', '定时任务运行失败。', message)
    return { ok: false, job: 'yinyi_daily', date, status: 'failed', message }
  }
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

export async function runTasteProfileCatchup(): Promise<SchedulerCatchupResult[]> {
  const results: SchedulerCatchupResult[] = []
  const structuredDate = scheduledDateForFixedTime(TASTE_STRUCTURED_TIME.hour, TASTE_STRUCTURED_TIME.minute)
  const portraitDate = scheduledDateForFixedTime(TASTE_PORTRAIT_TIME.hour, TASTE_PORTRAIT_TIME.minute)

  if (structuredDate === todayIso()) {
    results.push(await runTasteStructuredJob(structuredDate))
  }
  if (portraitDate === todayIso()) {
    results.push(await runTastePortraitJob(portraitDate))
  }
  return results
}
