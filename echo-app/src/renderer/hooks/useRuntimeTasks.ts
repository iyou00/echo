import { useEffect, useState } from 'react'
import { RUNTIME_TASK_RECENT_LIMIT, type EchoApi, type RuntimeTaskSnapshot } from '../../types/ipc'

export interface RuntimeTaskGroup {
  task: RuntimeTaskSnapshot
  children: RuntimeTaskSnapshot[]
}

export interface RuntimeTaskQueryOptions {
  includeChildren?: boolean
}

function taskTime(task: RuntimeTaskSnapshot): number {
  const time = new Date(task.updatedAt).getTime()
  return Number.isNaN(time) ? 0 : time
}

function statusRank(task: RuntimeTaskSnapshot): number {
  if (task.status === 'running') return 0
  if (task.status === 'failed') return 1
  return 2
}

function compareRuntimeTasks(a: RuntimeTaskSnapshot, b: RuntimeTaskSnapshot): number {
  const statusDiff = statusRank(a) - statusRank(b)
  if (statusDiff !== 0) return statusDiff
  return taskTime(b) - taskTime(a)
}

function compareRuntimeTasksByUpdatedAt(a: RuntimeTaskSnapshot, b: RuntimeTaskSnapshot): number {
  return taskTime(b) - taskTime(a)
}

export function sortRuntimeTasksByUpdatedAt(tasks: RuntimeTaskSnapshot[]): RuntimeTaskSnapshot[] {
  return [...tasks].sort(compareRuntimeTasksByUpdatedAt)
}

export function mergeRuntimeTask(tasks: RuntimeTaskSnapshot[], next: RuntimeTaskSnapshot): RuntimeTaskSnapshot[] {
  const withoutCurrent = tasks.filter((task) => task.id !== next.id)
  return sortRuntimeTasksByUpdatedAt([next, ...withoutCurrent]).slice(0, RUNTIME_TASK_RECENT_LIMIT)
}

export function sortRuntimeTasksForDisplay(tasks: RuntimeTaskSnapshot[]): RuntimeTaskSnapshot[] {
  return [...tasks].sort(compareRuntimeTasks)
}

export function runtimeTaskNeedsAttention(task: RuntimeTaskSnapshot): boolean {
  return task.status === 'running' || task.status === 'failed'
}

function groupRank(group: RuntimeTaskGroup): number {
  return Math.min(statusRank(group.task), ...group.children.map(statusRank))
}

function groupTime(group: RuntimeTaskGroup): number {
  return Math.max(taskTime(group.task), ...group.children.map(taskTime))
}

export function groupRuntimeTasksForDisplay(tasks: RuntimeTaskSnapshot[]): RuntimeTaskGroup[] {
  const byId = new Map(tasks.map((task) => [task.id, task]))
  const childrenByParent = new Map<string, RuntimeTaskSnapshot[]>()

  function rootIdFor(task: RuntimeTaskSnapshot): string {
    let current = task
    const seen = new Set<string>()
    while (current.parentTaskId && byId.has(current.parentTaskId)) {
      if (seen.has(current.parentTaskId)) return task.id
      seen.add(current.id)
      current = byId.get(current.parentTaskId) ?? current
    }
    return current.id
  }

  for (const task of tasks) {
    const rootId = rootIdFor(task)
    if (rootId === task.id) continue
    const children = childrenByParent.get(rootId) ?? []
    children.push(task)
    childrenByParent.set(rootId, children)
  }

  const groups = tasks
    .filter((task) => rootIdFor(task) === task.id)
    .map((task) => ({
      task,
      children: sortRuntimeTasksForDisplay(childrenByParent.get(task.id) ?? []),
    }))

  return groups.sort((a, b) => {
    const rankDiff = groupRank(a) - groupRank(b)
    if (rankDiff !== 0) return rankDiff
    return groupTime(b) - groupTime(a)
  })
}

export function useRuntimeTasks(echo: EchoApi): RuntimeTaskSnapshot[] {
  const [tasks, setTasks] = useState<RuntimeTaskSnapshot[]>([])

  useEffect(() => {
    let alive = true

    echo.runtime.getRecentTasks()
      .then((items) => {
        if (alive) setTasks(sortRuntimeTasksByUpdatedAt(items).slice(0, RUNTIME_TASK_RECENT_LIMIT))
      })
      .catch(() => {
        if (alive) setTasks([])
      })

    const off = echo.runtime.onTaskChanged((snapshot) => {
      setTasks((current) => mergeRuntimeTask(current, snapshot))
    })
    const offSettings = echo.settings.onChanged((payload) => {
      if (payload.path === '*' && payload.value === null) setTasks([])
    })

    return () => {
      alive = false
      off()
      offSettings()
    }
  }, [echo])

  return tasks
}

export function latestRuntimeTask(tasks: RuntimeTaskSnapshot[], kinds: string[]): RuntimeTaskSnapshot | null {
  const wanted = new Set(kinds)
  return sortRuntimeTasksByUpdatedAt(tasks).find((task) => wanted.has(task.kind)) ?? null
}

export function latestRunningRuntimeTask(tasks: RuntimeTaskSnapshot[], kinds: string[], options: RuntimeTaskQueryOptions = {}): RuntimeTaskSnapshot | null {
  const wanted = new Set(kinds)
  const includeChildren = options.includeChildren ?? true
  return sortRuntimeTasksByUpdatedAt(tasks).find((task) => wanted.has(task.kind) && task.status === 'running' && (includeChildren || !task.parentTaskId)) ?? null
}
