import { safeStorage } from 'electron'
import { upsertHealth } from '../db/health'

/**
 * 集中处理本地敏感数据的加密。
 * 当系统支持时使用 Electron safeStorage（Windows DPAPI / macOS Keychain / Linux libsecret）。
 * 不支持时拒绝写入并标记 storage health degraded，避免静默把 apiKey/cookie 明文落盘。
 *
 * 兼容历史数据：旧版本曾把不可用降级到 `plain:base64`。
 * 日常读取不再解码 legacy plain；只有启动迁移函数可以短暂读取并重写。
 */

export class StorageUnavailableError extends Error {
  constructor(message = '当前系统不支持安全加密存储') {
    super(message)
    this.name = 'StorageUnavailableError'
  }
}

let lastAvailable: boolean | null = null

export function isSecureStorageAvailable(): boolean {
  try {
    const available = safeStorage.isEncryptionAvailable()
    if (available !== lastAvailable) {
      lastAvailable = available
      if (available) {
        upsertHealth('storage', 'ok', '本地加密存储可用，API Key 与登录态会加密落盘。')
      } else {
        upsertHealth(
          'storage',
          'error',
          '系统未启用加密存储，API Key 暂时无法保存。Linux 用户请确认 GNOME Keyring / KWallet 已启动。',
        )
      }
    }
    return available
  } catch (error) {
    upsertHealth('storage', 'error', '加密存储检查失败。', error instanceof Error ? error.message : '')
    lastAvailable = false
    return false
  }
}

export function checkSecureStorage(): boolean {
  return isSecureStorageAvailable()
}

export function encryptSecret(value: string): string {
  if (!value) return ''
  if (!isSecureStorageAvailable()) {
    throw new StorageUnavailableError()
  }
  return `safe:${safeStorage.encryptString(value).toString('base64')}`
}

export function decryptSecret(value: string): string {
  if (!value) return ''
  if (value.startsWith('safe:')) {
    if (!isSecureStorageAvailable()) {
      console.warn('[secureStorage] decrypt failed: safeStorage unavailable')
      upsertHealth('storage', 'error', 'API Key 解密失败，请在设置页重新填写。', 'safeStorage unavailable')
      return ''
    }
    try {
      const result = safeStorage.decryptString(Buffer.from(value.slice(5), 'base64'))
      if (lastAvailable !== true) {
        lastAvailable = true
        upsertHealth('storage', 'ok', '本地加密存储可用，API Key 与登录态会加密落盘。')
      }
      return result
    } catch (err) {
      console.warn('[secureStorage] decrypt failed:', err instanceof Error ? err.message : err)
      upsertHealth('storage', 'error', 'API Key 解密失败，请在设置页重新填写。', err instanceof Error ? err.message : String(err))
      return ''
    }
  }
  if (value.startsWith('plain:')) return ''
  return ''
}

export function isLegacyPlain(value: string): boolean {
  return Boolean(value) && value.startsWith('plain:')
}

export function decodeLegacyPlain(value: string): string {
  if (!isLegacyPlain(value)) return ''
  try {
    return Buffer.from(value.slice(6), 'base64').toString('utf8')
  } catch {
    return ''
  }
}

export function tryUpgradeLegacyPlain(value: string): string | null {
  if (!isLegacyPlain(value)) return null
  if (!isSecureStorageAvailable()) return null
  try {
    const plain = decodeLegacyPlain(value)
    if (!plain) return null
    return `safe:${safeStorage.encryptString(plain).toString('base64')}`
  } catch {
    return null
  }
}
