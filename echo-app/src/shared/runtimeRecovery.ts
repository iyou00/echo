import type { RuntimeErrorKind, ServiceHealthKind } from '../types/ipc'

export function friendlyOperationError(error: unknown, fallback = '这次没有完成，请稍后再试。'): string {
  const raw = error instanceof Error ? error.message : String(error ?? '')
  const message = raw.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/i, '').trim()
  if (/取消|cancell?ed|aborted/i.test(message)) return '操作已取消。'
  if (/已有.+(?:任务|导入).+进行|正在进行，请稍后/i.test(message)) return '还有一个任务正在进行，完成后再试。'
  if (/API.?key|鉴权|unauthorized|401|403|模型配置|配置还没/i.test(message)) return '模型连接信息需要检查，请到设置里确认。'
  if (/网易云|cookie|登录.*过期/i.test(message)) return '网易云登录已经失效，请重新登录网易云。'
  if (/rate limit|too many requests|429|请求太频繁/i.test(message)) return '请求有点频繁，稍后再试。'
  if (/timeout|timed out|超时/i.test(message)) return '等待时间有点久，稍后再试。'
  if (/network|fetch failed|econn|enotfound|断网|网络/i.test(message)) return '网络连接没有接通，请检查网络后再试。'
  if (/需要是有效的 URL|只支持 http|完整的 TTS 服务地址/i.test(message)) return '服务地址格式需要检查。'
  if (/JSON|格式可能有问题|Unexpected token/i.test(message)) return '文件格式有问题，请检查后再试。'
  if (/安全存储|加密存储|密钥环/i.test(message)) return '系统加密存储暂时不可用，请检查系统凭据服务。'
  return fallback
}

export function runtimeErrorMessage(kind?: RuntimeErrorKind, fallback = '任务失败'): string {
  switch (kind) {
    case 'config':
      return '配置还没准备好。去设置页补齐模型端点、API Key 和模型名。'
    case 'auth':
      return '登录或鉴权失效。去设置页重新登录或检查 API Key。'
    case 'network':
      return '网络连接失败。检查网络、代理或服务端地址后重试。'
    case 'rate_limit':
      return '请求太频繁。稍等一会儿再试，或换一个额度充足的模型。'
    case 'server':
      return '服务端返回异常。稍后重试，或在设置页换一个服务端。'
    case 'timeout':
      return '请求超时。检查网络后重试，或换一个响应更快的端点。'
    case 'canceled':
      return '任务已取消。'
    case 'unknown':
    default:
      return fallback || '任务失败。'
  }
}

export function serviceHealthLabel(service: ServiceHealthKind): string {
  switch (service) {
    case 'llm':
      return 'AI 模型'
    case 'netease':
      return '网易云'
    case 'tts':
      return '语音'
    case 'weather':
      return '天气'
    case 'scheduler':
      return '定时任务'
    case 'scheduler-catchup':
      return '启动补偿'
    case 'scheduler-yinyi':
      return '定时风信'
    case 'scheduler-taste-structured':
      return '结构画像'
    case 'scheduler-taste-portrait':
      return '画像文案'
    case 'scheduler-care-ping':
      return '主动关心'
    case 'storage':
      return '加密存储'
    default:
      return service
  }
}

export function serviceRecoveryHint(service: ServiceHealthKind): string {
  switch (service) {
    case 'llm':
      return '检查 API Key、模型名和 Base URL。'
    case 'netease':
      return '重新登录网易云。'
    case 'tts':
      return '检查 TTS 地址和网络，失败时文字仍会保留。'
    case 'weather':
      return '设置城市或稍后重试。'
    case 'scheduler':
    case 'scheduler-catchup':
    case 'scheduler-yinyi':
    case 'scheduler-taste-structured':
    case 'scheduler-taste-portrait':
    case 'scheduler-care-ping':
      return '运行启动补偿，或重启应用恢复定时任务。'
    case 'storage':
      return '开启系统凭据服务后重新保存 API Key。'
    default:
      return '稍后重试。'
  }
}
