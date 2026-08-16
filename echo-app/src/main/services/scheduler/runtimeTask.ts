import { runTask } from '../../runtime/runtime'
import type { AgentRunContext } from '../../runtime/agent'

export type SchedulerRuntimeTaskKind = 'yinyi-generate' | 'care-ping' | 'taste-refresh' | 'scheduler-catchup' | 'dream-review'

export interface SchedulerRuntimeResult {
  status: string
  message: string
}

export interface SchedulerRuntimeTaskInput {
  kind: SchedulerRuntimeTaskKind
  phase: string
  uniqueKey: string
  sourceName?: string
}

export function runSchedulerResultTask<T extends SchedulerRuntimeResult>(
  input: SchedulerRuntimeTaskInput,
  runner: (context: AgentRunContext) => Promise<T>,
): Promise<T> {
  return runTask({
    kind: input.kind,
    phase: input.phase,
    current: 0,
    total: 1,
    sourceName: input.sourceName,
    uniqueKey: input.uniqueKey,
    cancellable: false,
    visibility: 'internal',
    isFailureResult: (result) => result.status === 'failed',
    messageForResult: (result) => result.message,
  }, async (context) => {
    const result = await runner(context)
    context.report({
      phase: 'done',
      current: 1,
      total: 1,
      message: result.message,
      error: result.status === 'failed' ? result.message : undefined,
    })
    return result
  })
}
