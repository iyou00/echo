import type { Track } from '../../../types/ipc'
import { loadTodayConversations } from '../../db/conversations'
import {
  inferMusicSearchIntent,
  isMusicSearchAuthError,
  searchMusic,
  type MusicSearchFailure,
  type MusicSearchMode,
} from '../../skills/music/search'
import type { MusicEntityResolution } from '../../skills/music/entityResolver'
import { getCurrentScene } from '../scene'
import { classifyFallbackChatIntent, type ChatIntent } from './intent'

export interface ChatActiveTask {
  readonly canceled: boolean
  signal: AbortSignal
}

export interface ChatRecommendationCandidatesResult {
  candidates: Track[]
  authRequired: boolean
  canceled?: boolean
  directSong?: {
    seedTitle: string
    artistQuery?: string
  }
  entityResolution?: MusicEntityResolution
  failure?: MusicSearchFailure
}

export interface ChatRecommendationProgressPatch {
  phase?: string
  current?: number
  total?: number
  message?: string
}

function buildRecentDialogHint(): string {
  const recent = loadTodayConversations(4)
  if (recent.length === 0) return ''
  return recent.map((item) => `${item.role}: ${item.content.slice(0, 80)}`).join('\n')
}

function searchModeForChatIntent(chatIntent: ChatIntent, directSceneRequest: boolean): MusicSearchMode {
  if (directSceneRequest) return 'scene'
  if (chatIntent.kind === 'direct_song' || chatIntent.kind === 'clarification_needed') return 'direct-song'
  if (chatIntent.kind === 'similar_to_track') return 'similar-to-track'
  if (chatIntent.kind === 'feedback_current_track' && chatIntent.feedbackAction === 'more_like_this') return 'similar-to-track'
  return 'generic'
}

export async function fetchRecommendationCandidates(
  text: string,
  active: ChatActiveTask,
  onProgress?: (patch: ChatRecommendationProgressPatch) => void,
  chatIntent: ChatIntent = classifyFallbackChatIntent(text),
  context: { similarityReference?: Track } = {},
): Promise<ChatRecommendationCandidatesResult> {
  if (active.canceled) return { candidates: [], authRequired: false, canceled: true }
  const currentScene = getCurrentScene()
  const directSceneRequest = Boolean(currentScene && currentScene.prompt.trim() === text.trim())
  const directSongRequest = chatIntent.kind === 'direct_song'
    || chatIntent.kind === 'clarification_needed'
    || Boolean(chatIntent.seedTitle)
  const directSong = (chatIntent.kind === 'direct_song' || chatIntent.kind === 'clarification_needed') && chatIntent.seedTitle
    ? { seedTitle: chatIntent.seedTitle, artistQuery: chatIntent.artistQuery }
    : undefined
  const canFetchMusic = directSceneRequest || chatIntent.wantsMusic || directSongRequest
  if (!canFetchMusic) return { candidates: [], authRequired: false, directSong }

  onProgress?.({ phase: 'recommendation-intent', message: '理解音乐请求' })
  const searchMode = searchModeForChatIntent(chatIntent, directSceneRequest)
  const llmIntent = chatIntent.llmIntentOverride ?? await inferMusicSearchIntent({
    query: text,
    mode: searchMode,
    recentDialog: buildRecentDialogHint(),
    signal: active.signal,
  })
  if (active.canceled) return { candidates: [], authRequired: false, canceled: true }

  const wantsMusic = directSceneRequest || directSongRequest || chatIntent.wantsMusic || Boolean(llmIntent?.wantsMusic)
  if (!wantsMusic) return { candidates: [], authRequired: false }

  try {
    let entityResolution: MusicEntityResolution | undefined
    let failure: MusicSearchFailure | undefined
    const candidates = await searchMusic({
      query: text,
      mode: searchMode,
      intentOverride: llmIntent,
      authoritativeIntentEntities: Boolean(chatIntent.llmIntentOverride),
      authoritativeIntentSemantics: Boolean(chatIntent.llmIntentOverride),
      similarityReference: context.similarityReference,
      signal: active.signal,
      onEntitiesResolved: (resolution) => {
        entityResolution = resolution
      },
      onSearchFailure: (nextFailure) => {
        failure = nextFailure
      },
      onProgress: (patch) => onProgress?.({
        ...patch,
        phase: patch.phase ? `recommendation-${patch.phase}` : 'recommendation',
      }),
    })
    if (active.canceled) return { candidates: [], authRequired: false, canceled: true }
    return { candidates, authRequired: false, directSong, entityResolution, failure }
  } catch (error) {
    if (active.canceled) return { candidates: [], authRequired: false, canceled: true }
    if (isMusicSearchAuthError(error)) {
      return { candidates: [], authRequired: true, directSong, failure: { reason: 'auth_required' } }
    }
    return { candidates: [], authRequired: false, directSong, failure: { reason: 'search_failed' } }
  }
}
