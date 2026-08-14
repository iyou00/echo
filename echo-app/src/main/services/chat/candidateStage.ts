import type { ChatHints, RuntimeTaskSnapshot, SendChatResult, Track } from '../../../types/ipc'
import { similarTrackSearchQuery } from '../../skills/music/query'
import { excludeTracks } from '../../skills/music/selection'
import type { MusicSearchFailure } from '../../skills/music/search'
import { currentMusicCorrectionConstraintForQuery } from '../../skills/music/correctionMemory'
import type { MusicEntityResolution } from '../../skills/music/entityResolver'
import { constraintFromResolution, filterTracksByMusicEntity, mergeMusicEntityConstraints, type MusicEntityConstraint } from '../../skills/music/verifier'
import { MAX_RECOMMENDATION_COUNT, parseRequestedTrackCount } from '../recommendation'
import { mergeIntent } from '../recommendation/intent'
import type { PendingQuestionReplyCapture } from '../tasteQuestionScheduler'
import { classifyFallbackChatIntent, type ChatIntent } from './intent'
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
import type { RecommendationWeatherContext } from './weatherRecommendation'
import { createUiBoundary } from '../../../shared/uiBoundary'

function shouldExcludeCurrentPlaybackTrack(
  intent: ChatIntent,
  pendingReply: PendingQuestionReplyCapture,
  currentTrack: Track | null | undefined,
): boolean {
  if (!currentTrack) return false
  if (pendingReply.action === 'extend_recommendation') return true
  return intent.kind === 'feedback_current_track'
    && (
      intent.feedbackAction === 'more_like_this'
      || intent.feedbackAction === 'not_right'
      || intent.feedbackAction === 'skip'
    )
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

function compactQueryText(value: string): string {
  return value.toLowerCase().replace(/[\s《》“”"'‘’.,，。!！?？:：\-_/]/g, '')
}

function queryMentionsEntity(query: string, entity: string | undefined): boolean {
  if (!entity) return false
  const normalizedQuery = compactQueryText(query)
  const normalizedEntity = compactQueryText(entity)
  return Boolean(normalizedEntity && normalizedQuery.includes(normalizedEntity))
}

export function effectiveMusicSearchQuery(query: string, intent: ChatIntent): string {
  if (!hasMusicActionIntent(intent)) return query
  const mentionsArtist = queryMentionsEntity(query, intent.artistQuery)
  const mentionsTitle = queryMentionsEntity(query, intent.seedTitle)
  if (intent.artistQuery && intent.seedTitle && (!mentionsArtist || !mentionsTitle)) {
    return `我要听${intent.artistQuery}的《${intent.seedTitle}》`
  }
  if (intent.artistQuery && !mentionsArtist) {
    const count = Math.max(1, Math.min(MAX_RECOMMENDATION_COUNT, Math.floor(intent.targetCount || 1)))
    const ranking = intent.recommendationIntent.ranking === 'latest'
      ? '最新'
      : intent.recommendationIntent.ranking === 'popular'
        ? '热门'
        : ''
    return count > 1 ? `推荐${count}首${intent.artistQuery}的${ranking}歌` : `推荐一首${intent.artistQuery}的${ranking}歌`
  }
  if (intent.seedTitle && !mentionsTitle) {
    return `我要听《${intent.seedTitle}》`
  }
  return query
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
  if (!intent.wantsMusic) return false
  if (intent.kind === 'weather' || intent.kind === 'identity' || intent.kind === 'out_of_scope') return false
  if (intent.kind === 'feedback_current_track') {
    return intent.feedbackAction === 'more_like_this'
      || intent.feedbackAction === 'not_right'
      || intent.feedbackAction === 'skip'
  }
  return true
}

function weatherSearchPrefix(context?: RecommendationWeatherContext): string {
  if (!context?.requested) return ''
  if (context.available && context.city && context.summary) return `${context.city}现在${context.summary}。`
  if (context.unavailableReason === 'city_missing') return '天气城市还没设置。'
  return '天气服务这次没回。'
}

function noMusicCandidateContent(
  intent: ChatIntent,
  authRequired: boolean,
  failure?: MusicSearchFailure,
  weatherContext?: RecommendationWeatherContext,
): string {
  const prefix = weatherSearchPrefix(weatherContext)
  if (authRequired) return '现在还没接上网易云。去设置里登录网易云后，我就能继续给你挑歌。'
  if (failure?.reason === 'search_failed') return `${prefix}这次音乐服务没拿到可播放结果。你换个感觉，我再试一次。`
  if (intent.artistQuery) return `我知道你想听${intent.artistQuery}，但这次没拿到可播放的结果。你换个关键词，我再找。`
  if (intent.seedTitle) return `我知道你想听《${intent.seedTitle}》，但这次没拿到可播放的结果。你把歌手或版本补一下，我再找。`
  if (intent.recommendationIntent.language) {
    return `${prefix}我按${intent.recommendationIntent.language}找了一轮，这次没拿到可播放的结果。你换个感觉，我再找。`
  }
  return `${prefix}我知道你是想听歌，但这次没拿到可播放的结果。你换个歌手、语种或感觉再说一句，我再找。`
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
  weatherContext?: RecommendationWeatherContext
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

function classifyDerivedRecommendationIntent(
  query: string,
  input: CandidateStageInput,
): ChatIntent {
  const base = classifyFallbackChatIntent(query, { currentTrack: input.currentPlaybackTrack })
  const override = input.initialChatIntent.llmIntentOverride
  if (!override) return base
  const semanticOverride = { ...override }
  delete semanticOverride.artistQuery
  delete semanticOverride.seedTitle
  delete semanticOverride.clearArtistQuery
  delete semanticOverride.clearSeedTitle
  const recommendationIntent = mergeIntent(base.recommendationIntent, semanticOverride)
  return {
    ...base,
    recommendationIntent,
    llmIntentOverride: semanticOverride,
    seedTitle: recommendationIntent.seedTitle,
    artistQuery: recommendationIntent.artistQuery,
    targetCount: recommendationIntent.targetCount,
    moodTerms: Array.from(new Set([
      ...base.moodTerms,
      ...recommendationIntent.moods,
      ...recommendationIntent.scenes,
    ])).slice(0, 8),
  }
}

export async function prepareCandidateStage(input: CandidateStageInput): Promise<{ reply?: SendChatResult; ready?: CandidateStageReady }> {
  const rawRecommendationQuery = input.sessionFollowUp.kind === 'search'
    ? input.sessionFollowUp.query
    : input.pendingDirectSongReply?.query ?? input.pendingMusicEntityReply?.query
    ?? (input.initialChatIntent.kind === 'feedback_current_track' && input.initialChatIntent.feedbackAction === 'more_like_this' && input.currentPlaybackTrack
      ? similarTrackSearchQuery(input.currentPlaybackTrack, input.trimmed)
      : input.pendingReply.action === 'extend_recommendation' && input.pendingReply.recommendationText
        ? input.pendingReply.recommendationText
        : input.trimmed)
  const recommendationQuery = effectiveMusicSearchQuery(rawRecommendationQuery, input.initialChatIntent)
  const recommendationIntent = recommendationQuery === input.effectiveText
    ? input.initialChatIntent
    : classifyDerivedRecommendationIntent(recommendationQuery, input)
  const requested = parseRequestedTrackCount(input.trimmed)
  const targetCount = Math.max(1, Math.min(MAX_RECOMMENDATION_COUNT, Math.floor(recommendationIntent.targetCount || requested.targetCount)))
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
  }, recommendationIntent, {
    similarityReference: recommendationIntent.kind === 'similar_to_track'
      && !recommendationIntent.seedTitle
      && !recommendationIntent.artistQuery
      ? input.currentPlaybackTrack ?? undefined
      : undefined,
  })
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
  const entityConstraint = mergeMusicEntityConstraints(
    recommendationIntent.kind === 'similar_to_track' ? undefined : constraintFromResolution(entityResolution),
    currentMusicCorrectionConstraintForQuery(recommendationQuery),
  )
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
      reply: input.reply(noMusicCandidateContent(recommendationIntent, authRequired, failure, input.weatherContext), [], {
        hints: authRequired ? { neteaseAuthRequired: true } satisfies ChatHints : undefined,
        boundary: createUiBoundary('no_playable'),
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
