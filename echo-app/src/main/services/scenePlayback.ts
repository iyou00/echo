import { BrowserWindow } from 'electron'
import type { ActiveScene, ChatMessage, PlaybackState, SceneKey, ScenePlaybackOptions, Track } from '../../types/ipc'
import { appendConversation } from '../db/conversations'
import { appendRecommendedTracks, loadListenedTrackWindows, loadRecentRecommendedTracks, skipTodayRecommendedTracks } from '../db/tracks'
import { getDb } from '../db'
import { getTasteProfile } from '../db/taste'
import { getSettings } from '../db/settings'
import { completeChat } from '../llm/client'
import { stripKnownSystemBlocks } from '../llm/outputSanitize'
import { primaryArtist, trackKey, uniqueTracks } from '../skills/music/identity'
import { isMusicSearchAuthError, searchMusic } from '../skills/music/search'
import { selectDiverseTracks } from '../skills/music/selection'
import { buildSoulPolicyPrompt } from '../skills/soul/policy'
import { clearQueue, enqueue, getState, play } from './playback'
import { markQueueStatus } from './queue'
import { endCurrentScene, getCurrentScene, isSceneSessionCurrent, startScene } from './scene'

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

class SceneNoPlayableTrackError extends Error {
  constructor() {
    super('Echo 这次没找到能播的歌。')
    this.name = 'SceneNoPlayableTrackError'
  }
}

function assertScenePlaybackActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('任务已取消', 'AbortError')
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

function pickSceneTracks(candidates: Track[], targetCount: number): Track[] {
  const recentRecommended = loadRecentRecommendedTracks(120)
  const listenedWindows = loadListenedTrackWindows(24 * 7, 500, 48, 240)
  const excluded = [...recentRecommended, ...listenedWindows.history]
  const strict = selectDiverseTracks(candidates, {
    targetCount,
    maxPerArtist: 1,
    avoidArtists: recentArtistSet([...recentRecommended.slice(0, 80), ...listenedWindows.recent]),
    excludeTracks: excluded,
    allowAvoidedArtistFallback: true,
  })
  if (strict.length > 0) return strict

  return selectDiverseTracks(candidates, {
    targetCount,
    maxPerArtist: 2,
    allowAvoidedArtistFallback: true,
  })
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

async function searchSceneTracks(scene: ActiveScene, targetCount: number, runtime: ScenePlaybackRuntimeOptions): Promise<Track[]> {
  const queries = Array.from(new Set([scene.prompt, ...sceneFallbackQueries(scene)]))
  const candidates: Track[] = []
  const desiredPoolSize = Math.max(targetCount * 8, 12)
  for (const query of queries) {
    assertScenePlaybackActive(runtime.signal)
    const tracks = await searchMusic({
      query,
      mode: 'scene',
      targetCount,
      candidatePoolSize: Math.max(72, targetCount * 24),
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
      if (uniqueTracks(candidates).length >= desiredPoolSize) break
    }
  }
  return uniqueTracks(candidates)
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
  const last = playbackState.history[playbackState.history.length - 1] ?? playbackState.current
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
- 每次从不同角度切入——关心、调侃、鼓励、反问、陈述，随机选一种
- 不要用"接住""安排""安排上"这类套话
- 直接输出那句话，不要解释，不要多余内容`

async function generateSceneLine(scene: ActiveScene, first: Track, signal?: AbortSignal): Promise<string | null> {
  try {
    const settings = getSettings()
    if (!settings.llm.baseUrl || !settings.llm.apiKey || !settings.llm.model) return null

    const profile = getTasteProfile()
    const portrait = profile?.echo_portrait?.trim()
    const portraitLine = portrait ? `用户画像：${portrait.slice(0, 60)}` : ''

    const lines = [
      portraitLine,
      `此刻：${getTimeLabel()}`,
      `上一首：${getLastTrackContext()}`,
      `场景切换：${getSceneTransition(scene.key)}`,
      `场景：${scene.label}——${scene.line}`,
      `第一首：《${first.title}》- ${first.artist}`,
    ].filter(Boolean)

    const content = await completeChat(
      settings,
      [
        { role: 'system', content: SCENE_LINE_SYSTEM },
        { role: 'user', content: lines.join('\n') },
      ],
      { temperature: 0.7, signal, maxTokens: 300 },
    )

    const trimmed = stripKnownSystemBlocks(content).replace(/^[""「]|[""」]$/g, '').trim()
    if (!trimmed) return null
    // 兜底截断：LLM 偶尔会啰嗦
    if (trimmed.length > 50) return trimmed.slice(0, 50)
    return trimmed
  } catch {
    return null
  }
}

const SCENE_CHAT_TEMPLATES: Record<string, { withTrack: (title: string) => string; noTrack: string }> = {
  focus:     { withTrack: (t) => `好，我把声音放低一点。先听《${t}》，后面几首也排好了。`, noTrack: '好，我先帮你找几首安静的。' },
  sleepy:    { withTrack: (t) => `给你提一点精神。先听《${t}》，别一下子太猛。`, noTrack: '好，我先帮你找几首提神的。' },
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
    const recommended = await searchSceneTracks(scene, targetCount, runtime)
    assertScenePlaybackActive(runtime.signal)
    if (isSuperseded(scene)) {
      return { scene, tracks: [], state: getState() }
    }

    const tracks = attachScene(scene, pickSceneTracks(recommended, targetCount))
    if (tracks.length === 0) {
      throw new SceneNoPlayableTrackError()
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
    markQueueStatus(first, 'playing')

    if (isSuperseded(scene)) {
      return { scene, tracks: [], state: getState() }
    }

    const chatLinePromise = options.appendChatMessage ? buildSceneChatLine(scene, tracks, runtime.signal) : Promise.resolve('')

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
    const message = options.appendChatMessage ? appendConversation('assistant', chatLine, tracks) : undefined
    if (message) broadcastChatMessage(message)
    return { scene, tracks, state, message }
  } catch (error) {
    if (options.continueSession && error instanceof SceneNoPlayableTrackError) {
      return { scene, tracks: [], state: getState() }
    }
    if (isSceneSessionCurrent(scene.id)) endCurrentScene()
    throw error
  }
}
