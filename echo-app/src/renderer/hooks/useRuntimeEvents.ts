import { useEffect, useMemo, useState } from 'react'
import type { EchoApi, RuntimeEvent } from '../../types/ipc'

export interface RuntimeEventFilter {
  kinds?: string[]
  channels?: string[]
  taskId?: string
}

function eventTime(event: RuntimeEvent): number {
  const time = new Date(event.createdAt).getTime()
  return Number.isNaN(time) ? 0 : time
}

function filterKey(filter: RuntimeEventFilter): string {
  return JSON.stringify({
    kinds: filter.kinds ?? [],
    channels: filter.channels ?? [],
    taskId: filter.taskId ?? '',
  })
}

export function matchesRuntimeEvent(event: RuntimeEvent, filter: RuntimeEventFilter = {}): boolean {
  if (filter.taskId && event.taskId !== filter.taskId) return false
  if (filter.kinds?.length && !filter.kinds.includes(event.kind)) return false
  if (filter.channels?.length && !filter.channels.includes(event.channel)) return false
  return true
}

export function mergeRuntimeEvent(events: RuntimeEvent[], next: RuntimeEvent, limit = 50): RuntimeEvent[] {
  const withoutCurrent = events.filter((event) => event.id !== next.id)
  return [next, ...withoutCurrent]
    .sort((a, b) => eventTime(b) - eventTime(a))
    .slice(0, limit)
}

export function useRuntimeEvents(echo: EchoApi, filter: RuntimeEventFilter = {}, limit = 50): RuntimeEvent[] {
  const [events, setEvents] = useState<RuntimeEvent[]>([])
  const signature = useMemo(() => filterKey(filter), [filter])

  useEffect(() => {
    const parsedFilter = JSON.parse(signature) as RuntimeEventFilter
    setEvents([])
    return echo.runtime.onEvent((event) => {
      if (!matchesRuntimeEvent(event, parsedFilter)) return
      setEvents((current) => mergeRuntimeEvent(current, event, limit))
    })
  }, [echo, signature, limit])

  return events
}
