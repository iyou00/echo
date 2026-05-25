import type { RuntimeErrorKind, ServiceHealthKind } from '../types/ipc'

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
      return '重新扫码登录网易云。'
    case 'tts':
      return '检查 TTS 地址和网络，失败时文字仍会保留。'
    case 'weather':
      return '设置城市或稍后重试。'
    case 'scheduler':
      return '运行启动补偿，或重启应用恢复定时任务。'
    case 'storage':
      return '开启系统凭据服务后重新保存 API Key。'
    default:
      return '稍后重试。'
  }
}
