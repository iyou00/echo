import { RUNTIME_TASK_RECENT_LIMIT } from '../../types/ipc'
import { runtimeErrorMessage } from '../../shared/runtimeRecovery'
import type { RuntimeErrorKind, RuntimeTaskRecord, RuntimeTaskSnapshot, RuntimeTaskStartOptions } from './contracts'
import { emitRuntimeTaskChanged } from './eventBus'

const running = new Map<string, RuntimeTaskRecord>()
const recent: RuntimeTaskSnapshot[] = []
let taskSequence = 0

function nowIso(): string {
  return new Date().toISOString()
}

function clone(snapshot: RuntimeTaskSnapshot): RuntimeTaskSnapshot {
  return structuredClone(snapshot)
}

function snapshotTime(snapshot: RuntimeTaskSnapshot): number {
  const time = new Date(snapshot.updatedAt).getTime()
  return Number.isNaN(time) ? 0 : time
}

function sortSnapshotsByUpdatedAt(snapshots: RuntimeTaskSnapshot[]): RuntimeTaskSnapshot[] {
  return [...snapshots].sort((a, b) => snapshotTime(b) - snapshotTime(a))
}

function remember(snapshot: RuntimeTaskSnapshot): void {
  recent.unshift(clone(snapshot))
  recent.splice(RUNTIME_TASK_RECENT_LIMIT)
}

function markCanceling(record: RuntimeTaskRecord): void {
  if (record.controller.signal.aborted && record.snapshot.phase === 'canceling') return
  record.controller.abort()
  record.snapshot = {
    ...record.snapshot,
    phase: 'canceling',
    message: '正在取消任务',
    updatedAt: nowIso(),
  }
  emitRuntimeTaskChanged(record.snapshot)
}

function descendantRecords(parentTaskId: string, visited = new Set<string>()): RuntimeTaskRecord[] {
  if (visited.has(parentTaskId)) return []
  visited.add(parentTaskId)
  const direct = Array.from(running.values()).filter((record) => record.snapshot.parentTaskId === parentTaskId)
  return direct.flatMap((record) => [record, ...descendantRecords(record.snapshot.id, visited)])
}

export function startTask(options: RuntimeTaskStartOptions): RuntimeTaskRecord {
  if (options.uniqueKey) {
    const existing = Array.from(running.values()).find((record) => record.uniqueKey === options.uniqueKey)
    if (existing) throw new Error('已有任务正在进行，请稍后再试。')
  }

  const startedAt = nowIso()
  const snapshot: RuntimeTaskSnapshot = {
    id: `${Date.now()}-${++taskSequence}`,
    parentTaskId: options.parentTaskId,
    kind: options.kind,
    status: 'running',
    phase: options.phase ?? 'preparing',
    current: options.current ?? 0,
    total: options.total ?? 0,
    startedAt,
    updatedAt: startedAt,
    sourceName: options.sourceName,
    message: options.message,
    cancellable: options.cancellable ?? true,
  }
  const record: RuntimeTaskRecord = {
    snapshot,
    controller: new AbortController(),
    uniqueKey: options.uniqueKey,
  }
  running.set(snapshot.id, record)
  emitRuntimeTaskChanged(snapshot)
  return record
}

export function updateTask(id: string, patch: Partial<RuntimeTaskSnapshot>): RuntimeTaskSnapshot {
  const record = running.get(id)
  if (!record) throw new Error('运行任务不存在')
  record.snapshot = {
    ...record.snapshot,
    ...patch,
    id: record.snapshot.id,
    kind: record.snapshot.kind,
    updatedAt: nowIso(),
  }
  emitRuntimeTaskChanged(record.snapshot)
  return clone(record.snapshot)
}

export function finishTask(
  id: string,
  status: RuntimeTaskSnapshot['status'],
  patch: Partial<RuntimeTaskSnapshot> = {},
): RuntimeTaskSnapshot {
  const record = running.get(id)
  if (!record) throw new Error('运行任务不存在')
  record.snapshot = {
    ...record.snapshot,
    ...patch,
    id: record.snapshot.id,
    kind: record.snapshot.kind,
    status,
    updatedAt: nowIso(),
    finishedAt: nowIso(),
  }
  running.delete(id)
  remember(record.snapshot)
  emitRuntimeTaskChanged(record.snapshot)
  return clone(record.snapshot)
}

export function failTask(id: string, error: unknown, errorKind: RuntimeErrorKind = 'unknown'): RuntimeTaskSnapshot {
  const rawMessage = error instanceof Error ? error.message : String(error || '任务失败')
  return finishTask(id, 'failed', {
    error: runtimeErrorMessage(errorKind, rawMessage),
    errorKind,
  })
}

export function cancelTask(id: string): boolean {
  const record = running.get(id)
  if (!record) return false
  if (!record.snapshot.cancellable) return false
  markCanceling(record)
  descendantRecords(id).forEach(markCanceling)
  return true
}

export function cancelTasksByKind(kind: string): number {
  let count = 0
  for (const record of Array.from(running.values())) {
    if (record.snapshot.kind !== kind || !record.snapshot.cancellable) continue
    markCanceling(record)
    descendantRecords(record.snapshot.id).forEach(markCanceling)
    count += 1
  }
  return count
}

export function getTask(id: string): RuntimeTaskSnapshot | null {
  const snapshot = running.get(id)?.snapshot ?? recent.find((task) => task.id === id) ?? null
  return snapshot ? clone(snapshot) : null
}

export function getRunningTaskByUniqueKey(uniqueKey: string): RuntimeTaskSnapshot | null {
  const record = Array.from(running.values()).find((item) => item.uniqueKey === uniqueKey)
  return record ? clone(record.snapshot) : null
}

export function getRecentTasks(): RuntimeTaskSnapshot[] {
  return sortSnapshotsByUpdatedAt([
    ...Array.from(running.values()).map((record) => clone(record.snapshot)),
    ...recent.map(clone),
  ]).slice(0, RUNTIME_TASK_RECENT_LIMIT)
}

export function clearRuntimeTasks(): void {
  for (const record of Array.from(running.values())) record.controller.abort()
  running.clear()
  recent.length = 0
}
