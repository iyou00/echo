import type { WebContents } from 'electron'
import type { ChatHints, RuntimeTaskSnapshot, SendChatResult, TasteQuestion, Track } from '../../../types/ipc'
import { appendConversation } from '../../db/conversations'
import { getSettings } from '../../db/settings'
import { similarTrackSearchQuery } from '../../skills/music/query'
import { excludeTracks } from '../../skills/music/selection'
import { OVER_LIMIT_RECOMMENDATION_LINE, parseRequestedTrackCount } from '../recommendation'
import { getState as getPlaybackState } from '../playback'
import { getCurrentScene } from '../scene'
import { applyMemorySignal } from '../memoryPolicy'
import { getWeather } from '../../weather/client'
import {
  capturePendingQuestionAnswer,
  generateDynamicTasteQuestions,
  type PendingQuestionReplyCapture,
  pickTasteFollowUpQuestion,
  recordFollowUpQuestionAsked,
} from '../tasteQuestionScheduler'
import { checkJailbreak, pickJailbreakResponse } from '../safety/jailbreak-filter'
import { classifyChatIntent, refineChatIntentWithLlm, type ChatIntent } from './intent'
import { fetchRecommendationCandidates, type ChatActiveTask } from './recommendationCandidates'
import type { MusicSearchFailure } from '../../skills/music/search'
import {
  clearPendingDirectSongState,
  directSongChoiceContent,
  directSongClarificationContent,
  musicEntityClarificationContent,
  resolvePendingDirectSongChoiceReply,
  resolvePendingDirectSongReply,
  resolvePendingMusicEntityReply,
  setPendingDirectSongChoice,
  setPendingDirectSongClarification,
  setPendingMusicEntityClarification,
} from './pendingIntents'
import { appendAssistantReply } from './reply'
import {
  fallbackRecommendationContent,
  friendlyError,
  recordChatStreamError,
  sanitizeAssistantOutput,
  streamChatReply,
  streamPendingAnswerReply,
} from './responseStream'
import { handleCurrentTrackFeedback, trackLabel } from './trackFeedback'
import { selectTracksForChatResponse } from './trackSelection'
import {
  armChatMusicSessionAffirmation,
  clearChatMusicSession,
  inferSessionAffirmationAction,
  rememberChatMusicSession,
  resolveSessionMusicFollowUp,
  type SessionMusicFollowUp,
} from './sessionContext'
import type { MusicEntityResolution } from '../../skills/music/entityResolver'
import { currentMusicCorrectionConstraintForQuery } from '../../skills/music/correctionMemory'
import { constraintFromResolution, filterTracksByMusicEntity, mergeMusicEntityConstraints } from '../../skills/music/verifier'

type ActiveChat = ChatActiveTask

function isWeatherQuestion(text: string): boolean {
  return /天气|气温|温度|下雨|降雨|冷不冷|热不热|冷吗|热吗|几度|多少度/i.test(text)
    && !/天气.*歌|雨天.*歌|下雨.*听|冷.*歌|热.*歌/i.test(text)
}

function isIdentityQuestion(text: string): boolean {
  return /^(?:echo[，, ]*)?(你是谁|你是什么|介绍一下你自己|你叫什么|echo是谁|echo是什么|你是echo吗|你是干嘛的|你能做什么|你会做什么|这个软件是干嘛的)[？?。!！\s]*$/i.test(text.trim())
}

function identityReply(): string {
  return '我是 Echo，你电脑里的 AI 音乐伴侣。可以陪你聊当下的状态，帮你找歌、推荐歌，也会慢慢记住你喜欢什么声音。'
}

async function buildWeatherReply(settings: ReturnType<typeof getSettings>, signal: AbortSignal): Promise<string> {
  const city = settings.user.city.trim()
  if (!city) return '我还没有你的天气城市。去设置里填一下城市，我之后就能按那个地方看天气。'
  const weather = await getWeather(city, { signal, timeoutMs: 6000 })
  if (!weather) return `我刚才没拿到${city}的实时天气。设置里的城市已经有了，可能是天气服务这会儿没回。`
  const temperatureNote = Number.isFinite(weather.tempC)
    ? weather.tempC <= 5
      ? '外面偏冷，出门多加一层。'
      : weather.tempC >= 30
        ? '温度有点高，出门记得带水。'
        : '这个温度还算好走。'
    : ''
  const humidityNote = Number.isFinite(weather.humidity) && weather.humidity >= 75 ? '湿度也偏高，体感可能会更闷一点。' : ''
  return [`${city}现在${weather.summary}。`, temperatureNote, humidityNote].filter(Boolean).join('')
}

function outOfScopeContent(intent: ChatIntent): string {
  switch (intent.outOfScopeTopic) {
    case 'politics':
      return '这个话题太硬，容易把我们带离音乐和当下感受。你可以把此刻的情绪直接说给我，我按那个状态陪你聊。'
    case 'code':
      return '代码问题我先收住。这里更适合聊你此刻的状态、想听的歌，或者让 Echo 给你找一首贴近现在的音乐。'
    case 'translation':
      return '翻译类问题我先收住。你可以直接说想听中文、英文、粤语、日语，或者说一个情绪，我按音乐方向接。'
    case 'math':
    case 'academic':
    case 'business':
      return '这个问题偏分析任务。你可以把现在的心情、场景、想听的歌手或歌名发给我，我按音乐陪伴的方式回应。'
    default:
      return '这个话题有点偏离 Echo 的音乐陪伴范围。你可以直接说现在的感受，或者说想听什么歌。'
  }
}

function attachSceneToTracks(tracks: Track[]): Track[] {
  const scene = getCurrentScene()
  if (!scene || tracks.length === 0) return tracks
  return tracks.map((track) => ({
    ...track,
    sceneKey: scene.key,
    sceneLabel: scene.label,
    sceneLine: scene.line,
    sceneSessionId: scene.id,
    reason: track.reason ?? scene.line,
    echoNote: track.echoNote ?? track.reason ?? scene.line,
  }))
}

function shouldExcludeCurrentPlaybackTrack(
  intent: ChatIntent,
  pendingReply: PendingQuestionReplyCapture,
  currentTrack: Track | null | undefined,
): boolean {
  if (!currentTrack) return false
  if (pendingReply.action === 'extend_recommendation') return true
  return intent.kind === 'feedback_current_track' && intent.feedbackAction === 'more_like_this'
}

function excludeCurrentPlaybackTrack(tracks: Track[], currentTrack: Track | null | undefined): Track[] {
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

function hasMusicActionIntent(intent: ChatIntent): boolean {
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

async function inferTasteSignal(text: string): Promise<void> {
  const patterns: Array<{ regex: RegExp; kind: string }> = [
    { regex: /(?:喜欢|爱听|最近迷上|新发现)([^,，。.!！?？]{1,24})/, kind: 'like_artist' },
    { regex: /(?:不喜欢|不爱听|腻了|少来点)([^,，。.!！?？]{1,24})/, kind: 'unlike_artist' },
    { regex: /(?:这种感觉|这个味道|这类歌)(?:再多|多来|可以多)(?:一点|点)?/, kind: 'reinforce_vibe' },
    { regex: /(?:结束了|过去了|搞定了)([^,，。.!！?？]{0,24})/, kind: 'event_ended' },
  ]

  for (const pattern of patterns) {
    const match = text.match(pattern.regex)
    if (!match) continue
    const target = (match[1] || '当前偏好').trim()
    await applyMemorySignal(pattern.kind, { target, strength: 0.1, note: text.slice(0, 120) }, { source: 'chat' })
    return
  }
}

export async function runChatSendPipeline(
  text: string,
  sender: WebContents | undefined,
  signal: AbortSignal,
  runtimeEmit?: (channel: string, payload: unknown) => void,
  runtimeReport?: (patch: Partial<RuntimeTaskSnapshot>) => void,
): Promise<SendChatResult> {
  const trimmed = text.trim()
  if (!trimmed) throw new Error('消息不能为空')
  if (trimmed.length > 2000) throw new Error('这么长我得分两口气听,你要不分两次发?')
  const reply = (content: string, tracks: Track[] = [], options: { durationMs?: number; hints?: ChatHints; persistTracks?: boolean } = {}) => appendAssistantReply({
    content,
    tracks,
    sender,
    runtimeEmit,
    ...options,
  })

  runtimeReport?.({ phase: 'input', current: 1, total: 5, message: '记录用户消息' })
  appendConversation('user', trimmed)

  const jailbreak = checkJailbreak(trimmed)
  if (jailbreak.isJailbreak) {
    return reply(pickJailbreakResponse())
  }

  const playbackState = getPlaybackState()
  const currentPlaybackTrack = playbackState.current
  const settings = getSettings()
  if (isIdentityQuestion(trimmed)) {
    return reply(identityReply())
  }
  if (isWeatherQuestion(trimmed)) {
    runtimeReport?.({ phase: 'weather', current: 2, total: 5, message: '查询设置城市天气' })
    return reply(await buildWeatherReply(settings, signal))
  }

  const pendingDirectSongReply = resolvePendingDirectSongReply(trimmed)
  if (pendingDirectSongReply?.response) {
    return reply(pendingDirectSongReply.response)
  }
  const pendingMusicEntityReply = pendingDirectSongReply?.query ? null : resolvePendingMusicEntityReply(trimmed)
  if (pendingMusicEntityReply?.response) {
    return reply(pendingMusicEntityReply.response)
  }
  const pendingDirectSongChoiceReply = pendingDirectSongReply?.query || pendingMusicEntityReply?.query ? null : resolvePendingDirectSongChoiceReply(trimmed)
  if (pendingDirectSongChoiceReply?.response) {
    return reply(pendingDirectSongChoiceReply.response)
  }
  if (pendingDirectSongChoiceReply?.track) {
    const tracks = attachSceneToTracks([pendingDirectSongChoiceReply.track])
    return reply(`好，就放${trackLabel(tracks[0])}。`, tracks, { persistTracks: true })
  }

  const effectiveText = pendingDirectSongReply?.query ?? pendingMusicEntityReply?.query ?? trimmed
  const initialChatIntent = await refineChatIntentWithLlm(
    classifyChatIntent(effectiveText, { currentTrack: currentPlaybackTrack }),
    { currentTrack: currentPlaybackTrack },
    signal,
  )
  if (initialChatIntent.kind === 'out_of_scope') {
    return reply(outOfScopeContent(initialChatIntent))
  }

  runtimeReport?.({ phase: 'taste', current: 2, total: 5, message: '更新口味信号' })
  await inferTasteSignal(trimmed)
  const pendingReply: PendingQuestionReplyCapture = pendingDirectSongReply?.query
    ? { action: 'none' }
    : await capturePendingQuestionAnswer(trimmed, signal)

  const sessionFollowUp: SessionMusicFollowUp = pendingReply.action === 'none' && !pendingDirectSongReply?.query && !pendingMusicEntityReply?.query
    ? resolveSessionMusicFollowUp(trimmed)
    : { kind: 'none' }
  if (sessionFollowUp.kind === 'play_track') {
    const tracks = attachSceneToTracks([sessionFollowUp.track])
    rememberChatMusicSession({
      sourceText: trimmed,
      intentKind: 'session_play',
      tracks,
      artistQuery: sessionFollowUp.track.artist,
      seedTitle: sessionFollowUp.track.title,
    })
    return reply(sessionFollowUp.content, tracks, { persistTracks: true })
  }

  if (pendingReply.action === 'none' && initialChatIntent.kind === 'feedback_current_track' && currentPlaybackTrack) {
    const feedbackResult = await handleCurrentTrackFeedback(initialChatIntent, currentPlaybackTrack, trimmed, signal)
    if (feedbackResult.handled) {
      return reply(feedbackResult.content, feedbackResult.tracks)
    }
  }

  const active: ActiveChat = {
    signal,
    get canceled() {
      return signal.aborted
    },
  }
  const emitChunk = (chunk: string) => {
    sender?.send('chat:stream:chunk', chunk)
    runtimeEmit?.('runtime:chat-stream-chunk', { chunk })
  }
  if (pendingReply.action === 'answer_only') {
    const started = Date.now()
    let content = await streamPendingAnswerReply(trimmed, pendingReply, active, settings, emitChunk)
    content = sanitizeAssistantOutput(content)
    return reply(content.trim(), [], { durationMs: Date.now() - started })
  }

  const recommendationQuery = sessionFollowUp.kind === 'search'
    ? sessionFollowUp.query
    : pendingDirectSongReply?.query ?? pendingMusicEntityReply?.query
    ?? (initialChatIntent.kind === 'feedback_current_track' && initialChatIntent.feedbackAction === 'more_like_this' && currentPlaybackTrack
      ? similarTrackSearchQuery(currentPlaybackTrack, trimmed)
      : pendingReply.action === 'extend_recommendation' && pendingReply.recommendationText
        ? pendingReply.recommendationText
        : trimmed)
  const recommendationIntent = recommendationQuery === effectiveText
    ? initialChatIntent
    : await refineChatIntentWithLlm(
      classifyChatIntent(recommendationQuery, { currentTrack: currentPlaybackTrack }),
      { currentTrack: currentPlaybackTrack },
      signal,
  )
  const requested = parseRequestedTrackCount(trimmed)
  const targetCount = Math.max(1, Math.min(5, Math.floor(recommendationIntent.targetCount || requested.targetCount)))
  const countExplicit = requested.explicit || targetCount > requested.targetCount
  runtimeReport?.({ phase: 'recommendation', current: 3, total: 5, message: '准备推荐候选' })
  const { candidates, authRequired, canceled: candidatesCanceled, directSong, entityResolution, failure } = await fetchRecommendationCandidates(recommendationQuery, active, (patch) => {
    runtimeReport?.({
      ...patch,
      phase: patch.phase ?? 'recommendation',
      current: 3,
      total: 5,
    })
  }, recommendationIntent)
  if (candidatesCanceled || active.canceled) {
    return reply('行,我先停在这里。')
  }
  if (candidates.length === 0 && shouldExplainSearchFailure(failure)) {
    const patch = failureEntityPatch(failure, entityResolution)
    setPendingMusicEntityClarification(patch, trimmed)
    return reply(musicEntityClarificationContent({
      ...patch,
      verificationStatus: entityResolution?.verificationStatus,
    }))
  }
  if (shouldAskMusicEntityClarification(entityResolution, candidates, authRequired)) {
    const patch = failureEntityPatch(failure, entityResolution)
    setPendingMusicEntityClarification(patch, trimmed)
    return reply(musicEntityClarificationContent({
      ...patch,
      verificationStatus: entityResolution?.verificationStatus,
    }))
  }
  if (directSong && candidates.length === 0 && !authRequired) {
    setPendingDirectSongClarification(directSong, trimmed)
    return reply(directSongClarificationContent(directSong))
  }
  if (directSong && candidates.length > 1 && !authRequired) {
    setPendingDirectSongChoice(directSong, candidates, trimmed)
    return reply(directSongChoiceContent(candidates))
  }
  const excludeCurrentTrack = shouldExcludeCurrentPlaybackTrack(initialChatIntent, pendingReply, currentPlaybackTrack)
  const sessionExcludedCandidates = sessionFollowUp.kind === 'search'
    ? excludeTracks(candidates, sessionFollowUp.excludeTracks)
    : candidates
  const sessionUsableCandidates = sessionFollowUp.kind === 'search' && candidates.length > 0 && sessionExcludedCandidates.length === 0
    ? candidates
    : sessionExcludedCandidates
  const usableCandidates = excludeCurrentTrack
    ? excludeCurrentPlaybackTrack(sessionUsableCandidates, currentPlaybackTrack)
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
    setPendingMusicEntityClarification(patch, trimmed)
    return reply(musicEntityClarificationContent({
      ...patch,
      verificationStatus: entityResolution?.verificationStatus,
    }))
  }
  if (hasMusicActionIntent(recommendationIntent) && guardedCandidates.length === 0) {
    return reply(noMusicCandidateContent(recommendationIntent, authRequired, failure), [], {
      hints: authRequired ? { neteaseAuthRequired: true } : undefined,
    })
  }

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
