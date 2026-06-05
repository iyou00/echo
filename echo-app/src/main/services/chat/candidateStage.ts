import type { ChatHints, RuntimeTaskSnapshot, SendChatResult, Track } from '../../../types/ipc'
import { similarTrackSearchQuery } from '../../skills/music/query'
import { excludeTracks } from '../../skills/music/selection'
import type { MusicSearchFailure } from '../../skills/music/search'
import { currentMusicCorrectionConstraintForQuery } from '../../skills/music/correctionMemory'
import type { MusicEntityResolution } from '../../skills/music/entityResolver'
import { constraintFromResolution, filterTracksByMusicEntity, mergeMusicEntityConstraints, type MusicEntityConstraint } from '../../skills/music/verifier'
import { parseRequestedTrackCount } from '../recommendation'
import type { PendingQuestionReplyCapture } from '../tasteQuestionScheduler'
import { classifyChatIntent, refineChatIntentWithLlm, type ChatIntent } from './intent'
import { fetchRecommendationCandidates, type ChatActiveTask } from './recommendationCandidates'
import {
  directSongChoiceContent,
  directSongClarificationContent,
  musicEntityClarificationContent,
  setPendingDirectSongChoice,
  setPendingDirectSongClarification,
  setPendingMusicEntityClarification,
} from './pendingIntents'
import type { PendingIntentState, ReplyFn } from './sendPipelineTypes'
import type { SessionMusicFollowUp } from './sessionContext'

function shouldExcludeCurrentPlaybackTrack(
  intent: ChatIntent,
  pendingReply: PendingQuestionReplyCapture,
  currentTrack: Track | null | undefined,
): boolean {
  if (!currentTrack) return false
  if (pendingReply.action === 'extend_recommendation') return true
  return intent.kind === 'feedback_current_track' && intent.feedbackAction === 'more_like_this'
}

export function excludeCurrentPlaybackTrack(tracks: Track[], currentTrack: Track | null | undefined): Track[] {
  return currentTrack ? excludeTracks(tracks, [currentTrack]) : tracks
}

function shouldAskMusicEntityClarification(entity: MusicEntityResolution | undefined, candidates: Track[], authRequired: boolean): boolean {
  if (!entity || authRequired || candidates.length > 0) return false
  if (entity.ambiguity === 'artist_or_title' || entity.ambiguity === 'missing_artist') return true
  if (entity.verificationStatus === 'unverified' && (entity.artistQuery || entity.seedTitle)) return true
  return false
}

function shouldExplainSearchFailure(failure: MusicSearchFailure | undefined): boolean {
  if (!failure) return false
  return failure.reason !== 'auth_required' && failure.reason !== 'search_failed'
}

function failureEntityPatch(failure: MusicSearchFailure | undefined, entity: MusicEntityResolution | undefined): {
  artistQuery?: string
  seedTitle?: string
  ambiguity: MusicEntityResolution['ambiguity']
  failureReason?: MusicSearchFailure['reason']
} {
  return {
    artistQuery: failure?.artistQuery ?? entity?.artistQuery,
    seedTitle: failure?.seedTitle ?? entity?.seedTitle,
    ambiguity: entity?.ambiguity ?? 'too_vague',
    failureReason: failure?.reason,
  }
}

export function hasMusicActionIntent(intent: ChatIntent): boolean {
  return intent.wantsMusic && (
    intent.kind === 'direct_song'
    || intent.kind === 'artist_request'
    || intent.kind === 'mood_request'
    || intent.kind === 'scene_request'
    || intent.kind === 'similar_to_track'
  )
}

function noMusicCandidateContent(intent: ChatIntent, authRequired: boolean, failure?: MusicSearchFailure): string {
  if (authRequired) return '现在还没接上网易云。去设置里扫码登录后，我就能继续给你挑歌。'
  if (failure?.reason === 'search_failed') return '这次音乐服务没拿到可播放结果。你换个歌手、语种或感觉，我再试一次。'
  if (intent.artistQuery) return `我知道你想听${intent.artistQuery}，但这次没拿到可播放的结果。你换个关键词，我再找。`
  if (intent.seedTitle) return `我知道你想听《${intent.seedTitle}》，但这次没拿到可播放的结果。你把歌手或版本补一下，我再找。`
  return '我知道你是想听歌，但这次没拿到可播放的结果。你换个歌手、语种或感觉再说一句，我再找。'
}

export interface CandidateStageInput {
  trimmed: string
  effectiveText: string
  initialChatIntent: ChatIntent
  pendingReply: PendingQuestionReplyCapture
  pendingDirectSongReply: PendingIntentState['pendingDirectSongReply']
  pendingMusicEntityReply: PendingIntentState['pendingMusicEntityReply']
  sessionFollowUp: SessionMusicFollowUp
  currentPlaybackTrack: Track | null | undefined
  active: ChatActiveTask
  signal: AbortSignal
  reply: ReplyFn
  attachSceneToTracks: (tracks: Track[]) => Track[]
  runtimeReport?: (patch: Partial<RuntimeTaskSnapshot>) => void
}

export interface CandidateStageReady {
  recommendationIntent: ChatIntent
  requested: ReturnType<typeof parseRequestedTrackCount>
  targetCount: number
  countExplicit: boolean
  guardedCandidates: Track[]
  authRequired: boolean
  excludeCurrentTrack: boolean
  entityConstraint?: MusicEntityConstraint
}

export async function prepareCandidateStage(input: CandidateStageInput): Promise<{ reply?: SendChatResult; ready?: CandidateStageReady }> {
  const recommendationQuery = input.sessionFollowUp.kind === 'search'
    ? input.sessionFollowUp.query
    : input.pendingDirectSongReply?.query ?? input.pendingMusicEntityReply?.query
    ?? (input.initialChatIntent.kind === 'feedback_current_track' && input.initialChatIntent.feedbackAction === 'more_like_this' && input.currentPlaybackTrack
      ? similarTrackSearchQuery(input.currentPlaybackTrack, input.trimmed)
      : input.pendingReply.action === 'extend_recommendation' && input.pendingReply.recommendationText
        ? input.pendingReply.recommendationText
        : input.trimmed)
  const recommendationIntent = recommendationQuery === input.effectiveText
    ? input.initialChatIntent
    : await refineChatIntentWithLlm(
      classifyChatIntent(recommendationQuery, { currentTrack: input.currentPlaybackTrack }),
      { currentTrack: input.currentPlaybackTrack },
      input.signal,
  )
  const requested = parseRequestedTrackCount(input.trimmed)
  const targetCount = Math.max(1, Math.min(5, Math.floor(recommendationIntent.targetCount || requested.targetCount)))
  const countExplicit = requested.explicit || targetCount > requested.targetCount
  if (
    !hasMusicActionIntent(recommendationIntent)
    && input.pendingReply.action === 'none'
    && !input.pendingDirectSongReply?.query
    && !input.pendingMusicEntityReply?.query
    && input.sessionFollowUp.kind === 'none'
  ) {
    return {
      ready: {
        recommendationIntent,
        requested,
        targetCount,
        countExplicit,
        guardedCandidates: [],
        authRequired: false,
        excludeCurrentTrack: false,
        entityConstraint: undefined,
      },
    }
  }
  input.runtimeReport?.({ phase: 'recommendation', current: 3, total: 5, message: '准备推荐候选' })
  const { candidates, authRequired, canceled: candidatesCanceled, directSong, entityResolution, failure } = await fetchRecommendationCandidates(recommendationQuery, input.active, (patch) => {
    input.runtimeReport?.({
      ...patch,
      phase: patch.phase ?? 'recommendation',
      current: 3,
      total: 5,
    })
  }, recommendationIntent)
  if (candidatesCanceled || input.active.canceled) {
    return { reply: input.reply('行,我先停在这里。') }
  }
  if (candidates.length === 0 && shouldExplainSearchFailure(failure)) {
    const patch = failureEntityPatch(failure, entityResolution)
    setPendingMusicEntityClarification(patch, input.trimmed)
    return {
      reply: input.reply(musicEntityClarificationContent({
        ...patch,
        verificationStatus: entityResolution?.verificationStatus,
      })),
    }
  }
  if (shouldAskMusicEntityClarification(entityResolution, candidates, authRequired)) {
    const patch = failureEntityPatch(failure, entityResolution)
    setPendingMusicEntityClarification(patch, input.trimmed)
    return {
      reply: input.reply(musicEntityClarificationContent({
        ...patch,
        verificationStatus: entityResolution?.verificationStatus,
      })),
    }
  }
  if (directSong && candidates.length === 0 && !authRequired) {
    setPendingDirectSongClarification(directSong, input.trimmed)
    return { reply: input.reply(directSongClarificationContent(directSong)) }
  }
  if (directSong && candidates.length > 1 && !authRequired) {
    setPendingDirectSongChoice(directSong, candidates, input.trimmed)
    return { reply: input.reply(directSongChoiceContent(candidates)) }
  }

  const excludeCurrentTrack = shouldExcludeCurrentPlaybackTrack(input.initialChatIntent, input.pendingReply, input.currentPlaybackTrack)
  const sessionExcludedCandidates = input.sessionFollowUp.kind === 'search'
    ? excludeTracks(candidates, input.sessionFollowUp.excludeTracks)
    : candidates
  const sessionUsableCandidates = input.sessionFollowUp.kind === 'search' && candidates.length > 0 && sessionExcludedCandidates.length === 0
    ? candidates
    : sessionExcludedCandidates
  const usableCandidates = excludeCurrentTrack
    ? excludeCurrentPlaybackTrack(sessionUsableCandidates, input.currentPlaybackTrack)
    : sessionUsableCandidates
  const entityConstraint = mergeMusicEntityConstraints(constraintFromResolution(entityResolution), currentMusicCorrectionConstraintForQuery(recommendationQuery))
  const guardedCandidates = filterTracksByMusicEntity(usableCandidates, entityConstraint, {
    strictArtist: Boolean(entityConstraint?.artistQuery || entityConstraint?.verifiedArtistName),
  })
  if (entityConstraint && usableCandidates.length > 0 && guardedCandidates.length === 0 && !authRequired) {
    const patch = {
      artistQuery: entityResolution?.artistQuery,
      seedTitle: entityResolution?.seedTitle,
      ambiguity: entityResolution?.ambiguity ?? 'too_vague',
      failureReason: 'candidate_mismatch' as const,
    }
    setPendingMusicEntityClarification(patch, input.trimmed)
    return {
      reply: input.reply(musicEntityClarificationContent({
        ...patch,
        verificationStatus: entityResolution?.verificationStatus,
      })),
    }
  }
  if (hasMusicActionIntent(recommendationIntent) && guardedCandidates.length === 0) {
    return {
      reply: input.reply(noMusicCandidateContent(recommendationIntent, authRequired, failure), [], {
        hints: authRequired ? { neteaseAuthRequired: true } satisfies ChatHints : undefined,
      }),
    }
  }

  return {
    ready: {
      recommendationIntent,
      requested,
      targetCount,
      countExplicit,
      guardedCandidates,
      authRequired,
      excludeCurrentTrack,
      entityConstraint,
    },
  }
}
