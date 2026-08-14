import { app, BrowserWindow, Notification, nativeImage } from 'electron'
import type Database from 'better-sqlite3'
import path from 'node:path'
import type { PingType, Track } from '../../types/ipc'
import { trackIdentity } from '../../shared/trackIdentity'
import { getDb } from '../db'
import { getSettings, updateSetting } from '../db/settings'
import {
  getCarePingById,
  getRecentCarePingBodies,
  getRecentCarePingTracks,
  insertCarePing,
  isCarePingsMutedToday,
  listDueCarePingObservations,
  markCarePingClicked,
  markCarePingDeliveryFailed,
  markCarePingDismissed,
  markCarePingShown,
  muteCarePingsToday,
  unmuteCarePingsToday,
  type CarePingRecord,
} from '../db/carePings'
import { loadRecentConversations, appendConversation } from '../db/conversations'
import { loadProactiveActionSnapshot } from '../db/agentActions'
import { loadActiveEvents, type ActiveEvent } from '../db/events'
import { loadActiveListeningSession } from '../db/listening'
import { appendRecommendedTracks } from '../db/tracks'
import { getTasteProfile } from '../db/taste'
import { completeChat } from '../llm/client'
import { stripKnownSystemBlocks } from '../llm/outputSanitize'
import { loadActiveStageContext } from '../domain/stageContext/repository'
import { attributeTracksToAgentAction, beginAgentAction, completeAgentAction, failAgentAction } from '../domain/agentAction/service'
import { recordAgentActionOutcome } from '../domain/agentAction/repository'
import type { ProactiveBudgetDecision, ProactiveBudgetInput } from '../domain/proactiveBudget/contracts'
import { decideProactiveBudget } from '../domain/proactiveBudget/policy'
import { safePromptJson } from '../llm/promptData'
import { buildSoulPolicyPrompt } from '../skills/soul/policy'
import { readRootFile } from '../utils/paths'
import { getWeather } from '../weather/client'
import { getMostRecentSeal } from './daySeal'
import { recordSchedulerHealth } from './health'
import { play } from './playback'
import { recommendFromNetease } from './recommendation'
import { stableDaySeed, stableInt } from './recommendation/deterministic'
import { carePingReadiness } from './scheduler/readiness'
import { buildMemoryEvidencePrompt } from './memoryEvidence'
import { hasExplicitMemorySource, hasMemorySourceLeak } from './memorySourceGuard'
import { getCurrentScene } from './scene'

export interface TimeSlot {
  key?: string
  label?: string
  hour: number
  minute: number
}

export interface CarePingRunResult {
  triggered: boolean
  status: 'completed' | 'failed' | 'skipped' | 'deferred'
  message: string
  error?: string
  deferredUntil?: string
  decisionCode?: string
}

export interface CarePingRunOptions {
  signal?: AbortSignal
  now?: Date
  evaluationWindowEndAt?: string
  budgetDecision?: ProactiveBudgetDecision
}

interface CarePingPromptContext {
  currentTime: string
  weather: string
  recentConversations: string
  yesterdaySeal: string
  recentNotifications: string
  trackLine: string
  memoryEvidence: string
  activeEvents: Array<{
    content: string
    kind: string
    scope: 'today_context' | 'active_event'
    weight: number | null
    confidence: number | null
  }>
}

const activeNotifications = new Set<Notification>()
type CareTerminalOutcome = 'opened' | 'dismissed' | 'ignored'

class CarePingBudgetChangedError extends Error {
  constructor(readonly decision: ProactiveBudgetDecision) {
    super(decisionMessage(decision))
    this.name = 'CarePingBudgetChangedError'
  }
}

function assertCarePingActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('任务已取消', 'AbortError')
}

function appIcon() {
  const iconPaths = [
    path.join(process.resourcesPath, 'brand', 'icon.ico'),
    path.join(process.env.VITE_PUBLIC ?? '', 'brand', 'icon.ico'),
  ]
  for (const iconPath of iconPaths) {
    const icon = nativeImage.createFromPath(iconPath)
    if (!icon.isEmpty()) return icon
  }
  return nativeImage.createFromDataURL(
    'data:image/svg+xml;utf8,' +
      encodeURIComponent('<svg xmlns="http://www.w3.org/2000/svg" width="256" height="256"><rect width="256" height="256" rx="58" fill="#639922"/><text x="128" y="161" text-anchor="middle" font-family="Georgia,serif" font-size="128" fill="#F5FAED">E</text></svg>'),
  )
}

function activeEventsForCarePrompt(events: ActiveEvent[] = loadActiveEvents(4)): CarePingPromptContext['activeEvents'] {
  return events.map((event) => ({
    content: event.content,
    kind: event.kind,
    scope: event.kind === 'context' ? 'today_context' : 'active_event',
    weight: event.weight ?? null,
    confidence: event.confidence ?? null,
  }))
}

function pickPingType(): PingType {
  const hour = new Date().getHours()
  const value = stableInt(`${stableDaySeed()}:care-ping-type:${hour}`, 10) / 10
  if (value < 0.4) return 'recommend_track'
  if (value < 0.7) return 'casual_check'
  return 'voice_invite'
}

function cleanBody(value: string, max = 80): string {
  const normalized = stripKnownSystemBlocks(value)
    .replace(/```[\s\S]*?```/g, (block) => block.replace(/```[a-z]*|```/gi, ''))
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
  /我给你接上/,
  /给你安排/,
  /安排上/,
  /让你稳稳的/,
  /接住你/,
  /把情绪接住/,
  /把空气撑住/,
  /音乐是治愈的力量/,
  /完全理解你的心情/,
  /根据你的画像/,
  /根据你的轨迹/,
  /根据你的数据/,
  /画像/,
  /轨迹/,
  /数据/,
  /算法/,
  /记忆策略/,
  /纠正过/,
  /标签/,
  /诊断/,
  /人格/,
  /你其实/,
  /你总是/,
  /你一直/,
  /太满/,
  /太猛/,
  /上头/,
  /燃爆/,
  /往里收/,
  /#+\s*/,
  /---/,
  /\[[^\]]+\]/,
]

function isUnsafeBody(body: string): boolean {
  const normalized = body.trim()
  if (!normalized) return true
  if (normalized.length > 110) return true
  if (hasMemorySourceLeak(normalized, { maxGap: 32, tail: '不喜欢|少推|别总|别老|纠正|画像|数据|轨迹|记忆' })) return true
  if (hasExplicitMemorySource(normalized)) return true
  return UNSAFE_BODY_PATTERNS.some((pattern) => pattern.test(normalized))
}

function compactTrackText(value: string): string {
  return value.replace(/\s+/g, '').trim().toLowerCase()
}

function bracketedTitles(value: string): string[] {
  return Array.from(value.matchAll(/《([^》]{1,80})》/g), (match) => match[1]?.trim() ?? '').filter(Boolean)
}

function hasWrongBracketedTrackTitle(body: string, track: Track): boolean {
  const expected = compactTrackText(track.title)
  const titles = bracketedTitles(body)
  return titles.some((title) => compactTrackText(title) !== expected)
}

function isCarePingBodyUsableForTrack(body: string, track: Track): boolean {
  if (isUnsafeBody(body)) return false
  if (hasWrongBracketedTrackTitle(body, track)) return false
  const compact = compactTrackText(body)
  return compact.includes(compactTrackText(track.title)) && compact.includes(compactTrackText(track.artist))
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

async function buildPromptContext(track?: Track, options: CarePingRunOptions = {}) {
  assertCarePingActive(options.signal)
  const settings = getSettings()
  const weather = await getWeather(settings.user.city, { signal: options.signal }).catch((error) => {
    assertCarePingActive(options.signal)
    console.warn('[care-pings] weather unavailable', error)
    return null
  })
  assertCarePingActive(options.signal)
  const conversations = loadRecentConversations(5)
  const recentConversations = conversations.length > 0
    ? conversations.map((item) => `${item.role}: ${item.content.slice(0, 120)}`).join('\n')
    : '(暂无)'
  const now = new Date()
  const w = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']
  const currentTime = `${now.getMonth() + 1}月${now.getDate()}日 ${w[now.getDay()]} ${String(now.getHours()).padStart(2, '0')}:${String(now.getMinutes()).padStart(2, '0')}`
  return {
    currentTime,
    weather: weather?.summary ?? '未知',
    recentConversations,
    yesterdaySeal: getMostRecentSeal().slice(0, 700) || '(暂无)',
    recentNotifications: getRecentCarePingBodies(7).filter((body) => !isUnsafeBody(body)).join('\n') || '(暂无)',
    trackLine: track ? `${track.artist}的《${track.title}》` : '',
    memoryEvidence: buildMemoryEvidencePrompt(getTasteProfile()),
    activeEvents: activeEventsForCarePrompt(),
  }
}

function fillPrompt(template: string, context: CarePingPromptContext): string {
  return template
    .replace(/\{time\}/g, context.currentTime)
    .replace(/\{weather\}/g, context.weather)
    .replace(/\{artist\}/g, context.trackLine.split('的《')[0] ?? '')
    .replace(/\{track_title\}/g, context.trackLine.match(/《(.+)》/)?.[1] ?? '')
    .replace(/\{recent_signals\}/g, context.recentConversations)
    .replace(/\{recent_conversations\}/g, context.recentConversations)
    .replace(/\{yesterday_seal_summary\}/g, context.yesterdaySeal)
    .replace(/\{recent_notifications\}/g, context.recentNotifications)
    .replace(/\{memory_evidence\}/g, context.memoryEvidence)
}

function buildCarePingPromptInput(user: string, context: CarePingPromptContext): string {
  return [
    context.memoryEvidence,
    safePromptJson({
      prompt: user,
      recentNotifications: context.recentNotifications,
      activeEvents: context.activeEvents,
      activeEventsContract: 'activeEvents 只表示今天仍在发生的短期状态,只能作为时机和语气线索,不能写成稳定人格、长期偏好或反复模式。',
      instruction: '现在输出最终通知正文。',
    }),
  ].join('\n')
}

async function writePingBody(type: PingType, track?: Track, options: CarePingRunOptions = {}): Promise<string> {
  assertCarePingActive(options.signal)
  const settings = getSettings()
  const promptFile = type === 'recommend_track'
    ? 'prompts/care-ping-recommend.md'
    : type === 'voice_invite'
      ? 'prompts/care-ping-voice-invite.md'
      : 'prompts/care-ping-casual.md'
  const context = await buildPromptContext(track, options)
  const user = fillPrompt(readRootFile(promptFile), context)
  const fallback = fallbackPingBody(type, track)
  try {
    const body = cleanBody(await completeChat(settings, [
      {
        role: 'system',
        content: [
          '你是 Echo，只写 Windows 系统通知正文。',
          buildSoulPolicyPrompt('care'),
          '这段文字会直接弹到用户桌面上。',
          '只输出通知正文这一句话或两句短句。',
          '严禁写成模板、公告、客服回复、写作建议。',
          '严禁出现“通知”“模板”“请把信息发给我”“可直接发”等办公写作口吻。',
          '不要暴露画像、记忆、候选、策略、标签或内部规则。',
        ].join('\n'),
      },
      { role: 'user', content: buildCarePingPromptInput(user, context) },
    ], { temperature: 0.86, signal: options.signal, maxTokens: 100 }), type === 'recommend_track' ? 96 : 72)
    assertCarePingActive(options.signal)
    if (!body || isUnsafeBody(body)) return fallback
    if (track && hasWrongBracketedTrackTitle(body, track)) return fallback
    if (track && (!compactTrackText(body).includes(compactTrackText(track.title)) || !compactTrackText(body).includes(compactTrackText(track.artist)))) {
      const withTrack = `${body} ${track.artist}的《${track.title}》。`
      return isCarePingBodyUsableForTrack(withTrack, track) ? withTrack : fallback
    }
    return body
  } catch (error) {
    assertCarePingActive(options.signal)
    const detail = error instanceof Error ? error.message : 'LLM 通知正文生成失败'
    recordSchedulerHealth('care-ping', 'degraded', '通知正文生成失败，已使用备用文案。', detail)
    return fallback
  }
}

async function pickCareTrack(options: CarePingRunOptions = {}): Promise<Track | null> {
  assertCarePingActive(options.signal)
  const candidates = await recommendFromNetease('这个时候,给我一首适合主动推荐的歌', undefined, { signal: options.signal }).catch(() => {
    assertCarePingActive(options.signal)
    return []
  })
  assertCarePingActive(options.signal)
  const recentKeys = new Set(getRecentCarePingTracks(20).map(trackIdentity).filter(Boolean))
  return candidates.find((track) => !recentKeys.has(trackIdentity(track))) ?? candidates[0] ?? null
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
  recordCareTerminalOutcome(record, 'opened')
  if (record.type === 'recommend_track' && record.payload.track) {
    appendRecommendedTracks([record.payload.track])
    const message = appendConversation('assistant', record.body, [record.payload.track])
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

function recordCareTerminalOutcome(
  record: CarePingRecord,
  outcome: CareTerminalOutcome,
  at = new Date(),
  database: Database.Database = getDb(),
): boolean {
  const actionId = record.payload.agentActionId
  if (!actionId) return false
  return database.transaction(() => {
    const existing = database.prepare(`
      SELECT outcome_type
      FROM agent_action_outcomes
      WHERE action_id = ? AND outcome_type IN ('opened', 'dismissed', 'ignored')
    `).all(actionId) as Array<{ outcome_type: CareTerminalOutcome }>
    const existingTypes = new Set(existing.map((item) => item.outcome_type))
    if (existingTypes.has(outcome)) return false
    if (outcome === 'ignored' && existingTypes.size > 0) return false
    if (outcome === 'opened' && (existingTypes.has('dismissed') || existingTypes.has('ignored'))) return false
    if (outcome === 'dismissed' && existingTypes.has('ignored')) return false
    if (outcome === 'opened') markCarePingClicked(record.id, at, database)
    if (outcome === 'dismissed') markCarePingDismissed(record.id, at, database)
    return recordAgentActionOutcome({
      actionId,
      actionItemId: record.payload.agentActionItemId,
      sourceEventKey: `care_${outcome}:${record.id}`,
      outcomeType: outcome,
      polarity: outcome === 'opened' ? 'neutral' : 'negative',
      strength: outcome === 'dismissed' ? 'strong' : outcome === 'ignored' ? 'weak' : 'medium',
      occurredAt: at.toISOString(),
      metadata: { userAgency: outcome === 'ignored' ? 'passive' : 'active' },
    }, database).inserted
  })()
}

function recordCareDeliveryFailure(record: CarePingRecord, error?: string): void {
  const actionId = record.payload.agentActionId
  if (!actionId) return
  const database = getDb()
  database.transaction(() => {
    markCarePingDeliveryFailed(record.id, database)
    recordAgentActionOutcome({
      actionId,
      actionItemId: record.payload.agentActionItemId,
      sourceEventKey: `care_system_failure:${record.id}`,
      outcomeType: 'system_failure',
      polarity: 'neutral',
      strength: 'weak',
      metadata: { userAgency: 'passive', ...(error ? { failureKind: error.slice(0, 120) } : {}) },
    }, database)
  })()
}

export function reconcileCarePingOutcomes(now = new Date(), database: Database.Database = getDb()): number {
  let inserted = 0
  for (const record of listDueCarePingObservations(now, database)) {
    if (recordCareTerminalOutcome(record, 'ignored', now, database)) inserted += 1
  }
  return inserted
}

export function pauseCarePings(
  mode: 'today' | 'week' | 'resume',
  now = new Date(),
): { ok: boolean; message: string; settings: ReturnType<typeof getSettings> } {
  if (mode === 'resume') {
    unmuteCarePingsToday()
    return { ok: true, message: 'Echo 可以重新在合适的时候出现了。', settings: updateSetting('carePings.pausedUntil', '') }
  }
  const pausedUntil = new Date(now)
  if (mode === 'today') {
    pausedUntil.setDate(pausedUntil.getDate() + 1)
    pausedUntil.setHours(8, 0, 0, 0)
    muteCarePingsToday()
  } else {
    pausedUntil.setDate(pausedUntil.getDate() + 7)
  }
  const settings = updateSetting('carePings.pausedUntil', pausedUntil.toISOString())
  return {
    ok: true,
    message: mode === 'today' ? 'Echo 会安静到明早 8 点。' : 'Echo 会安静 7 天。',
    settings,
  }
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
    handleNotificationClick(record).catch((error) => {
      const technical = error instanceof Error ? error.message : String(error)
      recordSchedulerHealth('care-ping', 'degraded', '通知点击处理失败。', technical)
    })
  })
  notification.on('action', () => {
    try {
      recordCareTerminalOutcome(record, 'dismissed')
      pauseCarePings('today')
    } catch (error) {
      recordSchedulerHealth('care-ping', 'degraded', '通知暂停操作失败。', error instanceof Error ? error.message : String(error))
    }
  })
  notification.on('close', release)
  notification.on('failed', (_event, error) => {
    release()
    try {
      recordCareDeliveryFailure(record, error)
    } catch (failureError) {
      recordSchedulerHealth('care-ping', 'degraded', '通知失败结果记录失败。', failureError instanceof Error ? failureError.message : String(failureError))
    }
  })
  notification.show()
  markCarePingShown(record.id)
}

export async function generateAndSendCarePing(type: PingType, options: CarePingRunOptions = {}): Promise<CarePingRecord> {
  assertCarePingActive(options.signal)
  if (type === 'recommend_track') {
    const track = await pickCareTrack(options)
    if (!track) return generateAndSendCarePing('casual_check', options)
    const body = await writePingBody('recommend_track', track, options)
    assertCarePingActive(options.signal)
    const finalDecision = recheckCarePingBudget(options)
    return persistCarePingAction('recommend_track', body, track, finalDecision)
  }
  const body = await writePingBody(type, undefined, options)
  assertCarePingActive(options.signal)
  const finalDecision = recheckCarePingBudget(options)
  return persistCarePingAction(type, body, undefined, finalDecision)
}

function recheckCarePingBudget(
  options: CarePingRunOptions,
  currentDecision: () => ProactiveBudgetDecision = () => decideProactiveBudget(buildProactiveBudgetInput({ ...options, now: options.now ?? new Date() })),
): ProactiveBudgetDecision | undefined {
  if (!options.budgetDecision) return undefined
  const decision = currentDecision()
  if (decision.verdict !== 'allow') throw new CarePingBudgetChangedError(decision)
  return decision
}

function persistCarePingAction(type: PingType, body: string, track?: Track, budgetDecision?: ProactiveBudgetDecision): CarePingRecord {
  const stageContext = loadActiveStageContext()
  const action = beginAgentAction({
    origin: 'care',
    actionType: 'reply',
    reasonCode: 'proactive_check',
    goalCode: stageContext?.goal ?? 'companionship',
    stageContextId: stageContext?.id,
    stageContextRevision: stageContext?.revision,
    items: [
      { itemType: 'message', ordinal: 0, payload: { characterCount: body.length, pingType: type } },
      ...(track ? [{ itemType: 'track' as const, ordinal: 1, entityKey: `${track.id ?? track.neteaseId ?? ''}:${track.title}:${track.artist}`, payload: { title: track.title, artist: track.artist } }] : []),
    ],
    decision: { policyVersion: 1, pingType: type, ...(budgetDecision ?? {}) },
  })
  try {
    const attributedTrack = track
      ? attributeTracksToAgentAction(action, [{ ...track, sourceContext: 'care' }])[0]
      : undefined
    const record = insertCarePing(type, 'Echo', body, attributedTrack
      ? { type, track: attributedTrack, agentActionId: action.id, agentActionItemId: attributedTrack.agentActionItemId }
      : { type, agentActionId: action.id, agentActionItemId: action.items[0]?.id })
    sendNotification(record)
    completeAgentAction(action)
    return record
  } catch (error) {
    failAgentAction(action, 'notification_delivery_failed')
    throw error
  }
}

function recordCareSilence(decision: ProactiveBudgetDecision): void {
  const stageContext = loadActiveStageContext()
  const action = beginAgentAction({
    origin: 'care',
    actionType: 'stay_silent',
    reasonCode: ['disabled', 'paused', 'muted_today', 'fullscreen_blocked'].includes(decision.code)
      ? 'muted_or_blocked'
      : 'low_intervention_value',
    goalCode: stageContext?.goal ?? 'none',
    stageContextId: stageContext?.id,
    stageContextRevision: stageContext?.revision,
    decision: { ...decision },
  })
  completeAgentAction(action)
}

function localIsoDate(date: Date): string {
  const year = date.getFullYear()
  const month = String(date.getMonth() + 1).padStart(2, '0')
  const day = String(date.getDate()).padStart(2, '0')
  return `${year}-${month}-${day}`
}

function decisionMessage(decision: ProactiveBudgetDecision): string {
  const messages: Record<ProactiveBudgetDecision['code'], string> = {
    eligible: '这次适合轻轻出现。',
    disabled: '主动通知未开启。',
    paused: '主动关心仍在暂停中。',
    muted_today: '今天已开启免打扰。',
    quiet_hours: '现在处于安静时段。',
    daily_budget_exhausted: '今天出现的次数已经够了。',
    cooldown: '距离上次主动关心还太近。',
    recent_negative_feedback: '最近几次主动关心没有得到回应，先安静一阵。',
    recent_user_activity: '你刚刚还在和 Echo 互动，暂时不额外打扰。',
    active_session: '当前陪伴还在进行，不重复打扰。',
    fullscreen_blocked: '检测到全屏状态，暂不打扰。',
    stage_prefers_quiet: '当前阶段更适合安静陪伴。',
    safety_caution: '当前状态需要更谨慎，暂停普通主动通知。',
    insufficient_evidence: 'Echo 还在积累相处线索。',
  }
  return messages[decision.code]
}

function buildProactiveBudgetInput(options: CarePingRunOptions = {}): ProactiveBudgetInput {
  const now = options.now ?? new Date()
  const settings = getSettings()
  const snapshot = loadProactiveActionSnapshot(localIsoDate(now))
  const lastUserMessage = loadRecentConversations(30).filter((message) => message.role === 'user').at(-1)
  const readiness = carePingReadiness()
  const fullscreenBlocked = settings.carePings.detectFullscreen
    && BrowserWindow.getAllWindows().some((window) => !window.isDestroyed() && window.isFullScreen())
  return {
    now,
    enabled: settings.carePings.enabled,
    frequency: settings.carePings.frequency,
    quietHours: settings.carePings.quietHours,
    pausedUntil: settings.carePings.pausedUntil,
    mutedToday: isCarePingsMutedToday(),
    activeStage: loadActiveStageContext(now),
    lastUserInteractionAt: lastUserMessage?.createdAt,
    activeListeningSession: Boolean(loadActiveListeningSession(now)),
    activeSceneSession: Boolean(getCurrentScene()),
    fullscreenBlocked,
    sentToday: snapshot.sentToday,
    lastSentAt: snapshot.lastSentAt,
    recentInterventionOutcomes: snapshot.recentOutcomes,
    evidenceReady: readiness.ready,
    evaluationWindowEndAt: options.evaluationWindowEndAt,
  }
}

export async function maybeTriggerCarePing(slot: TimeSlot, options: CarePingRunOptions = {}): Promise<boolean> {
  return (await runCarePingSlot(slot, options)).triggered
}

export async function runCarePingSlot(slot: TimeSlot, options: CarePingRunOptions = {}): Promise<CarePingRunResult> {
  assertCarePingActive(options.signal)
  const decision = options.budgetDecision ?? decideProactiveBudget(buildProactiveBudgetInput(options))
  if (decision.verdict !== 'allow') {
    recordCareSilence(decision)
    const message = decisionMessage(decision)
    if (decision.verdict === 'defer' && decision.eligibleAt) {
      return {
        triggered: false,
        status: 'deferred',
        message,
        deferredUntil: decision.eligibleAt,
        decisionCode: decision.code,
      }
    }
    return { triggered: false, status: 'skipped', message, decisionCode: decision.code }
  }

  try {
    await generateAndSendCarePing(pickPingType(), { ...options, budgetDecision: decision })
    return { triggered: true, status: 'completed', message: `${slot.label ?? '主动通知'}已发送。`, decisionCode: decision.code }
  } catch (error) {
    assertCarePingActive(options.signal)
    if (error instanceof CarePingBudgetChangedError) {
      const finalDecision = error.decision
      recordCareSilence(finalDecision)
      const message = decisionMessage(finalDecision)
      if (finalDecision.verdict === 'defer' && finalDecision.eligibleAt) {
        return {
          triggered: false,
          status: 'deferred',
          message,
          deferredUntil: finalDecision.eligibleAt,
          decisionCode: finalDecision.code,
        }
      }
      return { triggered: false, status: 'skipped', message, decisionCode: finalDecision.code }
    }
    const message = error instanceof Error ? error.message : '主动通知生成失败'
    return { triggered: false, status: 'failed', message: '主动通知生成失败。', error: message }
  }
}

export async function testCarePing(type?: PingType, options: CarePingRunOptions = {}): Promise<{ ok: boolean; message: string }> {
  assertCarePingActive(options.signal)
  try {
    if (!type) {
      await generateAndSendCarePing('casual_check', options)
      return { ok: true, message: '测试通知已发出。没有看到的话，请检查 Windows 通知设置。' }
    }
    await generateAndSendCarePing(type, options)
    return { ok: true, message: 'LLM 测试通知已发出' }
  } catch (error) {
    assertCarePingActive(options.signal)
    return { ok: false, message: error instanceof Error ? error.message : '测试通知失败' }
  }
}

export const carePingTestHelpers = {
  activeEventsForCarePrompt,
  cleanBody,
  isUnsafeBody,
  isCarePingBodyUsableForTrack,
  buildCarePingPromptInput,
  decisionMessage,
  recordCareTerminalOutcome,
  recheckCarePingBudget,
}

export function muteToday(carePingId?: number): { ok: boolean; message: string } {
  if (carePingId) {
    const record = getCarePingById(carePingId)
    if (record) recordCareTerminalOutcome(record, 'dismissed')
  }
  pauseCarePings('today')
  return { ok: true, message: 'Echo 会安静到明早 8 点。' }
}
