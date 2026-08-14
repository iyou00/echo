import type { RuntimeTaskSnapshot, SendChatResult, Settings, TasteQuestion, Track } from '../../../types/ipc'
import { OVER_LIMIT_RECOMMENDATION_LINE } from '../recommendation'
import {
  generateDynamicTasteQuestions,
  type PendingQuestionReplyCapture,
  pickTasteFollowUpQuestion,
  recordFollowUpQuestionAsked,
} from '../tasteQuestionScheduler'
import type { ChatActiveTask } from './recommendationCandidates'
import {
  fallbackRecommendationContent,
  friendlyError,
  recordChatStreamError,
  sanitizeAssistantOutput,
  streamChatReply,
} from './responseStream'
import type { CandidateStageReady } from './candidateStage'
import { excludeCurrentPlaybackTrack, hasMusicActionIntent } from './candidateStage'
import {
  armChatMusicSessionAffirmation,
  clearChatMusicSession,
  inferSessionAffirmationAction,
  rememberChatMusicSession,
} from './sessionContext'
import type { ReplyFn } from './sendPipelineTypes'
import { clearPendingDirectSongState } from './pendingIntents'
import { enforceAssistantTrackBinding } from './pipelineContract'
import { applyCompanionResponseStyle, type CompanionResponseBrief } from './companionResponse'
import type { CompanionProfile, CompanionResponseStrategy } from './companionTypes'
import type { RecommendationWeatherContext } from './weatherRecommendation'
import { createUiBoundary } from '../../../shared/uiBoundary'

export const responseStageTestHelpers = {
  enforceTrackClaimContract: enforceAssistantTrackBinding,
}

function hasPlayableUrl(track: Track): boolean {
  return typeof track.playUrl === 'string' && track.playUrl.trim().length > 0
}

function expectsMusicAction(intent: CandidateStageReady['recommendationIntent'], candidates: Track[]): boolean {
  return hasMusicActionIntent(intent) || candidates.length > 0
}

function emptyModelReply(
  userText: string,
  tracks: Track[],
  companionResponseBrief: CompanionResponseBrief | null = null,
  responseStrategy?: CompanionResponseStrategy,
): string {
  if (tracks.length === 0) {
    return applyCompanionResponseStyle('我刚才走神了一下。你接着说，我在听。', userText, companionResponseBrief, responseStrategy)
  }

  const picked = tracks.length === 1 ? '我给你挑了这首' : `我给你挑了${tracks.length}首`
  let content = `${picked}，先听一会儿。`
  if (/被骂|挨骂|受气|委屈/.test(userText)) {
    content = `挨骂这一下确实挺堵心的。先缓口气，${picked}偏轻快的，听着把这股闷气散一散。`
  } else if (/心情不好|难过|低落|烦躁|压抑|想哭|emo/i.test(userText)) {
    content = `心情不好的时候，先别逼自己一直绷着。${picked}，听一会儿，看看能不能让脑子松一点。`
  }
  return applyCompanionResponseStyle(content, userText, companionResponseBrief, responseStrategy)
}

export interface RecommendationResponseStageInput {
  trimmed: string
  settings: Settings
  active: ChatActiveTask
  signal: AbortSignal
  pendingReply: PendingQuestionReplyCapture
  candidate: CandidateStageReady
  currentPlaybackTrack: Track | null | undefined
  companionResponseBrief?: CompanionResponseBrief | null
  responseStrategy?: CompanionResponseStrategy
  companionProfile?: CompanionProfile
  weatherContext?: RecommendationWeatherContext
  emitChunk(chunk: string): void
  reply: ReplyFn
  attachSceneToTracks(tracks: Track[]): Track[]
  runtimeReport?: (patch: Partial<RuntimeTaskSnapshot>) => void
}

export async function runRecommendationResponseStage(input: RecommendationResponseStageInput): Promise<SendChatResult> {
  const {
    trimmed,
    settings,
    active,
    signal,
    pendingReply,
    candidate,
    currentPlaybackTrack,
    companionResponseBrief = null,
    responseStrategy,
    companionProfile,
    weatherContext,
    emitChunk,
    reply,
    attachSceneToTracks,
    runtimeReport,
  } = input
  const {
    recommendationIntent,
    requested,
    targetCount,
    guardedCandidates,
    authRequired,
    excludeCurrentTrack,
  } = candidate

  const tracks: Track[] = []
  const effectiveCandidates = excludeCurrentTrack
    ? excludeCurrentPlaybackTrack(guardedCandidates, currentPlaybackTrack)
    : guardedCandidates
  const playableCandidates = effectiveCandidates.filter(hasPlayableUrl)
  const musicActionExpected = expectsMusicAction(recommendationIntent, playableCandidates)
  const selectedCandidates = musicActionExpected ? playableCandidates.slice(0, targetCount) : []
  tracks.push(...selectedCandidates)
  const started = Date.now()
  let content = ''
  let followUpQuestion: TasteQuestion | null = null

  try {
    runtimeReport?.({ phase: 'stream', current: 4, total: 5, message: '生成聊天回复' })
    generateDynamicTasteQuestions(trimmed, selectedCandidates)
    followUpQuestion = pendingReply.action !== 'none' ? null : pickTasteFollowUpQuestion(trimmed, selectedCandidates)
    content = sanitizeAssistantOutput(await streamChatReply({
      userText: trimmed,
      settings,
      active,
      candidates: selectedCandidates,
      authRequired,
      followUpQuestion,
      companionResponseBrief,
      responseStrategy,
      companionProfile,
      weatherContext,
      emitChunk,
    }))

    if (!content.trim()) {
      content = emptyModelReply(trimmed, tracks, companionResponseBrief, responseStrategy)
    }
    if (requested.overLimit && tracks.length > 0 && !content.includes(OVER_LIMIT_RECOMMENDATION_LINE)) {
      content = `${OVER_LIMIT_RECOMMENDATION_LINE}${content ? ` ${content}` : ''}`
    }
  } catch (error) {
    if (signal.aborted) throw error
    followUpQuestion = null
    recordChatStreamError(error)
    if (tracks.length > 0) {
      content = applyCompanionResponseStyle(
        fallbackRecommendationContent(tracks, OVER_LIMIT_RECOMMENDATION_LINE, requested.overLimit),
        trimmed,
        companionResponseBrief,
        responseStrategy,
      )
    } else {
      content = applyCompanionResponseStyle(friendlyError(error), trimmed, companionResponseBrief, responseStrategy)
    }
    emitChunk(content)
  }

  const finalTracks = attachSceneToTracks(tracks)
  content = enforceAssistantTrackBinding(content, finalTracks, musicActionExpected)
  if (finalTracks.length > 0) {
    clearPendingDirectSongState()
    rememberChatMusicSession({
      sourceText: trimmed,
      intentKind: recommendationIntent.kind,
      tracks: finalTracks,
      artistQuery: recommendationIntent.artistQuery,
      seedTitle: recommendationIntent.seedTitle,
      affirmationAction: inferSessionAffirmationAction(content),
    })
  } else if (musicActionExpected) {
    clearChatMusicSession()
  } else {
    armChatMusicSessionAffirmation(inferSessionAffirmationAction(content))
  }

  runtimeReport?.({ phase: 'persist', current: 5, total: 5, message: '保存聊天结果' })
  const result = reply(content.trim(), finalTracks, {
    durationMs: Date.now() - started,
    hints: authRequired ? { neteaseAuthRequired: true } : undefined,
    persistTracks: true,
    expectsMusicAction: musicActionExpected,
    responseStrategy,
    boundary: musicActionExpected && finalTracks.length === 0 ? createUiBoundary('no_playable') : undefined,
  })
  recordFollowUpQuestionAsked(followUpQuestion, result.message.id)
  return result
}
