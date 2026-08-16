import type { ServiceHealth, ServiceHealthKind, ServiceHealthStatus } from '../../types/ipc'
import { getDb } from './index'

const HEALTH_DEFAULTS: Record<ServiceHealthKind, string> = {
  llm: '模型状态还没检查。',
  netease: '网易云状态还没检查。',
  tts: '语音状态还没检查。',
  weather: '天气状态还没检查。',
  scheduler: '定时任务状态还没检查。',
  'scheduler-catchup': '启动补偿状态还没检查。',
  'scheduler-yinyi': '风信定时任务状态还没检查。',
  'scheduler-taste-structured': '结构画像定时任务状态还没检查。',
  'scheduler-taste-portrait': '画像文案定时任务状态还没检查。',
  'scheduler-care-ping': '主动关心定时任务状态还没检查。',
  "scheduler-dream": "夜间复盘",
  storage: '本地加密存储还没检查。',
}

function toHealth(row: Record<string, unknown>): ServiceHealth {
  return {
    service: String(row.service) as ServiceHealthKind,
    status: String(row.status) as ServiceHealthStatus,
    message: String(row.message ?? ''),
    checkedAt: typeof row.checked_at === 'string' ? row.checked_at : undefined,
    technical: typeof row.technical === 'string' && row.technical ? row.technical : undefined,
  }
}

export function upsertHealth(service: ServiceHealthKind, status: ServiceHealthStatus, message: string, technical = ''): ServiceHealth {
  getDb()
    .prepare(`
      INSERT INTO service_health (service, status, message, technical, checked_at)
      VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(service) DO UPDATE SET
        status = excluded.status,
        message = excluded.message,
        technical = excluded.technical,
        checked_at = CURRENT_TIMESTAMP
    `)
    .run(service, status, message, technical)
  const row = getDb().prepare('SELECT * FROM service_health WHERE service = ?').get(service) as Record<string, unknown>
  return toHealth(row)
}

export function getHealth(service: ServiceHealthKind): ServiceHealth {
  const row = getDb().prepare('SELECT * FROM service_health WHERE service = ?').get(service) as Record<string, unknown> | undefined
  return row ? toHealth(row) : {
    service,
    status: 'unknown',
    message: HEALTH_DEFAULTS[service],
  }
}

export function listHealth(): ServiceHealth[] {
  return (Object.keys(HEALTH_DEFAULTS) as ServiceHealthKind[]).map(getHealth)
}
