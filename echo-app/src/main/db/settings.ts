import type { Settings, SettingPath, SettingUpdatePatch } from '../../types/ipc'
import { getDb } from './index'
import { parseJson } from './json'
import {
  decryptSecret,
  encryptSecret,
  isLegacyPlain,
  isSecureStorageAvailable,
  StorageUnavailableError,
  tryUpgradeLegacyPlain,
} from '../utils/secureStorage'
import { upsertHealth } from './health'

export type { SettingPath, SettingUpdatePatch }

const defaultSettings: Settings = {
  llm: {
    baseUrl: '',
    apiKey: '',
    model: '',
  },
  yinyi: {
    generateAt: '22:00',
    openWithRandom: false,
  },
  dream: {
    enabled: true,
    reviewAt: '23:30',
  },
  carePings: {
    enabled: false,
    frequency: 'normal',
    detectFullscreen: true,
    quietHours: {
      enabled: true,
      start: '22:30',
      end: '08:30',
    },
    pausedUntil: '',
  },
  chat: {
    restoreOnStart: true,
  },
  playback: {
    autoPlayNext: true,
  },
  ui: {
    theme: 'system',
    closeBehavior: 'ask',
    windowSize: 'standard',
  },
  window: {
    closeHintShown: false,
  },
  user: {
    city: '',
  },
  tts: {
    baseUrl: 'https://tts.wangwangit.com',
    voice: 'zh-CN-XiaochenNeural',
    speed: 1.0,
    pitch: '0',
  },
  meta: {
    schemaVersion: 1,
    firstUsedAt: new Date().toISOString(),
    lastViewedYinyiAt: '',
    onboardingStep: 'api',
    lastPrunedAt: '',
  },
}

export const SETTINGS_PATHS: readonly SettingPath[] = [
  'llm.baseUrl',
  'llm.apiKey',
  'llm.model',
  'llm.lastTestedAt',
  'llm.lastTestedOk',
  'yinyi.generateAt',
  'yinyi.openWithRandom',
  'dream.enabled',
  'dream.reviewAt',
  'carePings.enabled',
  'carePings.frequency',
  'carePings.detectFullscreen',
  'carePings.quietHours.enabled',
  'carePings.quietHours.start',
  'carePings.quietHours.end',
  'carePings.pausedUntil',
  'chat.restoreOnStart',
  'chat.translateRouter',
  'playback.autoPlayNext',
  'ui.theme',
  'ui.closeBehavior',
  'ui.windowSize',
  'window.closeHintShown',
  'user.city',
  'tts.baseUrl',
  'tts.voice',
  'tts.speed',
  'tts.pitch',
  'meta.schemaVersion',
  'meta.firstUsedAt',
  'meta.lastViewedYinyiAt',
  'meta.firstRunWelcomeCompletedAt',
  'meta.onboardingCompletedAt',
  'meta.onboardingStep',
  'meta.lastPrunedAt',
] as const

const SETTINGS_PATH_SET = new Set<string>(SETTINGS_PATHS)

function assertSettingPath(path: string): asserts path is SettingPath {
  if (!SETTINGS_PATH_SET.has(path)) {
    throw new Error(`未知设置项: ${path}`)
  }
}

function assertString(value: unknown, path: SettingPath): string {
  if (typeof value !== 'string') throw new Error(`${path} 需要是文本`)
  return value
}

function assertBoolean(value: unknown, path: SettingPath): boolean {
  if (typeof value !== 'boolean') throw new Error(`${path} 需要是布尔值`)
  return value
}

function assertNumber(value: unknown, path: SettingPath): number {
  if (typeof value !== 'number' || !Number.isFinite(value)) throw new Error(`${path} 需要是数字`)
  return value
}

function assertOneOf<T extends string>(value: unknown, path: SettingPath, allowed: readonly T[]): T {
  if (typeof value !== 'string' || !allowed.includes(value as T)) {
    throw new Error(`${path} 的值无效`)
  }
  return value as T
}

function assertOptionalString(value: unknown, path: SettingPath): string | undefined {
  if (value === undefined) return undefined
  return assertString(value, path)
}

function assertHttpUrl(value: unknown, path: SettingPath, options: { allowEmpty?: boolean } = {}): string {
  const text = assertString(value, path).trim()
  if (!text && options.allowEmpty) return ''
  let parsed: URL
  try {
    parsed = new URL(text)
  } catch {
    throw new Error(`${path} 需要是有效的 URL`)
  }
  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${path} 只支持 http 或 https`)
  }
  return text
}

function isValidClockTime(value: string): boolean {
  const match = /^(\d{2}):(\d{2})$/.exec(value)
  if (!match) return false
  return Number(match[1]) <= 23 && Number(match[2]) <= 59
}

function validateSettingValue(path: SettingPath, value: unknown): unknown {
  switch (path) {
    case 'llm.baseUrl':
      return assertHttpUrl(value, path, { allowEmpty: true })
    case 'tts.baseUrl':
      return assertHttpUrl(value, path, { allowEmpty: true })
    case 'llm.apiKey':
    case 'llm.model':
    case 'llm.lastTestedAt':
    case 'user.city':
    case 'tts.voice':
    case 'tts.pitch':
    case 'meta.firstUsedAt':
      return assertString(value, path)
    case 'meta.lastViewedYinyiAt':
    case 'meta.firstRunWelcomeCompletedAt':
    case 'meta.onboardingCompletedAt':
    case 'meta.lastPrunedAt':
      return assertOptionalString(value, path)
    case 'llm.lastTestedOk':
    case 'yinyi.openWithRandom':
    case 'dream.enabled':
    case 'carePings.enabled':
    case 'carePings.detectFullscreen':
    case 'carePings.quietHours.enabled':
    case 'chat.restoreOnStart':
    case 'chat.translateRouter':
    case 'playback.autoPlayNext':
    case 'window.closeHintShown':
      return assertBoolean(value, path)
    case 'yinyi.generateAt': {
      const text = assertString(value, path)
      if (!isValidClockTime(text)) throw new Error('生成时间格式需要是 HH:mm')
      return text
    }
    case 'dream.reviewAt': {
      const text = assertString(value, path)
      if (!isValidClockTime(text)) throw new Error('复盘时间格式需要是 HH:mm')
      return text
    }
    case 'carePings.quietHours.start':
    case 'carePings.quietHours.end': {
      const text = assertString(value, path)
      if (!isValidClockTime(text)) throw new Error(`${path} 格式需要是 HH:mm`)
      return text
    }
    case 'carePings.pausedUntil': {
      const text = assertString(value, path).trim()
      if (text && Number.isNaN(Date.parse(text))) throw new Error('暂停截止时间无效')
      return text
    }
    case 'carePings.frequency':
      return assertOneOf(value, path, ['gentle', 'normal', 'frequent'])
    case 'ui.theme':
      return assertOneOf(value, path, ['light', 'dark', 'system'])
    case 'ui.closeBehavior':
      return assertOneOf(value, path, ['ask', 'minimize', 'quit'])
    case 'ui.windowSize':
      return assertOneOf(value, path, ['compact', 'standard', 'large'])
    case 'tts.speed': {
      const speed = assertNumber(value, path)
      if (speed < 0.5 || speed > 1.5) throw new Error('语速需要在 0.5 到 1.5 之间')
      return speed
    }
    case 'meta.schemaVersion': {
      const version = assertNumber(value, path)
      if (!Number.isInteger(version) || version < 1) throw new Error('设置版本号无效')
      return version
    }
    case 'meta.onboardingStep':
      return assertOneOf(value, path, ['api', 'playlist', 'done'])
  }
}

function mergeDefaults(value: Partial<Settings>): Settings {
  const firstUsedAt = typeof value.meta?.firstUsedAt === 'string' && value.meta.firstUsedAt.trim()
    ? value.meta.firstUsedAt
    : new Date().toISOString()
  return {
    ...defaultSettings,
    ...value,
    llm: { ...defaultSettings.llm, ...(value.llm ?? {}) },
    yinyi: { ...defaultSettings.yinyi, ...(value.yinyi ?? {}) },
    dream: { ...defaultSettings.dream, ...(value.dream ?? {}) },
    carePings: {
      ...defaultSettings.carePings,
      ...(value.carePings ?? {}),
      quietHours: {
        ...defaultSettings.carePings.quietHours,
        ...(value.carePings?.quietHours ?? {}),
      },
    },
    chat: { ...defaultSettings.chat, ...(value.chat ?? {}) },
    playback: { ...defaultSettings.playback, ...(value.playback ?? {}) },
    ui: { ...defaultSettings.ui, ...(value.ui ?? {}) },
    window: { ...defaultSettings.window, ...(value.window ?? {}) },
    user: { ...defaultSettings.user, ...(value.user ?? {}) },
    tts: { ...defaultSettings.tts, ...(value.tts ?? {}) },
    meta: { ...defaultSettings.meta, ...(value.meta ?? {}), firstUsedAt },
  }
}

export function getSettings(): Settings {
  const row = getDb().prepare('SELECT data_json FROM settings WHERE id = 1').get() as { data_json: string } | undefined
  let parsed: Record<string, unknown> = {}
  try {
    parsed = row ? JSON.parse(row.data_json || '{}') : {}
  } catch {
    console.warn('[settings] data_json corrupt, falling back to defaults')
  }
  const merged = mergeDefaults(parsed)
  merged.llm.apiKey = decryptSecret(merged.llm.apiKey)
  return merged
}

export function getStoredSettingsRaw(): Settings {
  const row = getDb().prepare('SELECT data_json FROM settings WHERE id = 1').get() as { data_json: string } | undefined
  let parsed: Record<string, unknown> = {}
  try {
    parsed = row ? JSON.parse(row.data_json || '{}') : {}
  } catch {
    console.warn('[settings] data_json corrupt, falling back to defaults')
  }
  return mergeDefaults(parsed)
}

export function saveSettings(settings: Settings, preserveEncryptedKey = false): Settings {
  const copy = structuredClone(settings)
  if (copy.llm.apiKey) {
    if (!isSecureStorageAvailable()) {
      throw new StorageUnavailableError('当前系统未启用加密存储，无法保存 API Key。请检查系统的密钥环服务后重试。')
    }
    copy.llm.apiKey = encryptSecret(copy.llm.apiKey)
  } else if (preserveEncryptedKey) {
    const existingRow = getDb().prepare('SELECT data_json FROM settings WHERE id = 1').get() as { data_json: string } | undefined
    const existing = parseJson<Record<string, unknown>>(existingRow?.data_json, {}, 'settings.data_json')
    const llm = existing.llm && typeof existing.llm === 'object' ? existing.llm as Record<string, unknown> : {}
    const existingKey = typeof llm.apiKey === 'string' ? llm.apiKey : ''
    if (existingKey.startsWith('safe:')) {
      console.warn('[settings] saveSettings: apiKey 为空但数据库存在加密值，保留加密值防止丢失')
      copy.llm.apiKey = existingKey
    } else {
      copy.llm.apiKey = ''
    }
  } else {
    copy.llm.apiKey = ''
  }
  getDb()
    .prepare('UPDATE settings SET data_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1')
    .run(JSON.stringify(copy))
  return getSettings()
}

/**
 * 启动时调用一次：把仍为 plain: 前缀的旧 apiKey 升级为 safe:。
 * 如果系统支持加密但仍存在 plain: 数据，立刻重写一次以消除明文残留。
 */
export function upgradeLegacySettingsSecrets(): void {
  const row = getDb().prepare('SELECT data_json FROM settings WHERE id = 1').get() as { data_json: string } | undefined
  if (!row) return
  const parsed = parseJson<Record<string, unknown>>(row.data_json, {}, 'settings.data_json')
  const llm = parsed.llm && typeof parsed.llm === 'object' ? parsed.llm as Record<string, unknown> : {}
  const stored = llm.apiKey
  if (typeof stored !== 'string' || !isLegacyPlain(stored)) return
  const upgraded = tryUpgradeLegacyPlain(stored)
  parsed.llm = {
    ...llm,
    apiKey: upgraded ?? '',
  }
  getDb()
    .prepare('UPDATE settings SET data_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1')
    .run(JSON.stringify(parsed))
  if (!upgraded) {
    upsertHealth('storage', 'error', '旧版 API Key 未能迁移到加密存储，已清空。请在设置页重新填写。')
  }
}

function setNestedValue(obj: Record<string, unknown>, dotPath: string, value: unknown): void {
  const keys = dotPath.split('.')
  let target = obj
  for (const key of keys.slice(0, -1)) {
    const existing = target[key]
    if (!existing || typeof existing !== 'object') target[key] = {}
    target = target[key] as Record<string, unknown>
  }
  target[keys[keys.length - 1]] = value
}

export function updateSetting(path: string, value: unknown): Settings {
  assertSettingPath(path)
  return updateSettingsBatch([{ path, value } as SettingUpdatePatch])
}

export function updateSettingsBatch(updates: readonly SettingUpdatePatch[]): Settings {
  const normalized = updates.flatMap((item) => {
    assertSettingPath(item.path)
    if (item.path === 'llm.apiKey' && item.value === '••••••') return []
    return [{ path: item.path, value: validateSettingValue(item.path, item.value) }]
  })
  if (normalized.length === 0) return getSettings()

  const touchesApiKey = normalized.some((item) => item.path === 'llm.apiKey')
  const write = getDb().transaction(() => {
    if (touchesApiKey) {
      const settings = getSettings()
      for (const item of normalized) {
        setNestedValue(settings as unknown as Record<string, unknown>, item.path, item.value)
      }
      return saveSettings(settings)
    }

    const raw = getStoredSettingsRaw()
    for (const item of normalized) {
      setNestedValue(raw as unknown as Record<string, unknown>, item.path, item.value)
    }
    updateSettingsSilent(raw)
    return getSettings()
  })
  return write()
}

export function updateSettingsSilent(settings: Settings): void {
  getDb()
    .prepare('UPDATE settings SET data_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1')
    .run(JSON.stringify(settings))
}

export const settingsTestHelpers = { mergeDefaults, validateSettingValue }
