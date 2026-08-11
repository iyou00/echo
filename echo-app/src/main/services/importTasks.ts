import { BrowserWindow } from 'electron'
import type { ImportProgressPayload, ImportTaskSnapshot } from '../../types/ipc'
import type { RuntimeTaskSnapshot } from '../../types/ipc'
import { getRunningTaskByUniqueKey, runTask } from '../runtime/runtime'
import { onRuntimeTaskChanged } from '../runtime/eventBus'

type ImportTaskKind = ImportTaskSnapshot['kind']
type ImportTaskReporter = (payload: Omit<ImportProgressPayload, 'startedAt'>) => void

type ImportTaskRunner<T> = (report: ImportTaskReporter, signal: AbortSignal) => Promise<T>

let currentTaskId: string | null = null
let currentSnapshot: ImportTaskSnapshot | null = null
let clearCompletedSnapshotTimer: ReturnType<typeof setTimeout> | null = null

const RUNTIME_IMPORT_UNIQUE_KEY = 'import'
const COMPLETED_IMPORT_SNAPSHOT_TTL_MS = 3000

const importKindToRuntime: Record<ImportTaskKind, string> = {
  'playlist-file': 'playlist-import',
  'netease-playlist': 'netease-playlist-import',
  'semantic-analysis': 'semantic-analysis',
}

const runtimeKindToImport: Record<string, ImportTaskKind> = {
  'playlist-import': 'playlist-file',
  'netease-playlist-import': 'netease-playlist',
  'semantic-analysis': 'semantic-analysis',
}

function broadcastImportTask(snapshot: ImportTaskSnapshot | null): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('import:changed', snapshot)
  }
}

function broadcastLegacyProgress(payload: ImportProgressPayload): void {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send('import:progress', payload)
  }
}

function toImportSnapshot(snapshot: RuntimeTaskSnapshot): ImportTaskSnapshot | null {
  const kind = runtimeKindToImport[snapshot.kind]
  if (!kind) return null
  return {
    id: snapshot.id,
    kind,
    status: snapshot.status === 'canceled' ? 'interrupted' : snapshot.status,
    phase: snapshot.phase === 'done' || snapshot.phase === 'profile' || snapshot.phase === 'semantics'
      ? snapshot.phase
      : 'preparing',
    current: snapshot.current,
    total: snapshot.total,
    startedAt: snapshot.startedAt,
    updatedAt: snapshot.updatedAt,
    finishedAt: snapshot.finishedAt,
    sourceName: snapshot.sourceName,
    message: snapshot.message,
    error: snapshot.error,
  }
}

function setImportSnapshot(snapshot: ImportTaskSnapshot | null): void {
  if (clearCompletedSnapshotTimer) {
    clearTimeout(clearCompletedSnapshotTimer)
    clearCompletedSnapshotTimer = null
  }
  currentSnapshot = snapshot
  broadcastImportTask(snapshot)
  if (snapshot && (snapshot.phase === 'semantics' || snapshot.phase === 'profile' || snapshot.phase === 'done')) {
    broadcastLegacyProgress({
      phase: snapshot.phase,
      current: snapshot.current,
      total: snapshot.total,
      startedAt: snapshot.startedAt,
    })
  }
}

onRuntimeTaskChanged((snapshot) => {
  if (!currentTaskId || snapshot.id !== currentTaskId) return
  const mapped = toImportSnapshot(snapshot)
  if (!mapped) return
  setImportSnapshot(mapped)
  if (mapped.status !== 'running') {
    currentTaskId = null
    const completedTaskId = mapped.id
    clearCompletedSnapshotTimer = setTimeout(() => {
      clearCompletedSnapshotTimer = null
      if (currentSnapshot?.id === completedTaskId && currentSnapshot.status !== 'running') {
        setImportSnapshot(null)
      }
    }, COMPLETED_IMPORT_SNAPSHOT_TTL_MS)
  }
})

export function getImportTaskSnapshot(): ImportTaskSnapshot | null {
  return currentSnapshot
}

export function hasRunningImportTask(): boolean {
  return Boolean(getRunningTaskByUniqueKey(RUNTIME_IMPORT_UNIQUE_KEY))
}

export function reportStandaloneImportProgress(payload: ImportProgressPayload): void {
  broadcastLegacyProgress(payload)
}

export function clearImportTaskSnapshot(): void {
  currentTaskId = null
  if (clearCompletedSnapshotTimer) {
    clearTimeout(clearCompletedSnapshotTimer)
    clearCompletedSnapshotTimer = null
  }
  setImportSnapshot(null)
}

export async function runImportTask<T>(kind: ImportTaskKind, sourceName: string | undefined, runner: ImportTaskRunner<T>): Promise<T> {
  if (hasRunningImportTask()) {
    throw new Error('已有导入任务正在进行，请稍后再试。')
  }

  return runTask({
    kind: importKindToRuntime[kind],
    sourceName,
    uniqueKey: RUNTIME_IMPORT_UNIQUE_KEY,
    phase: 'preparing',
    cancellable: false,
  }, async (context) => {
    currentTaskId = context.taskId
    context.report({ phase: 'preparing', current: 0, total: 0 })
    const report: ImportTaskReporter = (payload) => {
      context.report({
        phase: payload.phase,
        current: payload.current,
        total: payload.total,
      })
    }
    const result = await runner(report, context.signal)
    context.report({
      phase: 'done',
      current: 1,
      total: 1,
      message: sourceName ? `${sourceName} 导入完成` : '导入完成',
    })
    return result
  })
}
