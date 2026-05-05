import type { ActiveScene, ChatMessage, PlaybackState, SceneKey, ScenePlaybackOptions, Track } from '../../types/ipc'
import { appendConversation } from '../db/conversations'
import { appendRecommendedTracks, skipTodayRecommendedTracks } from '../db/tracks'
import { getDb } from '../db'
import { getTasteProfile } from '../db/taste'
import { getSettings } from '../db/settings'
import { completeChat } from '../llm/client'
import { recommendFromNetease } from './recommendation'
import { clearQueue, enqueue, getState, play } from './playback'
import { endCurrentScene, hasNewerSceneSession, isSceneSessionCurrent, startScene } from './scene'

export interface ScenePlaybackResult {
  scene: ActiveScene
  tracks: Track[]
  state: PlaybackState
  message?: ChatMessage
}

function trackKey(track: Track): string {
  const neteaseId = String(track.neteaseId ?? '').trim()
  if (neteaseId) return `netease:${neteaseId}`
  const id = String(track.id ?? '').trim()
  if (id) return `id:${id}`
  return `name:${track.title.trim().toLowerCase()}::${track.artist.trim().toLowerCase()}`
}

function attachScene(scene: ActiveScene, tracks: Track[]): Track[] {
  return tracks.map((track) => ({
    ...track,
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
  return !isSceneSessionCurrent(scene.id) && hasNewerSceneSession(scene)
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
      WHERE user_id = 1 AND status = 'ended'
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

const SCENE_LINE_SYSTEM = `你是 Echo，用户的朋友。你正在帮 TA 开始一个听歌场景。

要求：
- 只说一句话，20 字左右，不超过 30 字
- 必须提到用户给你的第一首歌名，用《》，不要自己编歌名
- 每次从不同角度切入——关心、调侃、鼓励、反问、陈述，随机选一种
- 不要用"接住""安排""安排上"这类套话
- 直接输出那句话，不要解释，不要多余内容`

async function generateSceneLine(scene: ActiveScene, first: Track): Promise<string | null> {
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
      { temperature: 0.7 },
    )

    const trimmed = content.replace(/^[""「]|[""」]$/g, '').trim()
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

async function buildSceneChatLine(scene: ActiveScene, tracks: Track[]): Promise<string> {
  const first = tracks.find((track) => track.playUrl) ?? tracks[0]
  const llmLine = first ? await generateSceneLine(scene, first) : null
  return llmLine ?? fallbackSceneLine(scene, tracks)
}

export async function startScenePlayback(key: SceneKey, options: ScenePlaybackOptions = {}): Promise<ScenePlaybackResult> {
  const scene = startScene(key)
  try {
    const recommended = await recommendFromNetease(scene.prompt)
    if (isSuperseded(scene)) {
      return { scene, tracks: [], state: getState() }
    }

    const tracks = attachScene(scene, recommended).slice(0, scene.targetCount)
    if (tracks.length === 0) {
      throw new Error('Echo 这次没找到能播的歌。')
    }

    if (isSuperseded(scene)) {
      return { scene, tracks: [], state: getState() }
    }

    // LLM 生成开场白和播放并行执行
    const chatLinePromise = options.appendChatMessage ? buildSceneChatLine(scene, tracks) : Promise.resolve('')

    clearQueue()
    skipTodayRecommendedTracks()
    appendRecommendedTracks(tracks)

    if (isSuperseded(scene)) {
      return { scene, tracks: [], state: getState() }
    }

    const first = tracks.find((track) => track.playUrl) ?? tracks[0]
    let state = await play(first)
    if (isSuperseded(scene)) {
      return { scene, tracks: [], state: getState() }
    }

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
    const message = options.appendChatMessage ? appendConversation('assistant', chatLine, tracks) : undefined
    return { scene, tracks, state, message }
  } catch (error) {
    if (isSceneSessionCurrent(scene.id)) endCurrentScene()
    throw error
  }
}
