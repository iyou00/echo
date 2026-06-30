import { AsyncLocalStorage } from 'node:async_hooks'
import { recordHealth } from '../services/health'
import type { AgentRunContext, EchoAgent } from './agent'
import type { RuntimeTaskSnapshot, RuntimeTaskStartOptions } from './contracts'
import { RuntimeCanceledError, assertRuntimeActive, getRuntimeErrorKind } from './errors'
import { emitRuntimeEvent } from './eventBus'
import {
  cancelTask,
  cancelTasksByKind,
  clearRuntimeTasks,
  failTask,
  finishTask,
  getRecentTasks,
  getRunningTaskByUniqueKey,
  getTask,
  startTask,
  updateTask,
} from './taskRegistry'

export interface RunTaskOptions<T = unknown> extends RuntimeTaskStartOptions {
  healthService?: Parameters<typeof recordHealth>[0]
  isFailureResult?: (result: T) => boolean
  messageForResult?: (result: T) => string | undefined
}

const runtimeTaskScope = new AsyncLocalStorage<string>()

export async function runTask<T>(options: RunTaskOptions<T>, runner: (context: AgentRunContext) => Promise<T>): Promise<T> {
  const parentTaskId = options.parentTaskId ?? runtimeTaskScope.getStore()
  const parentVisibility = parentTaskId ? getTask(parentTaskId)?.visibility : undefined
  const record = startTask({
    ...options,
    parentTaskId,
    visibility: options.visibility ?? parentVisibility ?? 'user',
  })
  const context: AgentRunContext = {
    taskId: record.snapshot.id,
    signal: record.controller.signal,
    report: (patch) => {
      assertRuntimeActive(record.controller.signal)
      updateTask(record.snapshot.id, patch)
    },
    emit: (channel, payload) => {
      assertRuntimeActive(record.controller.signal)
      emitRuntimeEvent({
        taskId: record.snapshot.id,
        kind: record.snapshot.kind,
        channel,
        payload,
        visibility: record.snapshot.visibility,
      })
    },
  }

  return runtimeTaskScope.run(record.snapshot.id, async () => {
    try {
      assertRuntimeActive(record.controller.signal)
      const result = await runner(context)
      assertRuntimeActive(record.controller.signal)
      const resultMessage = options.messageForResult?.(result) ?? options.message
      const successPatch: Partial<RuntimeTaskSnapshot> = {
        phase: 'done',
        current: record.snapshot.total > 0 ? record.snapshot.total : record.snapshot.current,
      }
      if (resultMessage) successPatch.message = resultMessage
      if (options.isFailureResult?.(result)) {
        finishTask(record.snapshot.id, 'failed', {
          ...successPatch,
          phase: 'failed',
          current: record.snapshot.current,
          error: resultMessage ?? '任务失败',
          errorKind: 'unknown',
        })
        if (options.healthService) recordHealth(options.healthService, 'degraded', resultMessage ?? '运行任务失败。')
        return result
      }
      finishTask(record.snapshot.id, 'succeeded', successPatch)
      if (options.healthService) recordHealth(options.healthService, 'ok', '运行任务完成。')
      return result
    } catch (error) {
      const kind = getRuntimeErrorKind(error)
      if (kind === 'canceled') {
        finishTask(record.snapshot.id, 'canceled', { errorKind: 'canceled', message: '任务已取消' })
      } else {
        failTask(record.snapshot.id, error, kind)
        if (options.healthService) {
          recordHealth(options.healthService, 'degraded', '运行任务失败。', error instanceof Error ? error.message : String(error))
        }
      }
      throw error
    }
  })
}

export function runAgent<Input, Output>(
  agent: EchoAgent<Input, Output>,
  input: Input,
  options: Omit<RunTaskOptions<Output>, 'kind'> = {},
): Promise<Output> {
  return runTask({ ...options, kind: agent.kind }, (context) => agent.run(input, context))
}

export function emitEvent(kind: string, channel: string, payload: unknown, taskId?: string): void {
  emitRuntimeEvent({ kind, channel, payload, taskId, visibility: taskId ? getTask(taskId)?.visibility ?? 'user' : 'user' })
}

export function withRuntimeHealth<T>(service: Parameters<typeof recordHealth>[0], run: () => Promise<T>): Promise<T> {
  return run()
    .then((result) => {
      recordHealth(service, 'ok', '服务运行正常。')
      return result
    })
    .catch((error) => {
      recordHealth(service, 'degraded', '服务运行失败。', error instanceof Error ? error.message : String(error))
      throw error
    })
}

export function getCurrentRuntimeTaskId(): string | undefined {
  return runtimeTaskScope.getStore()
}

export { cancelTask, cancelTasksByKind, clearRuntimeTasks, getRecentTasks, getRunningTaskByUniqueKey, getTask, updateTask }
export { RuntimeCanceledError, getRuntimeErrorKind }
export type { RuntimeTaskSnapshot }
