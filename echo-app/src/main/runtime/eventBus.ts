import type { RuntimeEvent, RuntimeTaskSnapshot } from './contracts'

type TaskListener = (snapshot: RuntimeTaskSnapshot) => void
type EventListener = (event: RuntimeEvent) => void
type RuntimeBroadcaster = (channel: string, payload: unknown) => void

const taskListeners = new Set<TaskListener>()
const eventListeners = new Set<EventListener>()
let broadcaster: RuntimeBroadcaster | null = null
let eventSequence = 0

function reportListenerError(error: unknown): void {
  console.error('[runtime] listener failed', error)
}

export function setRuntimeBroadcaster(next: RuntimeBroadcaster): void {
  broadcaster = next
}

export function onRuntimeTaskChanged(listener: TaskListener): () => void {
  taskListeners.add(listener)
  return () => taskListeners.delete(listener)
}

export function onRuntimeEvent(listener: EventListener): () => void {
  eventListeners.add(listener)
  return () => eventListeners.delete(listener)
}

export function emitRuntimeTaskChanged(snapshot: RuntimeTaskSnapshot): void {
  for (const listener of Array.from(taskListeners)) {
    try {
      listener(structuredClone(snapshot))
    } catch (error) {
      reportListenerError(error)
    }
  }
  try {
    broadcaster?.('runtime:task-changed', structuredClone(snapshot))
  } catch (error) {
    reportListenerError(error)
  }
}

export function emitRuntimeEvent(input: Omit<RuntimeEvent, 'id' | 'createdAt'>): RuntimeEvent {
  const event: RuntimeEvent = {
    ...input,
    id: `${Date.now()}-${++eventSequence}`,
    createdAt: new Date().toISOString(),
  }
  for (const listener of Array.from(eventListeners)) {
    try {
      listener(structuredClone(event))
    } catch (error) {
      reportListenerError(error)
    }
  }
  try {
    broadcaster?.('runtime:event', structuredClone(event))
    if (event.channel) broadcaster?.(event.channel, structuredClone(event.payload))
  } catch (error) {
    reportListenerError(error)
  }
  return structuredClone(event)
}
