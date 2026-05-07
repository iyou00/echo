import type { Settings } from '../../types/ipc'
import { getDb } from './index'
import {
  decryptSecret,
  encryptSecret,
  isLegacyPlain,
  isSecureStorageAvailable,
  StorageUnavailableError,
  tryUpgradeLegacyPlain,
} from '../utils/secureStorage'
import { upsertHealth } from './health'

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
  carePings: {
    enabled: false,
    frequency: 'normal',
    detectFullscreen: true,
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
    onboardingStep: 'playlist',
    lastPrunedAt: '',
  },
}

function mergeDefaults(value: Partial<Settings>): Settings {
  return {
    ...defaultSettings,
    ...value,
    llm: { ...defaultSettings.llm, ...(value.llm ?? {}) },
    yinyi: { ...defaultSettings.yinyi, ...(value.yinyi ?? {}) },
    carePings: { ...defaultSettings.carePings, ...(value.carePings ?? {}) },
    chat: { ...defaultSettings.chat, ...(value.chat ?? {}) },
    playback: { ...defaultSettings.playback, ...(value.playback ?? {}) },
    ui: { ...defaultSettings.ui, ...(value.ui ?? {}) },
    window: { ...defaultSettings.window, ...(value.window ?? {}) },
    user: { ...defaultSettings.user, ...(value.user ?? {}) },
    tts: { ...defaultSettings.tts, ...(value.tts ?? {}) },
    meta: { ...defaultSettings.meta, ...(value.meta ?? {}) },
  }
}

export function getSettings(): Settings {
  const row = getDb().prepare('SELECT data_json FROM settings WHERE id = 1').get() as { data_json: string } | undefined
  const parsed = row ? JSON.parse(row.data_json || '{}') : {}
  const merged = mergeDefaults(parsed)
  merged.llm.apiKey = decryptSecret(merged.llm.apiKey)
  return merged
}

export function getStoredSettingsRaw(): Settings {
  const row = getDb().prepare('SELECT data_json FROM settings WHERE id = 1').get() as { data_json: string } | undefined
  return mergeDefaults(row ? JSON.parse(row.data_json || '{}') : {})
}

export function saveSettings(settings: Settings): Settings {
  const copy = structuredClone(settings)
  if (copy.llm.apiKey) {
    if (!isSecureStorageAvailable()) {
      throw new StorageUnavailableError('当前系统未启用加密存储，无法保存 API Key。请检查系统的密钥环服务后重试。')
    }
    copy.llm.apiKey = encryptSecret(copy.llm.apiKey)
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
  const parsed = row.data_json ? JSON.parse(row.data_json) : {}
  const stored = parsed?.llm?.apiKey
  if (typeof stored !== 'string' || !isLegacyPlain(stored)) return
  const upgraded = tryUpgradeLegacyPlain(stored)
  parsed.llm = {
    ...parsed.llm,
    apiKey: upgraded ?? '',
  }
  getDb()
    .prepare('UPDATE settings SET data_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1')
    .run(JSON.stringify(parsed))
  if (!upgraded) {
    upsertHealth('storage', 'error', '旧版 API Key 未能迁移到加密存储，已清空。请在设置页重新填写。')
  }
}

export function updateSetting(path: string, value: unknown): Settings {
  const settings = getSettings()
  const keys = path.split('.')
  let target: Record<string, unknown> = settings as unknown as Record<string, unknown>
  for (const key of keys.slice(0, -1)) {
    const existing = target[key]
    if (!existing || typeof existing !== 'object') target[key] = {}
    target = target[key] as Record<string, unknown>
  }
  target[keys[keys.length - 1]] = value
  return saveSettings(settings)
}

export function updateSettingsSilent(settings: Settings): void {
  getDb()
    .prepare('UPDATE settings SET data_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1')
    .run(JSON.stringify(settings))
}
