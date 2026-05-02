import type { ActiveScene, ChatMessage, PlaybackState, SceneKey, ScenePlaybackOptions, Track } from '../../types/ipc'
import { appendConversation } from '../db/conversations'
import { appendRecommendedTracks, skipTodayRecommendedTracks } from '../db/tracks'
import { recommendFromNetease } from './recommendation'
import { clearQueue, enqueue, play } from './playback'
import { endCurrentScene, startScene } from './scene'

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

function buildSceneChatLine(scene: ActiveScene, tracks: Track[]): string {
  const first = tracks[0]
  if (!first) return `我切到${scene.label}了，先帮你把歌排起来。`
  return `我切到${scene.label}了。先放《${first.title}》，后面几首我也排好了。`
}

export async function startScenePlayback(key: SceneKey, options: ScenePlaybackOptions = {}): Promise<ScenePlaybackResult> {
  const scene = startScene(key)
  try {
    const recommended = await recommendFromNetease(scene.prompt)
    const tracks = attachScene(scene, recommended).slice(0, scene.targetCount)
    if (tracks.length === 0) {
      throw new Error('Echo 这次没找到能播的歌。')
    }

    clearQueue()
    skipTodayRecommendedTracks()
    appendRecommendedTracks(tracks)

    const first = tracks.find((track) => track.playUrl) ?? tracks[0]
    let state = await play(first)
    const firstKey = trackKey(first)
    const seen = new Set<string>([firstKey])

    for (const track of tracks) {
      const keyForTrack = trackKey(track)
      if (!keyForTrack || seen.has(keyForTrack)) continue
      seen.add(keyForTrack)
      try {
        state = await enqueue(track)
      } catch {
        // 单首续链失败时跳过，保留已经开播的场景。
      }
    }

    const message = options.appendChatMessage ? appendConversation('assistant', buildSceneChatLine(scene, tracks), tracks) : undefined
    return { scene, tracks, state, message }
  } catch (error) {
    endCurrentScene()
    throw error
  }
}
