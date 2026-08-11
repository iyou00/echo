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

type NeteaseLoginRequestOptions = {
  timestamp: number
  ua: string
  platform?: string
  noCookie?: boolean
}

function neteaseMessage(body: Record<string, unknown> | undefined, fallback: string): string {
  const message = typeof body?.message === 'string'
    ? body.message
    : typeof body?.msg === 'string'
      ? body.msg
      : fallback
  return publicNeteaseMessage(message, fallback)
}

function publicNeteaseMessage(raw: string, fallback: string): string {
  const message = raw.replace(/^Error invoking remote method '[^']+':\s*(?:Error:\s*)?/i, '').trim()
  if (!message) return fallback
  if (/安全存储|加密存储|密钥环|safeStorage/i.test(message)) return '系统加密存储暂时不可用，请检查系统凭据服务。'
  if (/timeout|timed out|超时/i.test(message)) return '网易云连接超时，稍后再试。'
  if (/network|fetch failed|econn|enotfound|socket|断网|网络|Request failed/i.test(message)) return '网易云连接失败，请检查网络后再试。'
  if (/captcha/i.test(message) && !/验证码/.test(message)) return '验证码不正确或已过期。'
  if (/(cellphone|phone)/i.test(message) && !/手机号/.test(message)) return '手机号格式不对。'
  if (/手机号|验证码|captcha|频繁|过期|失效|环境异常|风险|实名|账号|密码|cookie|MUSIC_U/i.test(message)) return message
  return fallback
}

function neteaseErrorMessage(error: unknown, fallback: string): string {
  const message = error instanceof Error ? error.message : String(error ?? '')
  return publicNeteaseMessage(message, fallback)
}

function loginRequestOptions(extra: Partial<NeteaseLoginRequestOptions> = {}): NeteaseLoginRequestOptions {
  return {
    timestamp: Date.now(),
    ua: 'pc',
    ...extra,
  }
}

export function readNeteaseCookie(): string {
  const row = getDb().prepare('SELECT cookie_encrypted FROM netease_auth WHERE id = 1').get() as { cookie_encrypted?: string } | undefined
  return decryptSecret(row?.cookie_encrypted ?? '')
}

function readStoredProfile(): Record<string, unknown> {
  const row = getDb().prepare('SELECT profile_json FROM netease_auth WHERE id = 1').get() as { profile_json?: string } | undefined
  if (!row?.profile_json) return {}
  try {
    const parsed = JSON.parse(row.profile_json) as unknown
    return parsed && typeof parsed === 'object' ? parsed as Record<string, unknown> : {}
  } catch {
    return {}
  }
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
    upsertHealth('storage', 'error', '旧版网易云登录凭证未能迁移到加密存储，已清空。请重新登录网易云。')
    upsertHealth('netease', 'degraded', '网易云登录可能过期了。重新登录后我再拿播放链接。')
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

function normalizeManualCookie(input: string): string {
  const text = input.trim()
  if (!text) return ''
  if (/MUSIC_U\s*=/.test(text)) return text
  if (/^[A-Za-z0-9._%+/=-]{20,}$/.test(text)) return `MUSIC_U=${text}`
  return text
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
  const storedProfile = readStoredProfile()
  if (!cookie) {
    upsertHealth('netease', 'degraded', '网易云登录可能过期了。重新登录后我再拿播放链接。')
    return { loggedIn: false, message: '未登录' }
  }

  try {
    const result = (await netease.login_status({ cookie, ...loginRequestOptions() } as Parameters<typeof netease.login_status>[0])) as ApiResponse
    const profile = profileFromBody(result.body)
    if (Object.keys(profile).length > 0) {
      saveAuth(cookie, profile)
      const state = normalizeLoginState(profile)
      upsertHealth('netease', 'ok', `网易云已登录：${state.nickname ?? '网易云用户'}`)
      return state
    }
    if (Object.keys(storedProfile).length > 0) {
      const state = normalizeLoginState(storedProfile)
      upsertHealth('netease', 'ok', `网易云已登录：${state.nickname ?? '网易云用户'}`)
      return state
    }
    clearAuth()
    upsertHealth('netease', 'degraded', '网易云登录可能过期了。重新登录后我再拿播放链接。')
    return { loggedIn: false, message: '登录已失效，请重新登录' }
  } catch (error) {
    if (Object.keys(storedProfile).length > 0) {
      const state = normalizeLoginState(storedProfile)
      upsertHealth('netease', 'degraded', '网易云状态检查暂时失败，已保留本地登录状态。', error instanceof Error ? error.message : '')
      return state
    }
    upsertHealth('netease', 'error', '网易云状态检查失败。', error instanceof Error ? error.message : '')
    return { loggedIn: false, message: '网易云状态检查失败' }
  }
}

export async function createNeteaseQrLogin(): Promise<NeteaseQrLogin> {
  const keyResult = (await netease.login_qr_key(loginRequestOptions() as Parameters<typeof netease.login_qr_key>[0])) as ApiResponse
  const keyData = keyResult.body?.data as Record<string, unknown> | undefined
  const key = String(keyData?.unikey ?? '')
  if (!key) throw new Error('网易云二维码 key 获取失败')

  const qrResult = (await netease.login_qr_create({
    key,
    qrimg: true,
    ...loginRequestOptions({ platform: 'web' }),
  } as Parameters<typeof netease.login_qr_create>[0] & NeteaseLoginRequestOptions)) as ApiResponse
  const qrData = qrResult.body?.data as Record<string, unknown> | undefined
  const qrUrl = String(qrData?.qrurl ?? '')
  const qrImage = String(qrData?.qrimg ?? '')
  if (!qrUrl || !qrImage) throw new Error('网易云二维码生成失败')

  return { key, qrUrl, qrImage, message: '请用网易云音乐 App 扫码' }
}

export async function checkNeteaseQrLogin(key: string): Promise<NeteaseQrCheckResult> {
  if (!key) return { code: 0, status: 'failed', message: '二维码 key 为空' }

  const result = (await netease.login_qr_check({
    key,
    ...loginRequestOptions({ noCookie: true }),
  } as Parameters<typeof netease.login_qr_check>[0] & NeteaseLoginRequestOptions)) as ApiResponse
  const body = result.body ?? {}
  const code = Number(body.code ?? 0)
  if (code === 803) {
    const cookie = typeof body.cookie === 'string' ? body.cookie : (result.cookie ?? []).join(';')
    if (!cookie) return { code, status: 'failed', message: '网易云未返回登录凭证' }
    saveAuth(cookie)
    const state = await getNeteaseLoginState()
    upsertHealth('netease', state.loggedIn ? 'ok' : 'degraded', state.loggedIn ? `网易云已登录：${state.nickname ?? '网易云用户'}` : '网易云登录可能过期了。重新登录后我再拿播放链接。')
    return { code, status: 'authorized', message: state.loggedIn ? '登录成功' : state.message, state }
  }
  if (code === 802) return { code, status: 'scanned', message: '已扫码，请在手机上确认' }
  if (code === 801) return { code, status: 'waiting', message: '等待扫码' }
  if (code === 800) return { code, status: 'expired', message: '二维码已过期' }
  return { code, status: 'failed', message: typeof body.message === 'string' ? body.message : '登录检查失败' }
}

export async function sendNeteaseCaptcha(phone: string): Promise<{ ok: boolean; message: string }> {
  const cleanPhone = phone.trim()
  if (!/^1\d{10}$/.test(cleanPhone)) return { ok: false, message: '手机号格式不对。' }
  try {
    const result = (await netease.captcha_sent({
      phone: cleanPhone,
      ctcode: '86',
      ...loginRequestOptions(),
    } as Parameters<typeof netease.captcha_sent>[0] & NeteaseLoginRequestOptions)) as ApiResponse
    const body = result.body ?? {}
    const code = Number(body.code ?? 0)
    const message = neteaseMessage(body, code === 200 ? '验证码已发送。' : '验证码发送失败。')
    return { ok: code === 200, message }
  } catch (error) {
    return { ok: false, message: neteaseErrorMessage(error, '验证码发送失败。') }
  }
}

export async function loginNeteaseWithCaptcha(phone: string, captcha: string): Promise<NeteaseLoginState> {
  const cleanPhone = phone.trim()
  const cleanCaptcha = captcha.trim()
  if (!/^1\d{10}$/.test(cleanPhone)) return { loggedIn: false, message: '手机号格式不对。' }
  if (!/^\d{4,8}$/.test(cleanCaptcha)) return { loggedIn: false, message: '验证码格式不对。' }

  try {
    const result = (await netease.login_cellphone({
      phone: cleanPhone,
      captcha: cleanCaptcha,
      countrycode: '86',
      ...loginRequestOptions(),
    } as Parameters<typeof netease.login_cellphone>[0] & NeteaseLoginRequestOptions)) as ApiResponse
    const body = result.body ?? {}
    const code = Number(body.code ?? 0)
    const cookie = typeof body.cookie === 'string' ? body.cookie : (result.cookie ?? []).join(';')
    if (code !== 200 || !cookie) {
      const message = neteaseMessage(body, '网易云验证码登录失败。')
      upsertHealth('netease', 'degraded', message)
      return { loggedIn: false, message }
    }

    const profile = profileFromBody(body)
    saveAuth(cookie, profile)
    const state = Object.keys(profile).length > 0
      ? normalizeLoginState(profile, '登录成功')
      : { loggedIn: true, nickname: '网易云用户', message: '登录成功' }
    upsertHealth('netease', 'ok', `网易云已登录：${state.nickname ?? '网易云用户'}`)
    return state
  } catch (error) {
    const message = neteaseErrorMessage(error, '网易云验证码登录失败。')
    upsertHealth('netease', 'degraded', message)
    return { loggedIn: false, message }
  }
}

export async function importNeteaseCookie(cookie: string): Promise<NeteaseLoginState> {
  const normalized = normalizeManualCookie(cookie)
  if (!normalized) return { loggedIn: false, message: 'Cookie 不能为空。' }
  if (!/MUSIC_U\s*=/.test(normalized)) return { loggedIn: false, message: 'Cookie 里需要包含 MUSIC_U。' }
  saveAuth(normalized)
  const state = await getNeteaseLoginState()
  if (!state.loggedIn) clearAuth()
  return state
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
  upsertHealth('netease', 'degraded', '网易云登录可能过期了。重新登录后我再拿播放链接。')
  return { loggedIn: false, message: '已退出网易云' }
}
