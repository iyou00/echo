import type { RuntimeTaskSnapshot } from './contracts'

export interface AgentRunContext {
  taskId: string
  signal: AbortSignal
  report(patch: Partial<RuntimeTaskSnapshot>): void
  emit(channel: string, payload: unknown): void
}

export interface EchoAgent<Input, Output> {
  kind: string
  run(input: Input, context: AgentRunContext): Promise<Output>
}
