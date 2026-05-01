import { app, BrowserWindow, Notification, nativeImage } from 'electron'
import path from 'node:path'
import type { PingType, Track } from '../../types/ipc'
import { getSettings } from '../db/settings'
import {
  getRecentCarePingBodies,
  getRecentCarePingTracks,
  insertCarePing,
  isCarePingsMutedToday,
  markCarePingClicked,
  muteCarePingsToday,
  type CarePingRecord,
} from '../db/carePings'
import { loadRecentConversations, appendConversation } from '../db/conversations'
import { appendRecommendedTracks } from '../db/tracks'
import { completeChat } from '../llm/client'
import { readRootFile } from '../utils/paths'
import { getWeather } from '../weather/client'
import { getMostRecentSeal } from './daySeal'
import { play } from './playback'
import { recommendFromNetease } from './recommendation'

export interface TimeSlot {
  key?: string
  label?: string
  hour: number
  minute: number
}

export interface CarePingRunResult {
  triggered: boolean
  status: 'completed' | 'failed' | 'skipped'
  message: string
  error?: string
}

const activeNotifications = new Set<Notification>()

function trackKey(track?: Track | null): string {
  if (!track) return ''
  if (track.neteaseId) return `netease:${track.neteaseId}`
  if (track.id) return `id:${track.id}`
  return `name:${track.title.trim().toLowerCase()}::${track.artist.trim().toLowerCase()}`
}

function appIcon() {
  const iconPath = path.join(process.env.VITE_PUBLIC ?? '', 'brand', 'icon.ico')
  const icon = nativeImage.createFromPath(iconPath)
  if (!icon.isEmpty()) return icon
  return nativeImage.createFromDataURL(
    'data:image/svg+xml;utf8,' +
      encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" rx="58" fill="#639922"/><text x="128" y="161" text-anchor="middle" font-family="Georgia,serif" font-size="128" fill="#F5FAED">E</text></svg>'),
  )
}

function pickPingType(): PingType {
  const value = Math.random()
  if (value < 0.4) return 'recommend_track'
  if (value < 0.7) return 'casual_check'
  return 'voice_invite'
}

function cleanBody(value: string, max = 80): string {
  const normalized = value
    .replace(/```[\s\S]*?```/g, '')
    .split(/\r?\n/)
    .map((line) => line.trim().replace(/^>\s*/, ''))
    .filter(Boolean)
    .join('')
    .replace(/^["“”'‘’]+|["“”'‘’]+$/g, '')
    .replace(/[!！]+/g, '')
    .replace(/\s+/g, ' ')
    .trim()
  return normalized.length <= max ? normalized : normalized.slice(0, max).trim()
}

const UNSAFE_BODY_PATTERNS = [
  /可直接发/,
  /通知文案/,
  /通知模板/,
  /核心信息/,
  /对象、事项/,
  /金额/,
  /处理要求/,
  /致[:：]/,
  /员工姓名/,
  /相关方/,
  /当然可以/,
  /通用/,
  /请把/,
  /我会整理/,
  /最终可用/,
  /以下是/,
  /合并补偿/,
  /可发送版本/,
  /通知对象/,
  /通知内容/,
  /最简模板/,
  /通知格式/,
  /核心信息/,
  /关键信息/,
  /#+\s*/,
  /---/,
  /\[[^\]]+\]/,
]

function isUnsafeBody(body: string): boolean {
  const normalized = body.trim()
  if (!normalized) return true
  if (normalized.length > 110) return true
  return UNSAFE_BODY_PATTERNS.some((pattern) => pattern.test(normalized))
}

function fallbackPingBody(type: PingType, track?: Track): string {
  const hour = new Date().getHours()
  if (type === 'recommend_track' && track) {
    return `这会儿我想起${track.artist}的《${track.title}》。点开吧，我放给你听。`
  }
  if (type === 'voice_invite') {
    return '我在回声里留了几句话。你空下来点开，我慢慢说给你听。'
  }
  if (hour < 11) return '早上这会儿先慢慢来。事情可以一件件做，我在这儿陪你。'
  if (hour < 16) return '这个点容易散神。先歇一小会儿，让自己缓过来。'
  if (hour < 20) return '一天快收尾了。先把肩膀放下来，剩下的慢慢处理。'
  return '晚上安静下来了。今天到这里也可以，别把自己绷太久。'
}

async function buildPromptContext(track?: Track) {
  const settings = getSettings()
  const weather = await getWeather(settings.user.city).catch(() => null)
  const conversations = loadRecentConversations(5)
  const recentConversations = conversations.length > 0
    ? conversations.map((item) => `${item.role}: ${item.content.slice(0, 120)}`).join('\n')
    : '(暂无)'
  const currentTime = new Date().toLocaleString('zh-CN', {
    hour12: false,
    weekday: 'long',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
  })
  return {
    currentTime,
    weather: weather?.summary ?? '未知',
    recentConversations,
    yesterdaySeal: getMostRecentSeal().slice(0, 700) || '(暂无)',
    recentNotifications: getRecentCarePingBodies(7).filter((body) => !isUnsafeBody(body)).join('\n') || '(暂无)',
    trackLine: track ? `${track.artist}的《${track.title}》` : '',
  }
}

function fillPrompt(template: string, context: Awaited<ReturnType<typeof buildPromptContext>>): string {
  return template
    .replace(/\{time\}/g, context.currentTime)
    .replace(/\{weather\}/g, context.weather)
    .replace(/\{artist\}/g, context.trackLine.split('的《')[0] ?? '')
    .replace(/\{track_title\}/g, context.trackLine.match(/《(.+)》/)?.[1] ?? '')
    .replace(/\{recent_signals\}/g, context.recentConversations)
    .replace(/\{recent_conversations\}/g, context.recentConversations)
    .replace(/\{yesterday_seal_summary\}/g, context.yesterdaySeal)
    .replace(/\{recent_notifications\}/g, context.recentNotifications)
}

async function writePingBody(type: PingType, track?: Track): Promise<string> {
  const settings = getSettings()
  const promptFile = type === 'recommend_track'
    ? 'prompts/care-ping-recommend.md'
    : type === 'voice_invite'
      ? 'prompts/care-ping-voice-invite.md'
      : 'prompts/care-ping-casual.md'
  const context = await buildPromptContext(track)
  const user = fillPrompt(readRootFile(promptFile), context)
  const fallback = fallbackPingBody(type, track)
  try {
    const body = cleanBody(await completeChat(settings, [
      {
        role: 'system',
        content: [
          '你是 Echo，只写 Windows 系统通知正文。',
          '这段文字会直接弹到用户桌面上。',
          '只输出通知正文这一句话或两句短句。',
          '严禁写成模板、公告、客服回复、写作建议。',
          '严禁出现“通知”“模板”“请把信息发给我”“可直接发”等办公写作口吻。',
        ].join('\n'),
      },
      { role: 'user', content: `${user}\n\n最近 7 条已经发过的通知，避免重复:\n${context.recentNotifications}\n\n现在输出最终通知正文。` },
    ], { temperature: 0.86 }), type === 'recommend_track' ? 96 : 72)
    if (!body || isUnsafeBody(body)) return fallback
    if (track && (!body.includes(track.title) || !body.includes(track.artist))) {
      const withTrack = `${body} ${track.artist}的《${track.title}》。`
      return isUnsafeBody(withTrack) ? fallback : withTrack
    }
    return body
  } catch {
    return fallback
  }
}

async function pickCareTrack(): Promise<Track | null> {
  const candidates = await recommendFromNetease('这个时候,给我一首适合主动推荐的歌').catch(() => [])
  const recentKeys = new Set(getRecentCarePingTracks(20).map(trackKey).filter(Boolean))
  return candidates.find((track) => !recentKeys.has(trackKey(track))) ?? candidates[0] ?? null
}

function showMainWindow(payload: { page: 'chat' | 'voice'; action?: 'start_listening'; carePingId: number; canMuteToday: boolean }): void {
  const target = BrowserWindow.getAllWindows()[0]
  if (!target) return
  if (target.isMinimized()) target.restore()
  target.show()
  target.moveTop()
  target.focus()
  if (process.platform === 'win32') {
    target.setAlwaysOnTop(true)
    target.setAlwaysOnTop(false)
  } 
  app.focus({ steal: true })
  target.webContents.send('app:navigate', payload)
}

async function handleNotificationClick(record: CarePingRecord): Promise<void> {
  markCarePingClicked(record.id)
  if (record.type === 'recommend_track' && record.payload.track) {
    appendRecommendedTracks([record.payload.track])
    const message = appendConversation('assistant', '来了。', [record.payload.track])
    BrowserWindow.getAllWindows()[0]?.webContents.send('chat:message-injected', message)
    await play(record.payload.track)
    showMainWindow({ page: 'chat', carePingId: record.id, canMuteToday: true })
    return
  }
  if (record.type === 'voice_invite') {
    showMainWindow({ page: 'voice', action: 'start_listening', carePingId: record.id, canMuteToday: true })
    return
  }
  const message = appendConversation('assistant', record.body)
  BrowserWindow.getAllWindows()[0]?.webContents.send('chat:message-injected', message)
  showMainWindow({ page: 'chat', carePingId: record.id, canMuteToday: true })
}

function sendNotification(record: CarePingRecord): void {
  if (!Notification.isSupported()) throw new Error('当前系统不支持 Electron 通知')
  const notification = new Notification({
    title: record.title,
    body: record.body,
    icon: appIcon(),
    silent: false,
    actions: process.platform === 'darwin' ? [{ type: 'button', text: '今天别再提醒' }] : undefined,
  })
  activeNotifications.add(notification)
  const release = () => activeNotifications.delete(notification)
  notification.on('click', () => {
    handleNotificationClick(record).catch(() => undefined)
  })
  notification.on('action', () => {
    muteCarePingsToday()
  })
  notification.on('close', release)
  notification.on('failed', release)
  notification.show()
}

export async function generateAndSendCarePing(type: PingType): Promise<CarePingRecord> {
  if (type === 'recommend_track') {
    const track = await pickCareTrack()
    if (!track) return generateAndSendCarePing('casual_check')
    const body = await writePingBody('recommend_track', track)
    const record = insertCarePing('recommend_track', 'Echo', body, { type: 'recommend_track', track })
    sendNotification(record)
    return record
  }
  const body = await writePingBody(type)
  const record = insertCarePing(type, 'Echo', body, { type })
  sendNotification(record)
  return record
}

export async function maybeTriggerCarePing(slot: TimeSlot): Promise<boolean> {
  return (await runCarePingSlot(slot)).triggered
}

export async function runCarePingSlot(slot: TimeSlot): Promise<CarePingRunResult> {
  const settings = getSettings()
  if (!settings.carePings.enabled) {
    return { triggered: false, status: 'skipped', message: '主动通知未开启。' }
  }
  if (isCarePingsMutedToday()) {
    return { triggered: false, status: 'skipped', message: '今天已开启免打扰。' }
  }

  try {
    await generateAndSendCarePing(pickPingType())
    return { triggered: true, status: 'completed', message: `${slot.label ?? '主动通知'}已发送。` }
  } catch (error) {
    const message = error instanceof Error ? error.message : '主动通知生成失败'
    return { triggered: false, status: 'failed', message: '主动通知生成失败。', error: message }
  }
}

export async function testCarePing(type?: PingType): Promise<{ ok: boolean; message: string }> {
  try {
    if (!type) {
      await generateAndSendCarePing('casual_check')
      return { ok: true, message: '测试通知已发出。没有看到的话，请检查 Windows 通知设置。' }
    }
    await generateAndSendCarePing(type)
    return { ok: true, message: 'LLM 测试通知已发出' }
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : '测试通知失败' }
  }
}

export function muteToday(): { ok: boolean; message: string } {
  muteCarePingsToday()
  return { ok: true, message: '今天先不提醒了' }
}
