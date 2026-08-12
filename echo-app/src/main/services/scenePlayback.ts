import { BrowserWindow } from 'electron'
import type { ActiveScene, ChatMessage, PlaybackState, SceneKey, ScenePlaybackOptions, Track } from '../../types/ipc'
import { appendConversation } from '../db/conversations'
import { loadActiveEvents, type ActiveEvent } from '../db/events'
import { appendRecommendedTracks, loadListenedTrackWindows, loadListenedTracksSince, loadRecentRecommendedTracks, skipTodayRecommendedTracks } from '../db/tracks'
import { listExplicitTrackFeedback } from '../db/feedback'
import { getDb } from '../db'
import { getTasteProfile } from '../db/taste'
import { getSettings } from '../db/settings'
import { completeChat } from '../llm/client'
import { stripKnownSystemBlocks } from '../llm/outputSanitize'
import { safePromptJson } from '../llm/promptData'
import { buildMemoryEvidencePrompt } from './memoryEvidence'
import { primaryArtist, trackKey, uniqueTracks } from '../skills/music/identity'
import { isMusicSearchAuthError, searchMusic } from '../skills/music/search'
import { selectDiverseTracks } from '../skills/music/selection'
import { buildSoulPolicyPrompt } from '../skills/soul/policy'
import { clearQueue, enqueue, getState, play } from './playback'
import { markQueueStatus } from './queue'
import { endCurrentScene, getCurrentScene, isSceneSessionCurrent, startScene } from './scene'
import { hasExplicitMemorySource, hasMemorySourceLeak } from './memorySourceGuard'
import { arrangeSceneJourneyTracks, sceneJourneyQuery, sceneJourneyStep, scenePreferenceTerms } from './sceneJourney'

export interface ScenePlaybackResult {
  scene: ActiveScene
  tracks: Track[]
  state: PlaybackState
  message?: ChatMessage
}

export interface ScenePlaybackRuntimeOptions {
  signal?: AbortSignal
  report?: (patch: { phase?: string; current?: number; total?: number; message?: string }) => void
}

interface SceneTrackHistory {
  delivered: Track[]
  outcomes: Track[]
}

class SceneNoPlayableTrackError extends Error {
  constructor() {
    super('Echo 这次没找到能播的歌。')
    this.name = 'SceneNoPlayableTrackError'
  }
}

function shouldPreserveSceneOnPlaybackFailure(options: ScenePlaybackOptions, error: unknown): boolean {
  return Boolean(options.continueSession && error instanceof SceneNoPlayableTrackError)
}

function shouldAppendSceneChatMessage(options: ScenePlaybackOptions): boolean {
  return Boolean(options.appendChatMessage && !options.continueSession && !options.enqueueOnly)
}

function assertScenePlaybackActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('任务已取消', 'AbortError')
}

function waitForSceneRetry(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(new DOMException('任务已取消', 'AbortError'))
      return
    }
    const cleanup = () => signal?.removeEventListener('abort', onAbort)
    const onAbort = () => {
      clearTimeout(timer)
      cleanup()
      reject(new DOMException('任务已取消', 'AbortError'))
    }
    const timer = setTimeout(() => {
      cleanup()
      resolve()
    }, ms)
    signal?.addEventListener('abort', onAbort, { once: true })
  })
}

function shouldRespectSceneSearchCooldown(attempt: number): boolean {
  return attempt < 2
}

function attachScene(scene: ActiveScene, tracks: Track[]): Track[] {
  return tracks.map((track) => ({
    ...track,
    sourceContext: 'scene',
    sceneKey: scene.key,
    sceneLabel: scene.label,
    sceneLine: scene.line,
    sceneSessionId: scene.id,
    profileEvidence: {
      ...(track.profileEvidence ?? {}),
      moods: track.profileEvidence?.moods ?? scene.moods,
      scenes: track.profileEvidence?.scenes ?? scene.scenes,
      source: track.profileEvidence?.source ?? 'scene',
    },
  }))
}

function trackEventTime(track: Track): number {
  const value = track.queueStatusAt ?? track.recommendedAt
  const parsed = value ? Date.parse(value) : Number.NaN
  return Number.isFinite(parsed) ? parsed : 0
}

function orderedUniqueSceneOutcomes(tracks: Track[]): Track[] {
  return uniqueTracks([...tracks].sort((a, b) => trackEventTime(b) - trackEventTime(a)))
}

function sceneTrackHistory(scene: ActiveScene): SceneTrackHistory {
  const delivered = loadListenedTracksSince(6, 500)
    .filter((track) => track.sceneSessionId === scene.id)
  const explicitMisses = listExplicitTrackFeedback(120)
    .filter((item) => item.action === 'not_right' && item.track.sceneSessionId === scene.id)
    .map((item) => ({
      ...item.track,
      queueStatus: 'skipped' as const,
      queueStatusReason: 'explicit_feedback' as const,
      queueStatusAt: item.createdAt,
    }))
  const playbackOutcomes = delivered.filter((track) => (
    track.queueStatus === 'completed'
    || (track.queueStatus === 'skipped'
      && (!track.queueStatusReason || track.queueStatusReason === 'playback_skipped' || track.queueStatusReason === 'explicit_feedback'))
  ))
  return {
    delivered,
    outcomes: orderedUniqueSceneOutcomes([
      ...explicitMisses,
      ...playbackOutcomes,
    ]),
  }
}

function isSuperseded(scene: ActiveScene): boolean {
  return !isSceneSessionCurrent(scene.id)
}

function broadcastChatMessage(message: ChatMessage): void {
  for (const window of BrowserWindow.getAllWindows()) {
    if (!window.isDestroyed()) window.webContents.send('chat:message-injected', message)
  }
}

function recentArtistSet(tracks: Track[]): Set<string> {
  return new Set(tracks.map((track) => primaryArtist(track.artist)).filter(Boolean))
}

function pickSceneTracksFromPool(candidates: Track[], targetCount: number, excluded: Track[], avoidArtistTracks: Track[]): Track[] {
  const strict = selectDiverseTracks(candidates, {
    targetCount,
    maxPerArtist: 1,
    avoidArtists: recentArtistSet(avoidArtistTracks),
    excludeTracks: excluded,
    allowAvoidedArtistFallback: true,
  })
  if (strict.length > 0) return strict

  return selectDiverseTracks(candidates, {
    targetCount,
    maxPerArtist: 2,
    excludeTracks: excluded,
    allowAvoidedArtistFallback: true,
  })
}

function pickSceneTracks(candidates: Track[], targetCount: number): Track[] {
  const recentRecommended = loadRecentRecommendedTracks(120)
  const listenedWindows = loadListenedTrackWindows(24 * 7, 500, 48, 240)
  return pickSceneTracksFromPool(
    candidates,
    targetCount,
    [...recentRecommended, ...listenedWindows.history],
    [...recentRecommended.slice(0, 80), ...listenedWindows.recent],
  )
}

function hasEnoughSceneTracks(candidates: Track[], targetCount: number): boolean {
  return pickSceneTracks(candidates, targetCount).length >= targetCount
}

function sceneFallbackQueries(scene: ActiveScene): string[] {
  const moodLine = scene.moods.join(' ')
  switch (scene.key) {
    case 'focus':
      return ['安静 舒缓 工作 背景音乐', '轻音乐 放松 专注']
    case 'sleepy':
      return ['提神 轻快 流行', '清醒 节奏 明亮']
    case 'relax':
      return ['放松 治愈 舒缓', '轻松 清新 华语']
    case 'irritated':
      return ['安静 放松 舒缓', '降噪 治愈 慢歌']
    case 'random':
      return ['华语流行 轻快', '治愈 流行', '舒服 华语']
    default:
      return [`${scene.label} ${moodLine} 歌`, '华语流行']
  }
}

async function searchSceneTracks(
  scene: ActiveScene,
  targetCount: number,
  runtime: ScenePlaybackRuntimeOptions,
  respectCooldown = true,
): Promise<Track[]> {
  const history = sceneTrackHistory(scene)
  const journeyIndex = history.delivered.length
  const journey = sceneJourneyStep(scene.key, journeyIndex, history.outcomes)
  const learnedTerms = scenePreferenceTerms(loadListenedTracksSince(24 * 30, 2000), scene.key)
  const learnedSuffix = learnedTerms.length > 0 ? ` ${learnedTerms.join(' ')}` : ''
  const queries = Array.from(new Set([`${sceneJourneyQuery(scene.label, journey)}${learnedSuffix}`, scene.prompt, ...sceneFallbackQueries(scene)]))
  const candidates: Track[] = []
  const desiredPoolSize = Math.max(targetCount * 8, 12)
  for (const query of queries) {
    assertScenePlaybackActive(runtime.signal)
    const tracks = await searchMusic({
      query,
      mode: 'scene',
      targetCount,
      candidatePoolSize: Math.max(72, targetCount * 24),
      respectCooldown,
      authoritativeIntentSemantics: true,
      intentOverride: {
        sceneKey: scene.key,
        moods: scene.moods,
        scenes: scene.scenes,
        energy: journey.energy,
        tempo: journey.tempo,
        familiarity: journey.familiarity,
        targetCount,
      },
      signal: runtime.signal,
      onProgress: (patch) => runtime.report?.({
        ...patch,
        phase: patch.phase ? `recommend-${patch.phase}` : 'recommend',
        current: 1,
        total: 4,
      }),
    }).catch((error) => {
      assertScenePlaybackActive(runtime.signal)
      if (isMusicSearchAuthError(error)) throw error
      console.warn('[scene] search failed', { key: scene.key, query, error })
      return []
    })
    assertScenePlaybackActive(runtime.signal)
    if (tracks.length > 0) {
      candidates.push(...tracks)
      const uniqueCandidates = uniqueTracks(candidates)
      if (uniqueCandidates.length >= desiredPoolSize && hasEnoughSceneTracks(uniqueCandidates, targetCount)) break
    }
  }
  return uniqueTracks(candidates)
}

function prepareSceneTracks(scene: ActiveScene, candidates: Track[], targetCount: number): Track[] {
  const history = sceneTrackHistory(scene)
  const freshPool = pickSceneTracks(candidates, Math.max(targetCount * 3, targetCount))
  return attachScene(scene, arrangeSceneJourneyTracks(scene.key, history.delivered.length, freshPool, targetCount, history.outcomes))
}

function getTimeLabel(): string {
  const h = new Date().getHours()
  if (h >= 1 && h < 6) return '深夜'
  if (h < 9) return '早上'
  if (h < 12) return '上午'
  if (h < 14) return '中午'
  if (h < 18) return '下午'
  if (h < 21) return '傍晚'
  return '晚上'
}

function getLastTrackContext(): string {
  const playbackState = getState()
  const last = playbackState.history[0] ?? playbackState.current
  if (!last) return '无'
  const tags = last.semantic?.moods?.slice(0, 2)?.join('/') ?? ''
  return tags ? `《${last.title}》- ${last.artist}，${tags}` : `《${last.title}》- ${last.artist}`
}

function getSceneTransition(currentKey: SceneKey): string {
  const row = getDb()
    .prepare(`
      SELECT label, scene_key FROM scene_sessions
      WHERE user_id = current_user_id() AND status = 'ended'
      ORDER BY ended_at DESC, id DESC
      LIMIT 1
    `)
    .get() as { label: string; scene_key: string } | undefined
  if (!row) return `无 → ${currentKey}`
  const isSame = row.scene_key === currentKey
  return isSame
    ? `${row.label}（连续第二次）`
    : `${row.label} → ${currentKey}`
}

const SCENE_LINE_SYSTEM = `${buildSoulPolicyPrompt('scene')}

你是 Echo，用户的朋友。你正在帮 TA 开始一个听歌场景。

要求：
- 只说一句话，20 字左右，不超过 30 字
- 必须提到用户给你的第一首歌名，用《》，不要自己编歌名
- 严格遵守 sceneLineBrief.stance；mayTease=false 时禁止调侃
- 不复述时间、场景次数、标签或内部判断
- 不要用"接住""安排""安排上"这类套话
- 直接输出那句话，不要解释，不要多余内容`

const SCENE_LINE_BANNED_PATTERN = /接住|安排|安排上|稳稳的|治愈的力量|完全理解你的心情|根据你的画像|根据你的轨迹|根据你的数据|用户|画像|轨迹|数据|算法|记忆策略|纠正过|标签|诊断|人格|你其实|你总是|你一直|太满|太猛|上头|燃爆|往里收/

function compactSceneLine(value: string): string {
  return value.replace(/\s+/g, '').trim().toLowerCase()
}

function bracketedSceneTitles(value: string): string[] {
  return Array.from(value.matchAll(/《([^》]{1,80})》/g), (match) => match[1]?.trim() ?? '').filter(Boolean)
}

function isSceneLineUsable(line: string, first: Track): boolean {
  const clean = compactSceneLine(line)
  const expectedTitle = compactSceneLine(first.title)
  const titles = bracketedSceneTitles(line)
  if (clean.length < 8 || clean.length > 50) return false
  if (!titles.some((title) => compactSceneLine(title) === expectedTitle)) return false
  if (titles.some((title) => compactSceneLine(title) !== expectedTitle)) return false
  if (SCENE_LINE_BANNED_PATTERN.test(line)) return false
  if (hasMemorySourceLeak(line, { maxGap: 28, tail: '不喜欢|少推|别总|别老|纠正|画像|数据|轨迹|记忆' })) return false
  if (hasExplicitMemorySource(line)) return false
  return true
}

function sceneLineBrief(scene: ActiveScene, first: Track, occurrenceCount: number, activeEvents: ActiveEvent[]) {
  const mayTease = scene.key === 'sleepy' && occurrenceCount >= 2 && activeEvents.length === 0
  return {
    stance: mayTease ? 'playful' : scene.key === 'irritated' ? 'quiet' : 'warm',
    mayTease,
    reason: first.sceneJourneyRole ?? 'transition',
    mustMentionTrack: true,
  }
}

async function enqueueSceneTrackBatch(
  tracks: Track[],
  enqueueTrack: (track: Track) => Promise<PlaybackState>,
  onFailure: (track: Track) => void,
  canContinue: () => boolean = () => true,
): Promise<Track[]> {
  const successful: Track[] = []
  for (const track of tracks) {
    if (!canContinue()) break
    try {
      await enqueueTrack(track)
      successful.push(track)
    } catch {
      onFailure(track)
    }
  }
  return successful
}

function buildSceneLineContext(
  scene: ActiveScene,
  first: Track,
  profile: ReturnType<typeof getTasteProfile>,
  current: { timeLabel?: string; lastTrackContext?: string; sceneTransition?: string; activeEvents?: ActiveEvent[]; occurrenceCount?: number } = {},
): string {
  const activeEvents = current.activeEvents ?? loadActiveEvents(6)
  const occurrenceCount = current.occurrenceCount ?? Number((getDb().prepare(`
      SELECT COUNT(*) AS total FROM scene_sessions
      WHERE user_id = current_user_id()
        AND scene_key = ?
        AND date(started_at, 'localtime') = date('now', 'localtime')
    `).get(scene.key) as { total: number } | undefined)?.total ?? 0)
  return [
    safePromptJson({
      timeLabel: current.timeLabel ?? getTimeLabel(),
      lastTrackContext: current.lastTrackContext ?? getLastTrackContext(),
      sceneTransition: current.sceneTransition ?? getSceneTransition(scene.key),
      scene: {
        key: scene.key,
        label: scene.label,
        line: scene.line,
      },
      firstTrack: {
        title: first.title,
        artist: first.artist,
        album: first.album,
        journeyRole: first.sceneJourneyRole,
      },
      sceneLineBrief: sceneLineBrief(scene, first, occurrenceCount, activeEvents),
      activeEvents: activeEvents.map((event) => ({
        content: event.content,
        kind: event.kind,
        scope: event.kind === 'context' ? 'today_context' : 'active_event',
        weight: event.weight ?? null,
        confidence: event.confidence ?? null,
      })),
      activeEventsContract: 'activeEvents 只表示今天仍在发生的短期状态,只能作为场景文案的当下语气线索,不能写成稳定人格、长期偏好或反复模式。',
    }),
    buildMemoryEvidencePrompt(profile),
  ].filter(Boolean).join('\n')
}

async function generateSceneLine(scene: ActiveScene, first: Track, signal?: AbortSignal): Promise<string | null> {
  try {
    const settings = getSettings()
    if (!settings.llm.baseUrl || !settings.llm.apiKey || !settings.llm.model) return null

    const profile = getTasteProfile()
    const context = buildSceneLineContext(scene, first, profile)

    const content = await completeChat(
      settings,
      [
        { role: 'system', content: SCENE_LINE_SYSTEM },
        { role: 'user', content: context },
      ],
      { temperature: 0.7, signal, maxTokens: 80 },
    )

    const trimmed = stripKnownSystemBlocks(content).replace(/^[""「]|[""」]$/g, '').trim()
    if (!trimmed) return null
    if (!isSceneLineUsable(trimmed, first)) return null
    return trimmed
  } catch {
    return null
  }
}

const SCENE_CHAT_TEMPLATES: Record<string, { withTrack: (title: string) => string; noTrack: string }> = {
  focus:     { withTrack: (t) => `好，我把声音放低一点。先听《${t}》，后面几首也排好了。`, noTrack: '好，我先帮你找几首安静的。' },
  sleepy:    { withTrack: (t) => `给你提一点精神。先听《${t}》，节奏别太冲。`, noTrack: '好，我先帮你找几首提神的。' },
  relax:     { withTrack: (t) => `松口气。先听《${t}》，慢慢来。`, noTrack: '好，我先帮你找几首轻松的。' },
  irritated: { withTrack: (t) => `先把外面的声音降下来。先听《${t}》，让脑子缓一缓。`, noTrack: '好，我先帮你找几首安静的。' },
  random:    { withTrack: (t) => `随便来一首？先听《${t}》，后面看心情。`, noTrack: '好，我先从你的口味里捞一首。' },
}

function fallbackSceneLine(scene: ActiveScene, tracks: Track[]): string {
  const first = tracks.find((track) => track.playUrl) ?? tracks[0]
  const template = SCENE_CHAT_TEMPLATES[scene.key]
  if (!template) {
    if (!first) return `好，我先按${scene.label}的感觉帮你找。`
    return `好，我先把声音调到${scene.label}的感觉。先听《${first.title}》，后面几首我也排好了。`
  }
  return first ? template.withTrack(first.title) : template.noTrack
}

async function buildSceneChatLine(scene: ActiveScene, tracks: Track[], signal?: AbortSignal): Promise<string> {
  const first = tracks.find((track) => track.playUrl) ?? tracks[0]
  const llmLine = first ? await generateSceneLine(scene, first, signal) : null
  return llmLine ?? fallbackSceneLine(scene, tracks)
}

export async function startScenePlayback(key: SceneKey, options: ScenePlaybackOptions = {}, runtime: ScenePlaybackRuntimeOptions = {}): Promise<ScenePlaybackResult> {
  assertScenePlaybackActive(runtime.signal)
  const currentScene = options.continueSession ? getCurrentScene() : null
  const scene = currentScene?.key === key ? currentScene : startScene(key)
  try {
    runtime.report?.({ phase: 'recommend', current: 1, total: 4, message: scene.label })
    const targetCount = Math.max(1, Math.min(scene.targetCount, options.targetCount ?? scene.targetCount))
    let recommended: Track[] = []
    for (let attempt = 0; attempt < 3; attempt += 1) {
      recommended = await searchSceneTracks(scene, targetCount, runtime, shouldRespectSceneSearchCooldown(attempt))
      if (recommended.length > 0) break
      if (attempt < 2) {
        runtime.report?.({
          phase: 'recommend-retry',
          current: 1,
          total: 4,
          message: `重新找歌 ${attempt + 1}/2`,
        })
        await waitForSceneRetry(attempt === 0 ? 800 : 1800, runtime.signal)
      }
    }
    assertScenePlaybackActive(runtime.signal)
    if (isSuperseded(scene)) {
      return { scene, tracks: [], state: getState() }
    }

    const tracks = prepareSceneTracks(scene, recommended, targetCount)
    if (tracks.length === 0) {
      throw new SceneNoPlayableTrackError()
    }

    if (options.enqueueOnly) {
      if (isSuperseded(scene)) return { scene, tracks: [], state: getState() }
      appendRecommendedTracks(tracks)
      const enqueuedTracks = await enqueueSceneTrackBatch(
        tracks,
        enqueue,
        (track) => markQueueStatus(track, 'skipped', 'playback_failed'),
        () => !isSuperseded(scene),
      )
      if (isSuperseded(scene)) return { scene, tracks: [], state: getState() }
      if (enqueuedTracks.length === 0) throw new SceneNoPlayableTrackError()
      return { scene, tracks: enqueuedTracks, state: getState() }
    }

    if (isSuperseded(scene)) {
      return { scene, tracks: [], state: getState() }
    }

    const first = tracks.find((track) => track.playUrl) ?? tracks[0]
    runtime.report?.({ phase: 'play', current: 2, total: 4, message: `播放《${first.title}》` })
    let state = await play(first)
    assertScenePlaybackActive(runtime.signal)
    if (isSuperseded(scene)) {
      return { scene, tracks: [], state: getState() }
    }

    runtime.report?.({ phase: 'queue', current: 3, total: 4, message: `准备 ${tracks.length} 首场景歌曲` })
    clearQueue()
    skipTodayRecommendedTracks()
    appendRecommendedTracks(tracks)
    markQueueStatus(first, 'playing', 'playback_started')

    if (isSuperseded(scene)) {
      return { scene, tracks: [], state: getState() }
    }

    const shouldAppendChatMessage = shouldAppendSceneChatMessage(options)
    const chatLinePromise = shouldAppendChatMessage ? buildSceneChatLine(scene, tracks, runtime.signal) : Promise.resolve('')

    const firstKey = trackKey(first)
    const seen = new Set<string>([firstKey])

    for (const track of tracks) {
      if (isSuperseded(scene)) {
        return { scene, tracks: [], state: getState() }
      }

      const keyForTrack = trackKey(track)
      if (!keyForTrack || seen.has(keyForTrack)) continue
      seen.add(keyForTrack)
      try {
        state = await enqueue(track)
      } catch {
        // 单首续链失败时跳过，保留已经开播的场景。
      }
    }

    if (isSuperseded(scene)) {
      return { scene, tracks: [], state: getState() }
    }

    const chatLine = await chatLinePromise
    assertScenePlaybackActive(runtime.signal)
    runtime.report?.({ phase: 'chat-line', current: 4, total: 4, message: scene.label })
    const message = shouldAppendChatMessage ? appendConversation('assistant', chatLine, tracks) : undefined
    if (message) broadcastChatMessage(message)
    return { scene, tracks, state, message }
  } catch (error) {
    if (shouldPreserveSceneOnPlaybackFailure(options, error) && isSceneSessionCurrent(scene.id)) {
      runtime.report?.({ phase: 'idle', current: 4, total: 4, message: `${scene.label}还在，下一轮再找。` })
      return { scene, tracks: [], state: getState() }
    }
    if (isSceneSessionCurrent(scene.id)) endCurrentScene()
    throw error
  }
}

export const scenePlaybackTestHelpers = {
  shouldPreserveSceneOnPlaybackFailure,
  shouldAppendSceneChatMessage,
  shouldRespectSceneSearchCooldown,
  sceneLineBrief,
  createNoPlayableTrackError: () => new SceneNoPlayableTrackError(),
  pickSceneTracksFromPool,
  hasEnoughSceneTracksFromPool: (candidates: Track[], targetCount: number, excluded: Track[], avoidArtistTracks: Track[]) => (
    pickSceneTracksFromPool(candidates, targetCount, excluded, avoidArtistTracks).length >= targetCount
  ),
  isSceneLineUsable,
  buildSceneLineContext,
  orderedUniqueSceneOutcomes,
  enqueueSceneTrackBatch,
}
