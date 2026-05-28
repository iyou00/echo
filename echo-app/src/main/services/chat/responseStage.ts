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
import { selectTracksForChatResponse } from './trackSelection'
import { trackLabel } from './trackFeedback'

function mentionedTrackCount(content: string, tracks: Track[]): number {
  const normalized = content.toLowerCase().replace(/\s+/g, '')
  return tracks.filter((track) => {
    const title = track.title.toLowerCase().replace(/\s+/g, '')
    const artist = track.artist.toLowerCase().replace(/\s+/g, '')
    return Boolean(title && normalized.includes(title)) || Boolean(artist && normalized.includes(artist) && title && normalized.includes(`《${title}》`))
  }).length
}

function boundMusicActionContent(content: string, tracks: Track[]): string {
  const first = tracks[0]
  if (!first) return content
  const requiredMentionCount = Math.min(tracks.length, 3)
  if (mentionedTrackCount(content, tracks) >= requiredMentionCount) return content
  if (tracks.length > 1) {
    const names = tracks.slice(0, 3).map((track) => trackLabel(track)).join('、')
    return `行，我先挑这几首：${names}。先从第一首开始。`
  }
  const reason = first.reason || first.echoNote
  return `行，先放${trackLabel(first)}。${reason ? ` ${reason}` : '先听开头。'}`
}

export interface RecommendationResponseStageInput {
  trimmed: string
  settings: Settings
  active: ChatActiveTask
  signal: AbortSignal
  pendingReply: PendingQuestionReplyCapture
  candidate: CandidateStageReady
  currentPlaybackTrack: Track | null | undefined
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
    emitChunk,
    reply,
    attachSceneToTracks,
    runtimeReport,
  } = input
  const {
    recommendationIntent,
    requested,
    targetCount,
    countExplicit,
    guardedCandidates,
    authRequired,
    excludeCurrentTrack,
    entityConstraint,
  } = candidate

  const tracks: Track[] = []
  const started = Date.now()
  let content = ''
  let followUpQuestion: TasteQuestion | null = null

  try {
    runtimeReport?.({ phase: 'stream', current: 4, total: 5, message: '生成聊天回复' })
    generateDynamicTasteQuestions(trimmed, guardedCandidates)
    followUpQuestion = pendingReply.action !== 'none' ? null : pickTasteFollowUpQuestion(trimmed, guardedCandidates)
    content = sanitizeAssistantOutput(await streamChatReply({
      userText: trimmed,
      settings,
      active,
      candidates: guardedCandidates,
      authRequired,
      followUpQuestion,
      emitChunk,
    }))

    tracks.push(...await selectTracksForChatResponse({
      content,
      candidates: guardedCandidates,
      targetCount,
      explicit: countExplicit,
      authRequired,
      entityConstraint,
      signal,
    }))
    if (excludeCurrentTrack) {
      const selected = excludeCurrentPlaybackTrack(tracks, currentPlaybackTrack)
      tracks.splice(0, tracks.length, ...selected)
    }
    if (hasMusicActionIntent(recommendationIntent) && tracks.length === 0 && guardedCandidates.length > 0) {
      tracks.push(...guardedCandidates.slice(0, targetCount))
    }
    if (hasMusicActionIntent(recommendationIntent) && tracks.length > 0) {
      content = boundMusicActionContent(content, tracks)
    }

    if (!content.trim()) {
      content = tracks.length > 0 ? '我先给你挑这首。' : '(没说话——我先想想,你接着说)'
    }
    if (requested.overLimit && tracks.length > 0 && !content.includes(OVER_LIMIT_RECOMMENDATION_LINE)) {
      content = `${OVER_LIMIT_RECOMMENDATION_LINE}${content ? ` ${content}` : ''}`
    }
  } catch (error) {
    if (signal.aborted) throw error
    followUpQuestion = null
    recordChatStreamError(error)
    if (guardedCandidates.length > 0) {
      tracks.push(...guardedCandidates.slice(0, targetCount))
      content = fallbackRecommendationContent(tracks, OVER_LIMIT_RECOMMENDATION_LINE, requested.overLimit)
    } else {
      content = friendlyError(error)
    }
    emitChunk(content)
  }

  const finalTracks = attachSceneToTracks(tracks)
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
  } else if (hasMusicActionIntent(recommendationIntent)) {
    clearChatMusicSession()
  } else {
    armChatMusicSessionAffirmation(inferSessionAffirmationAction(content))
  }

  runtimeReport?.({ phase: 'persist', current: 5, total: 5, message: '保存聊天结果' })
  const result = reply(content.trim(), finalTracks, {
    durationMs: Date.now() - started,
    hints: authRequired ? { neteaseAuthRequired: true } : undefined,
    persistTracks: true,
  })
  recordFollowUpQuestionAsked(followUpQuestion, result.message.id)
  return result
}
