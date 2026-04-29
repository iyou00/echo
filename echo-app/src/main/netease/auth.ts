import { createRequire } from 'node:module'
import type { NeteaseLoginState, NeteaseQrCheckResult, NeteaseQrLogin } from '../../types/ipc'
import { getDb } from '../db'
import { upsertHealth } from '../db/health'
import {
  decryptSecret,
  encryptSecret,
  isLegacyPlain,
  isSecureStorageAvailable,
  StorageUnavailableError,
  tryUpgradeLegacyPlain,
} from '../utils/secureStorage'

const require = createRequire(import.meta.url)
const netease = require('@neteasecloudmusicapienhanced/api') as typeof import('@neteasecloudmusicapienhanced/api')

type ApiResponse = {
  body?: Record<string, unknown>
  cookie?: string[]
}

export function readNeteaseCookie(): string {
  const row = getDb().prepare('SELECT cookie_encrypted FROM netease_auth WHERE id = 1').get() as { cookie_encrypted?: string } | undefined
  return decryptSecret(row?.cookie_encrypted ?? '')
}

/**
 * 启动时调用一次：把 plain: 前缀的旧 cookie 升级为 safe:。
 */
export function upgradeLegacyNeteaseSecret(): void {
  const row = getDb().prepare('SELECT cookie_encrypted FROM netease_auth WHERE id = 1').get() as { cookie_encrypted?: string } | undefined
  const stored = row?.cookie_encrypted ?? ''
  if (!isLegacyPlain(stored)) return
  const upgraded = tryUpgradeLegacyPlain(stored)
  getDb()
    .prepare('UPDATE netease_auth SET cookie_encrypted = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1')
    .run(upgraded ?? '')
  if (!upgraded) {
    upsertHealth('storage', 'error', '旧版网易云登录凭证未能迁移到加密存储，已清空。请重新扫码登录。')
    upsertHealth('netease', 'degraded', '网易云登录可能过期了。重新扫码后我再拿播放链接。')
  }
}

function saveAuth(cookie: string, profile: Record<string, unknown> = {}): void {
  if (cookie && !isSecureStorageAvailable()) {
    throw new StorageUnavailableError('当前系统未启用加密存储，无法安全保存网易云登录凭证。')
  }
  const encryptedCookie = cookie ? encryptSecret(cookie) : ''
  getDb()
    .prepare('UPDATE netease_auth SET cookie_encrypted = ?, profile_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1')
    .run(encryptedCookie, JSON.stringify(profile))
}

function clearAuth(): void {
  getDb()
    .prepare("UPDATE netease_auth SET cookie_encrypted = '', profile_json = '{}', updated_at = CURRENT_TIMESTAMP WHERE id = 1")
    .run()
}

function profileFromBody(body: Record<string, unknown> | undefined): Record<string, unknown> {
  const data = body?.data as Record<string, unknown> | undefined
  const profile = (data?.profile ?? body?.profile) as Record<string, unknown> | undefined
  const account = (data?.account ?? body?.account) as Record<string, unknown> | undefined
  return profile ?? account ?? {}
}

function normalizeLoginState(profile: Record<string, unknown>, message = '已登录'): NeteaseLoginState {
  const userId = Number(profile.userId ?? profile.id ?? 0)
  return {
    loggedIn: true,
    nickname: typeof profile.nickname === 'string' ? profile.nickname : '网易云用户',
    userId: Number.isFinite(userId) && userId > 0 ? userId : undefined,
    avatarUrl: typeof profile.avatarUrl === 'string' ? profile.avatarUrl : undefined,
    message,
  }
}

export async function getNeteaseLoginState(): Promise<NeteaseLoginState> {
  const cookie = readNeteaseCookie()
  if (!cookie) {
    upsertHealth('netease', 'degraded', '网易云登录可能过期了。重新扫码后我再拿播放链接。')
    return { loggedIn: false, message: '未登录' }
  }

  try {
    const result = (await netease.login_status({ cookie })) as ApiResponse
    const profile = profileFromBody(result.body)
    if (Object.keys(profile).length > 0) {
      saveAuth(cookie, profile)
      const state = normalizeLoginState(profile)
      upsertHealth('netease', 'ok', `网易云已登录：${state.nickname ?? '网易云用户'}`)
      return state
    }
    clearAuth()
    upsertHealth('netease', 'degraded', '网易云登录可能过期了。重新扫码后我再拿播放链接。')
    return { loggedIn: false, message: '登录已失效，请重新扫码' }
  } catch (error) {
    upsertHealth('netease', 'error', '网易云状态检查失败。', error instanceof Error ? error.message : '')
    return { loggedIn: false, message: '网易云状态检查失败' }
  }
}

export async function createNeteaseQrLogin(): Promise<NeteaseQrLogin> {
  const keyResult = (await netease.login_qr_key({})) as ApiResponse
  const keyData = keyResult.body?.data as Record<string, unknown> | undefined
  const key = String(keyData?.unikey ?? '')
  if (!key) throw new Error('网易云二维码 key 获取失败')

  const qrResult = (await netease.login_qr_create({ key, qrimg: true })) as ApiResponse
  const qrData = qrResult.body?.data as Record<string, unknown> | undefined
  const qrUrl = String(qrData?.qrurl ?? '')
  const qrImage = String(qrData?.qrimg ?? '')
  if (!qrUrl || !qrImage) throw new Error('网易云二维码生成失败')

  return { key, qrUrl, qrImage, message: '请用网易云音乐 App 扫码' }
}

export async function checkNeteaseQrLogin(key: string): Promise<NeteaseQrCheckResult> {
  if (!key) return { code: 0, status: 'failed', message: '二维码 key 为空' }

  const result = (await netease.login_qr_check({ key })) as ApiResponse
  const body = result.body ?? {}
  const code = Number(body.code ?? 0)
  if (code === 803) {
    const cookie = typeof body.cookie === 'string' ? body.cookie : (result.cookie ?? []).join(';')
    if (!cookie) return { code, status: 'failed', message: '网易云未返回登录凭证' }
    saveAuth(cookie)
    const state = await getNeteaseLoginState()
    upsertHealth('netease', state.loggedIn ? 'ok' : 'degraded', state.loggedIn ? `网易云已登录：${state.nickname ?? '网易云用户'}` : '网易云登录可能过期了。重新扫码后我再拿播放链接。')
    return { code, status: 'authorized', message: state.loggedIn ? '登录成功' : state.message, state }
  }
  if (code === 802) return { code, status: 'scanned', message: '已扫码，请在手机上确认' }
  if (code === 801) return { code, status: 'waiting', message: '等待扫码' }
  if (code === 800) return { code, status: 'expired', message: '二维码已过期' }
  return { code, status: 'failed', message: typeof body.message === 'string' ? body.message : '登录检查失败' }
}

export async function logoutNetease(): Promise<NeteaseLoginState> {
  const cookie = readNeteaseCookie()
  if (cookie) {
    try {
      await netease.logout({ cookie })
    } catch {
      // 本地退出优先，远端失败时也清掉本地凭证。
    }
  }
  clearAuth()
  upsertHealth('netease', 'degraded', '网易云登录可能过期了。重新扫码后我再拿播放链接。')
  return { loggedIn: false, message: '已退出网易云' }
}
