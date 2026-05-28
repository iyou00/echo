import type { WebContents } from 'electron'
import type { RuntimeTaskSnapshot, SendChatResult, Track } from '../../../types/ipc'
import { appendConversation } from '../../db/conversations'
import { getSettings } from '../../db/settings'
import { getState as getPlaybackState } from '../playback'
import { getCurrentScene } from '../scene'
import { applyMemorySignal } from '../memoryPolicy'
import { getWeather } from '../../weather/client'
import {
  capturePendingQuestionAnswer,
  type PendingQuestionReplyCapture,
} from '../tasteQuestionScheduler'
import { checkJailbreak, pickJailbreakResponse } from '../safety/jailbreak-filter'
import { classifyChatIntent, refineChatIntentWithLlm, type ChatIntent } from './intent'
import type { ChatActiveTask } from './recommendationCandidates'
import {
  resolvePendingDirectSongChoiceReply,
  resolvePendingDirectSongReply,
  resolvePendingMusicEntityReply,
} from './pendingIntents'
import { appendAssistantReply } from './reply'
import {
  sanitizeAssistantOutput,
  streamPendingAnswerReply,
} from './responseStream'
import { handleCurrentTrackFeedback, trackLabel } from './trackFeedback'
import {
  rememberChatMusicSession,
  resolveSessionMusicFollowUp,
  type SessionMusicFollowUp,
} from './sessionContext'
import { prepareCandidateStage } from './candidateStage'
import { runRecommendationResponseStage } from './responseStage'
import type { PendingIntentState, ReplyFn } from './sendPipelineTypes'

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

async function handleStaticReply(input: {
  trimmed: string
  settings: ReturnType<typeof getSettings>
  signal: AbortSignal
  reply: ReplyFn
}): Promise<SendChatResult | null> {
  const jailbreak = checkJailbreak(input.trimmed)
  if (jailbreak.isJailbreak) return input.reply(pickJailbreakResponse(input.trimmed))
  if (isIdentityQuestion(input.trimmed)) return input.reply(identityReply())
  if (isWeatherQuestion(input.trimmed)) return input.reply(await buildWeatherReply(input.settings, input.signal))
  return null
}

function resolvePendingIntentState(trimmed: string): PendingIntentState {
  const pendingDirectSongReply = resolvePendingDirectSongReply(trimmed)
  const pendingMusicEntityReply = pendingDirectSongReply?.query ? null : resolvePendingMusicEntityReply(trimmed)
  const pendingDirectSongChoiceReply = pendingDirectSongReply?.query || pendingMusicEntityReply?.query ? null : resolvePendingDirectSongChoiceReply(trimmed)
  return {
    pendingDirectSongReply,
    pendingMusicEntityReply,
    pendingDirectSongChoiceReply,
    effectiveText: pendingDirectSongReply?.query ?? pendingMusicEntityReply?.query ?? trimmed,
  }
}

function handlePendingIntentReply(state: PendingIntentState, reply: ReplyFn): SendChatResult | null {
  if (state.pendingDirectSongReply?.response) return reply(state.pendingDirectSongReply.response)
  if (state.pendingMusicEntityReply?.response) return reply(state.pendingMusicEntityReply.response)
  if (state.pendingDirectSongChoiceReply?.response) return reply(state.pendingDirectSongChoiceReply.response)
  if (state.pendingDirectSongChoiceReply?.track) {
    const tracks = attachSceneToTracks([state.pendingDirectSongChoiceReply.track])
    return reply(`好，就放${trackLabel(tracks[0])}。`, tracks, { persistTracks: true })
  }
  return null
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
  const reply: ReplyFn = (content, tracks = [], options = {}) => appendAssistantReply({
    content,
    tracks,
    sender,
    runtimeEmit,
    ...options,
  })

  runtimeReport?.({ phase: 'input', current: 1, total: 5, message: '记录用户消息' })
  appendConversation('user', trimmed)

  try {
    const playbackState = getPlaybackState()
    const currentPlaybackTrack = playbackState.current
    const settings = getSettings()
    if (isWeatherQuestion(trimmed)) {
      runtimeReport?.({ phase: 'weather', current: 2, total: 5, message: '查询设置城市天气' })
    }
    const staticReply = await handleStaticReply({ trimmed, settings, signal, reply })
    if (staticReply) return staticReply

    const pendingState = resolvePendingIntentState(trimmed)
    const pendingIntentReply = handlePendingIntentReply(pendingState, reply)
    if (pendingIntentReply) return pendingIntentReply

    const { pendingDirectSongReply, pendingMusicEntityReply, effectiveText } = pendingState
    const initialChatIntent = await refineChatIntentWithLlm(
      classifyChatIntent(effectiveText, { currentTrack: currentPlaybackTrack }),
      { currentTrack: currentPlaybackTrack },
      signal,
    )
    if (initialChatIntent.kind === 'out_of_scope') {
      return reply(outOfScopeContent(initialChatIntent))
    }

    runtimeReport?.({ phase: 'taste', current: 2, total: 5, message: '更新口味信号' })
    inferTasteSignal(trimmed).catch((error) => {
      console.warn('[chat] taste signal inference failed', error)
    })
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
      if (sender && !sender.isDestroyed()) sender.send('chat:stream:chunk', chunk)
      runtimeEmit?.('runtime:chat-stream-chunk', { chunk })
    }
    if (pendingReply.action === 'answer_only') {
      const started = Date.now()
      let content = await streamPendingAnswerReply(trimmed, pendingReply, active, settings, emitChunk)
      content = sanitizeAssistantOutput(content)
      return reply(content.trim(), [], { durationMs: Date.now() - started })
    }

    const candidateStage = await prepareCandidateStage({
      trimmed,
      effectiveText,
      initialChatIntent,
      pendingReply,
      pendingDirectSongReply,
      pendingMusicEntityReply,
      sessionFollowUp,
      currentPlaybackTrack,
      active,
      signal,
      reply,
      attachSceneToTracks,
      runtimeReport,
    })
    if (candidateStage.reply) return candidateStage.reply
    if (!candidateStage.ready) return reply('我知道你是想听歌，但这次没拿到可播放的结果。')
    return runRecommendationResponseStage({
      trimmed,
      settings,
      active,
      signal,
      pendingReply,
      candidate: candidateStage.ready,
      currentPlaybackTrack,
      emitChunk,
      reply,
      attachSceneToTracks,
      runtimeReport,
    })
  } catch (error) {
    if (signal.aborted) throw new DOMException('任务已取消', 'AbortError')
    const message = error instanceof Error ? error.message : '处理消息时出了问题'
    return reply(`抱歉，刚才处理出了点状况：${message}`)
  }
}
