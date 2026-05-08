import { BrowserWindow } from 'electron'
import type { ImportProgressPayload, ImportTaskSnapshot } from '../../types/ipc'

type ImportTaskKind = ImportTaskSnapshot['kind']
type ImportTaskReporter = (payload: Omit<ImportProgressPayload, 'startedAt'>) => void

type ImportTaskRunner<T> = (report: ImportTaskReporter) => Promise<T>

let currentSnapshot: ImportTaskSnapshot | null = null
let taskSequence = 0

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

function updateSnapshot(patch: Partial<ImportTaskSnapshot>): ImportTaskSnapshot {
  if (!currentSnapshot) throw new Error('当前没有导入任务')
  currentSnapshot = {
    ...currentSnapshot,
    ...patch,
    updatedAt: new Date().toISOString(),
  }
  broadcastImportTask(currentSnapshot)
  if (currentSnapshot.phase === 'semantics' || currentSnapshot.phase === 'profile' || currentSnapshot.phase === 'done') {
    broadcastLegacyProgress({
      phase: currentSnapshot.phase,
      current: currentSnapshot.current,
      total: currentSnapshot.total,
      startedAt: currentSnapshot.startedAt,
    })
  }
  return currentSnapshot
}

export function getImportTaskSnapshot(): ImportTaskSnapshot | null {
  return currentSnapshot
}

export function hasRunningImportTask(): boolean {
  return currentSnapshot?.status === 'running'
}

export function reportStandaloneImportProgress(payload: ImportProgressPayload): void {
  broadcastLegacyProgress(payload)
}

export function clearImportTaskSnapshot(): void {
  currentSnapshot = null
  broadcastImportTask(null)
}

export async function runImportTask<T>(kind: ImportTaskKind, sourceName: string | undefined, runner: ImportTaskRunner<T>): Promise<T> {
  if (hasRunningImportTask()) {
    throw new Error('已有导入任务正在进行，请稍后再试。')
  }

  const startedAt = new Date().toISOString()
  currentSnapshot = {
    id: `${Date.now()}-${++taskSequence}`,
    kind,
    status: 'running',
    phase: 'preparing',
    current: 0,
    total: 0,
    startedAt,
    updatedAt: startedAt,
    sourceName,
  }
  broadcastImportTask(currentSnapshot)

  const report: ImportTaskReporter = (payload) => {
    updateSnapshot({
      phase: payload.phase,
      current: payload.current,
      total: payload.total,
    })
  }

  try {
    const result = await runner(report)
    updateSnapshot({
      status: 'succeeded',
      phase: 'done',
      current: 1,
      total: 1,
      finishedAt: new Date().toISOString(),
      message: sourceName ? `${sourceName} 导入完成` : '导入完成',
    })
    return result
  } catch (error) {
    updateSnapshot({
      status: 'failed',
      finishedAt: new Date().toISOString(),
      error: error instanceof Error ? error.message : '导入失败',
    })
    throw error
  }
}
