import type { RuntimeErrorKind } from './contracts'

export class RuntimeCanceledError extends Error {
  constructor(message = '任务已取消') {
    super(message)
    this.name = 'RuntimeCanceledError'
  }
}

function isRuntimeErrorKind(value: unknown): value is RuntimeErrorKind {
  return value === 'config'
    || value === 'network'
    || value === 'auth'
    || value === 'rate_limit'
    || value === 'server'
    || value === 'timeout'
    || value === 'canceled'
    || value === 'unknown'
}

function errorName(error: unknown): string {
  return error instanceof Error ? error.name : ''
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error ?? '')
}

function isCanceledMessage(message: string): boolean {
  const normalized = message.trim().toLowerCase()
  return normalized === '任务已取消'
    || normalized === 'canceled'
    || normalized === 'cancelled'
    || normalized === 'aborted'
    || normalized === 'the operation was aborted'
}

export function getRuntimeErrorKind(error: unknown): RuntimeErrorKind {
  const name = errorName(error)
  const message = errorMessage(error)

  if (error instanceof RuntimeCanceledError) return 'canceled'
  if (name === 'AbortError') return 'canceled'
  if (isCanceledMessage(message)) return 'canceled'
  if (error instanceof DOMException && error.name === 'TimeoutError') return 'timeout'
  if (/timeout|timed out|超时/i.test(message)) return 'timeout'
  if (name === 'NeteaseAuthRequiredError') return 'auth'
  if (/请先登录网易云|登录.*过期|鉴权|unauthorized|401|403|api key/i.test(message)) return 'auth'
  if (/rate limit|too many requests|429|请求太频繁/i.test(message)) return 'rate_limit'
  if (/network|fetch failed|econn|enotfound|断网|网络/i.test(message)) return 'network'
  if (/配置|config|base url|model/i.test(message)) return 'config'
  if (/服务端|server|5\d\d/i.test(message)) return 'server'

  if (error && typeof error === 'object' && 'kind' in error) {
    const kind = (error as { kind?: unknown }).kind
    if (isRuntimeErrorKind(kind)) return kind
    if (kind === 'HTTP_ERROR') return 'server'
    if (kind === 'NETWORK_ERROR') return 'network'
  }

  return 'unknown'
}

export function assertRuntimeActive(signal: AbortSignal): void {
  if (signal.aborted) throw new RuntimeCanceledError()
}
