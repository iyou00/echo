import { FormEvent, useEffect, useRef, useState } from 'react'
import { Send, Square } from 'lucide-react'
import type { ActiveScene, ChatMessage, EchoApi, PlaybackState, SceneDefinition, SceneKey, ScenePlaybackResult, TasteProfile, Track, UiBoundarySnapshot } from '../../types/ipc'
import type { AppPageProps } from '../appState'
import { EmptyState, SceneRail, TrackCard } from '../components'
import { latestRunningRuntimeTask, useRuntimeTasks } from '../hooks/useRuntimeTasks'
import { trackIdentity as trackKey } from '../../shared/trackIdentity'
import { friendlyOperationError } from '../../shared/runtimeRecovery'
import { pickWaitingLineFor } from './chatWaitingLines'
import { mergeReturnedTracksIntoMessage } from './chatMessageTracks'
import { BoundaryState } from '../components/BoundaryState'
import { deriveChatStageMode, type ChatStageMode } from '../stageMode'

interface ChatPageProps extends AppPageProps {
  echo: EchoApi
  queue: Track[]
  playbackState: PlaybackState
  setPlaybackState: (state: PlaybackState) => void
  hasLlmConfig: boolean
  profile: TasteProfile | null
  refreshQueue: () => Promise<Track[]>
  restoreOnStart: boolean
  scenes: SceneDefinition[]
  currentScene: ActiveScene | null
  playScene: (key: SceneKey) => Promise<ScenePlaybackResult>
  endScene: () => Promise<void>
  autoPlayNext: boolean
  updateAutoPlayNext: (value: boolean) => Promise<void>
  focusApiSettings?: () => void
  boundaries: UiBoundarySnapshot[]
  onStageModeChange?: (mode: ChatStageMode) => void
}

// 让 Echo 看起来像在"打字思考":
// - DELAY: 接到 result 后先压住至少 2 秒, 让"思考期"明确
// - TICK 间隔动态算: 短回复放慢看清, 长回复不卡死, 总打字时长目标 ≥ MIN_TOTAL_MS
// - REPLY_CHARS_PER_TICK 固定 1, 一字一字露出, 才像真人在敲
const REPLY_DELAY_MS = 2000
const REPLY_MIN_TICK_MS = 90
const REPLY_MAX_TICK_MS = 600
const REPLY_MIN_TOTAL_MS = 4500
const REPLY_CHARS_PER_TICK = 1
const WAITING_TICK_MS = 55
const AUTO_SCROLL_BOTTOM_THRESHOLD = 96

function computeTickInterval(totalChars: number): number {
  if (totalChars <= 0) return REPLY_MIN_TICK_MS
  const ideal = Math.floor(REPLY_MIN_TOTAL_MS / totalChars)
  return Math.max(REPLY_MIN_TICK_MS, Math.min(REPLY_MAX_TICK_MS, ideal))
}

function isNearConversationBottom(element: HTMLElement): boolean {
  return element.scrollHeight - element.scrollTop - element.clientHeight <= AUTO_SCROLL_BOTTOM_THRESHOLD
}

function timeLabel(value: string) {
  return new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

function friendlyChatError() {
  return '这次连接没有完成。你的输入和正在播放的歌都还在，可以再试一次。'
}

export function ChatPage({ echo, navigate, playbackState, setPlaybackState, hasLlmConfig, profile, refreshQueue, restoreOnStart, scenes, currentScene, playScene, endScene, autoPlayNext, updateAutoPlayNext, boundaries, onStageModeChange }: ChatPageProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [loadingScene, setLoadingScene] = useState<SceneKey | null>(null)
  const [favoriteKeys, setFavoriteKeys] = useState<Set<string>>(new Set())
  const [feedbackMap, setFeedbackMap] = useState<Record<string, 'more_like_this' | 'not_right'>>({})
  const [waitingLines, setWaitingLines] = useState<Record<number, string>>({})
  const [pendingDisplayIds, setPendingDisplayIds] = useState<Set<number>>(new Set())
  const [chatNotice, setChatNotice] = useState('')
  // 仅会话内有效：标记需要展示"去登录网易云"CTA 的助手消息 id（不持久化）。
  const [authHintIds, setAuthHintIds] = useState<Set<number>>(new Set())
  const [messageBoundaries, setMessageBoundaries] = useState<Record<number, { snapshot: UiBoundarySnapshot; retryText: string }>>({})
  const activeAssistantId = useRef<number | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
  const autoScrollPaused = useRef(false)
  const chatNoticeTimerRef = useRef<number | null>(null)
  const chunkBuffers = useRef<Record<number, string>>({})
  const finalMessages = useRef<Record<number, ChatMessage>>({})
  const delayTimers = useRef<Record<number, number>>({})
  const typeTimers = useRef<Record<number, number>>({})
  const waitingAppearTimers = useRef<Record<number, number>>({})
  const waitingTypeTimers = useRef<Record<number, number>>({})
  const waitingBuffers = useRef<Record<number, string>>({})
  const initialRestoreOnStart = useRef(restoreOnStart)
  // 已取消的助手消息 id 集合 —— sendMessage 拿到 result 后会用它判断"用户点过取消, 这个 result 不要再展示"。
  const cancelTokens = useRef<Set<number>>(new Set())
  const activeTrackKey = trackKey(playbackState.current)
  const runtimeTasks = useRuntimeTasks(echo)
  const sceneTask = latestRunningRuntimeTask(runtimeTasks, ['scene-playback'], { includeChildren: false })
  const chatTask = latestRunningRuntimeTask(runtimeTasks, ['chat-send'], { includeChildren: false })
  const sceneTaskRunning = Boolean(sceneTask)
  const runtimeSceneSource = sceneTask?.sourceName
  const runtimeSceneKey = sceneTaskRunning && scenes.some((scene) => scene.key === runtimeSceneSource)
    ? runtimeSceneSource as SceneKey
    : null
  const sceneLoadingKey = loadingScene ?? runtimeSceneKey
  const inputBusy = sending || sceneTaskRunning

  function actionErrorMessage(error: unknown, fallback: string): string {
    return friendlyOperationError(error, fallback)
  }

  function showChatNotice(message: string) {
    setChatNotice(message)
    if (chatNoticeTimerRef.current !== null) window.clearTimeout(chatNoticeTimerRef.current)
    chatNoticeTimerRef.current = window.setTimeout(() => {
      setChatNotice('')
      chatNoticeTimerRef.current = null
    }, 4200)
  }

  function cleanupAssistant(id: number) {
    if (waitingAppearTimers.current[id]) {
      window.clearTimeout(waitingAppearTimers.current[id])
      delete waitingAppearTimers.current[id]
    }
    if (waitingTypeTimers.current[id]) {
      window.clearInterval(waitingTypeTimers.current[id])
      delete waitingTypeTimers.current[id]
    }
    if (delayTimers.current[id]) {
      window.clearTimeout(delayTimers.current[id])
      delete delayTimers.current[id]
    }
    if (typeTimers.current[id]) {
      window.clearInterval(typeTimers.current[id])
      delete typeTimers.current[id]
    }
    delete waitingBuffers.current[id]
    delete chunkBuffers.current[id]
    delete finalMessages.current[id]
  }

  useEffect(() => {
    if (initialRestoreOnStart.current) {
      echo.chat.loadRecent(30).then(setMessages).catch(() => setMessages([]))
    } else {
      setMessages([])
    }
    echo.favorites.listKeys().then((keys) => setFavoriteKeys(new Set(keys))).catch(() => setFavoriteKeys(new Set()))
  }, [echo])

  useEffect(() => {
    return echo.favorites.onChanged((payload) => {
      setFavoriteKeys((current) => {
        const next = new Set(current)
        const key = trackKey(payload.track)
        if (!key) return next
        if (payload.favorited) next.add(key)
        else next.delete(key)
        return next
      })
    })
  }, [echo])

  // 不再监听 chat:stream:chunk 累积 buffer。
  // 之前依赖 onChunk 启动打字, 但 LLM 流式返回过快时 buffer 在 2s 延迟期间就被填满了,
  // 用户体感上 "刚发完, 一会儿就刷出整段内容", 没有真人打字感。
  // 现在统一: 等 send() 拿到完整 result -> 灌满 buffer -> 2s 延迟 -> 慢慢打字。
  // waiting line 自然保留到 result 返回为止 (含 LLM 思考时间), 体感稳定。

  useEffect(() => {
    const delayStore = delayTimers.current
    const typeStore = typeTimers.current
    const waitingAppearStore = waitingAppearTimers.current
    const waitingTypeStore = waitingTypeTimers.current
    return () => {
      const allIds = new Set([...Object.keys(delayStore), ...Object.keys(typeStore), ...Object.keys(waitingAppearStore), ...Object.keys(waitingTypeStore)])
      allIds.forEach((key) => {
        const id = Number(key)
        if (delayStore[id]) window.clearTimeout(delayStore[id])
        if (typeStore[id]) window.clearInterval(typeStore[id])
        if (waitingAppearStore[id]) window.clearTimeout(waitingAppearStore[id])
        if (waitingTypeStore[id]) window.clearInterval(waitingTypeStore[id])
      })
      if (chatNoticeTimerRef.current !== null) window.clearTimeout(chatNoticeTimerRef.current)
    }
  }, [])

  useEffect(() => {
    return echo.chat.onMessageInjected((message) => {
      setMessages((items) => items.some((item) => item.id === message.id) ? items : [...items, message])
    })
  }, [echo])

  // Ctrl+K 快捷条产生的一问一答，直接落到对话历史（不经过打字机）。
  useEffect(() => {
    function handleQuickAskExchange(event: Event) {
      const detail = (event as CustomEvent<{ user: ChatMessage; assistant: ChatMessage }>).detail
      if (!detail?.user || !detail?.assistant) return
      setMessages((items) => {
        if (items.some((item) => item.id === detail.user.id || item.id === detail.assistant.id)) return items
        return [...items, detail.user, detail.assistant]
      })
    }
    window.addEventListener('echo:quick-ask-exchange', handleQuickAskExchange)
    return () => window.removeEventListener('echo:quick-ask-exchange', handleQuickAskExchange)
  }, [])

  useEffect(() => {
    return echo.settings.onChanged((payload) => {
      if (payload.path === '*' && payload.value === null) setMessages([])
    })
  }, [echo])

  useEffect(() => {
    const element = scrollRef.current
    if (!element || autoScrollPaused.current) return
    element.scrollTop = element.scrollHeight
  }, [messages])

  function handleConversationScroll() {
    const element = scrollRef.current
    if (!element) return
    autoScrollPaused.current = !isNearConversationBottom(element)
  }

  async function sendMessage(event: FormEvent) {
    event.preventDefault()
    await submitText(draft)
  }

  async function submitText(rawText: string) {
    const text = rawText.trim()
    if (!text || inputBusy || !hasLlmConfig) return

    const userMessage: ChatMessage = {
      id: -Date.now(),
      role: 'user',
      content: text,
      createdAt: new Date().toISOString(),
    }
    const assistantMessage: ChatMessage = {
      id: userMessage.id - 1,
      role: 'assistant',
      content: '',
      createdAt: new Date().toISOString(),
      tracks: [],
    }

    activeAssistantId.current = assistantMessage.id
    autoScrollPaused.current = false
    cancelTokens.current.delete(assistantMessage.id)
    setDraft('')
    setSending(true)
    setMessages((items) => [...items, userMessage, assistantMessage])
    scheduleWaitingLine(assistantMessage.id, pickWaitingLineFor(text))

    try {
      const result = await echo.chat.send(text)
      // 用户在 LLM 解析 / 召回阶段就点了取消 —— result 已经无效，不再写到 UI 上。
      if (cancelTokens.current.has(assistantMessage.id)) {
        cancelTokens.current.delete(assistantMessage.id)
        return
      }
      const returnedTracks = result.message.tracks?.length ? result.message.tracks : result.tracks
      const finalMessage = mergeReturnedTracksIntoMessage(result.message, returnedTracks)
      finalMessages.current[assistantMessage.id] = finalMessage
      // 不再依赖 onChunk 累积, send return 时直接用完整 content 灌满。
      chunkBuffers.current[assistantMessage.id] = finalMessage.content
      if (returnedTracks.length > 0) {
        setMessages((items) => items.map((item) => (
          item.id === assistantMessage.id ? { ...item, tracks: returnedTracks } : item
        )))
      }
      if (result.hints?.neteaseAuthRequired) {
        // 把按钮挂在最终落地的 message id 上（持久化到 DB 的真实 id），打字结束后会替换占位 message。
        const finalId = result.message.id
        setAuthHintIds((items) => {
          const next = new Set(items)
          next.add(finalId)
          return next
        })
      }
      if (result.boundary) {
        setMessageBoundaries((items) => ({
          ...items,
          [result.message.id]: { snapshot: result.boundary as UiBoundarySnapshot, retryText: text },
        }))
      }
      scheduleReplyStart(assistantMessage.id)
      const nextTrack = returnedTracks.find((track) => track.playUrl) ?? null
      if (nextTrack) {
        // 立刻起歌，不等打字动画——歌先到，字跟上（原来的顺序造成了
        // 3-6 秒「曲线回平静但歌还没播」的空档）。
        if (result.hints?.playbackAlreadyApplied) {
          const nextState = await echo.playback.getState()
          setPlaybackState(nextState)
        } else {
          const [nextState] = await Promise.all([
            echo.playback.play(nextTrack),
            primePlaybackQueue(returnedTracks, nextTrack),
          ])
          setPlaybackState(nextState)
        }
      }
      await refreshQueue()
    } catch (error) {
      if (cancelTokens.current.has(assistantMessage.id)) {
        cancelTokens.current.delete(assistantMessage.id)
        return
      }
      settleAssistantMessage(assistantMessage.id, { ...assistantMessage, content: friendlyChatError() })
    } finally {
      if (activeAssistantId.current === assistantMessage.id) {
        activeAssistantId.current = null
      }
      setSending(false)
    }
  }

  function scheduleReplyStart(id: number) {
    if (typeTimers.current[id] || delayTimers.current[id]) return
    delayTimers.current[id] = window.setTimeout(() => {
      delete delayTimers.current[id]
      startTypingReply(id)
    }, REPLY_DELAY_MS)
  }

  function settleAssistantMessage(id: number, message: ChatMessage) {
    cleanupAssistant(id)
    setMessages((items) => items.map((item) => (item.id === id ? message : item)))
    setPendingDisplayIds((items) => {
      const next = new Set(items)
      next.delete(id)
      return next
    })
    setWaitingLines((items) => {
      if (!(id in items)) return items
      const next = { ...items }
      delete next[id]
      return next
    })
  }

  function scheduleWaitingLine(id: number, line: string) {
    waitingBuffers.current[id] = line
    if (finalMessages.current[id] || cancelTokens.current.has(id)) return
    setWaitingLines((items) => ({ ...items, [id]: '' }))
    setPendingDisplayIds((items) => new Set(items).add(id))
    startWaitingTyping(id)
  }

  function startWaitingTyping(id: number) {
    if (waitingTypeTimers.current[id]) return
    waitingTypeTimers.current[id] = window.setInterval(() => {
      const buffer = waitingBuffers.current[id] ?? ''
      if (buffer.length === 0) {
        window.clearInterval(waitingTypeTimers.current[id])
        delete waitingTypeTimers.current[id]
        return
      }
      const next = buffer.slice(0, 1)
      waitingBuffers.current[id] = buffer.slice(1)
      setWaitingLines((items) => ({ ...items, [id]: `${items[id] ?? ''}${next}` }))
    }, WAITING_TICK_MS)
  }

  function startTypingReply(id: number) {
    if (typeTimers.current[id]) return
    // 启动时按当前 buffer / final 算总字符数，让"短文案放慢、长文案不卡"。
    const final = finalMessages.current[id]
    const totalChars = Math.max(
      (chunkBuffers.current[id] ?? '').length,
      final?.content?.length ?? 0,
    )
    const tickInterval = computeTickInterval(totalChars)

    typeTimers.current[id] = window.setInterval(() => {
      const buffer = chunkBuffers.current[id] ?? ''
      if (buffer.length > 0) {
        const next = buffer.slice(0, REPLY_CHARS_PER_TICK)
        chunkBuffers.current[id] = buffer.slice(REPLY_CHARS_PER_TICK)
        setMessages((items) => items.map((item) => (item.id === id ? { ...item, content: item.content + next } : item)))
        return
      }

      const fallback = finalMessages.current[id]
      if (!fallback) return
      window.clearInterval(typeTimers.current[id])
      delete typeTimers.current[id]
      delete chunkBuffers.current[id]
      delete finalMessages.current[id]
      setMessages((items) => items.map((item) => (item.id === id ? fallback : item)))
      setWaitingLines((items) => {
        if (!(id in items)) return items
        const next = { ...items }
        delete next[id]
        return next
      })
      setPendingDisplayIds((items) => {
        const next = new Set(items)
        next.delete(id)
        return next
      })
    }, tickInterval)
  }

  function cancelMessage() {
    const id = activeAssistantId.current
    // 主进程那边告诉它停下，但不 await —— 后端可能还卡在 cloudsearch / song_url 上，
    // 我们让 UI 立刻反馈，后端结果到达时由 cancelTokens 把它丢弃。
    echo.chat.cancel().catch((error) => {
      console.warn('[chat] cancel failed', error)
    })
    if (!id) {
      setSending(false)
      return
    }

    cancelTokens.current.add(id)
    cleanupAssistant(id)
    setMessages((items) => items.map((item) =>
      item.id === id ? { ...item, content: '行,我先停在这里。', tracks: [] } : item,
    ))
    setPendingDisplayIds((items) => {
      const next = new Set(items)
      next.delete(id)
      return next
    })
    setWaitingLines((items) => {
      if (!(id in items)) return items
      const next = { ...items }
      delete next[id]
      return next
    })
    setAuthHintIds((items) => {
      if (!items.has(id)) return items
      const next = new Set(items)
      next.delete(id)
      return next
    })
    activeAssistantId.current = null
    setSending(false)
  }

  async function primePlaybackQueue(tracks: Track[], currentTrack: Track) {
    const current = trackKey(currentTrack)
    const currentIndex = tracks.findIndex((track) => trackKey(track) === current)
    const ordered = currentIndex >= 0
      ? [...tracks.slice(currentIndex + 1), ...tracks.slice(0, currentIndex)]
      : tracks
    let latestState: PlaybackState | null = null
    const queued = new Set<string>()
    for (const track of ordered) {
      const key = trackKey(track)
      if (!track.playUrl || !key || key === current || queued.has(key)) continue
      queued.add(key)
      try {
        latestState = await echo.playback.enqueue(track)
      } catch {
        // 单首续期失败不影响后面的自动连播候选。
      }
    }
    if (latestState) setPlaybackState(latestState)
  }

  async function handleTrackAction(track: Track, contextTracks: Track[] = []) {
    if (!track.playUrl) return
    const isCurrent = trackKey(track) === activeTrackKey
    const nextState = isCurrent && playbackState.status === 'playing'
      ? await echo.playback.pause()
      : isCurrent && playbackState.status === 'paused'
        ? await echo.playback.resume()
        : await echo.playback.play(track)
    setPlaybackState(nextState)
    if (!isCurrent) await primePlaybackQueue(contextTracks, track)
    await refreshQueue()
  }

  async function toggleFavorite(track: Track) {
    const result = await echo.favorites.toggle(track)
    setFavoriteKeys(new Set(result.favorites.map(trackKey)))
  }

  async function enterScene(key: SceneKey) {
    if (!hasLlmConfig) return
    // toggle：点击已激活的场景 = 退出
    if (currentScene?.key === key) {
      setLoadingScene(null)
      try {
        await endScene()
      } catch (error) {
        console.warn('[chat] scene end failed', error)
        showChatNotice(actionErrorMessage(error, '场景退出失败，可以再试一次。'))
      }
      return
    }
    if (inputBusy) return
    if (!autoPlayNext) {
      try {
        await updateAutoPlayNext(true)
      } catch (error) {
        console.warn('[chat] auto play setting failed', error)
        showChatNotice(actionErrorMessage(error, '自动连播开启失败，本次场景仍会继续播放。'))
      }
    }
    setLoadingScene(key)
    setDraft('')
    try {
      const result = await playScene(key)
      if (result.tracks.length === 0 && !result.message) return
      const sceneMessage = result.message
      if (sceneMessage) {
        setMessages((items) => items.some((item) => item.id === sceneMessage.id) ? items : [...items, sceneMessage])
      }
      setPlaybackState(result.state)
      await refreshQueue()
    } catch (error) {
      console.warn('[chat] scene play failed', error)
      showChatNotice(actionErrorMessage(error, '场景启动失败，可以再试一次。'))
    } finally {
      setLoadingScene(null)
    }
  }

  async function recordTrackFeedback(track: Track, action: 'more_like_this' | 'not_right') {
    const key = trackKey(track)
    setFeedbackMap((items) => ({ ...items, [key]: action }))
    try {
      const result = await echo.feedback.record(track, action, 'chat_recommendation_card')
      if (result.ok && result.message) showChatNotice(result.message)
    } catch (error) {
      console.warn('[chat] feedback record failed', error)
      showChatNotice(actionErrorMessage(error, '反馈保存失败，可以稍后再试。'))
      setFeedbackMap((items) => {
        const next = { ...items }
        delete next[key]
        return next
      })
    }
  }

  function renderEmptyChat() {
    if (!hasLlmConfig) {
      const boundary = boundaries.find((item) => item.code === 'model_missing' || item.code === 'model_invalid')
      // model_missing 的标题与 presence 标题逐字相同，bare 只留正文+按钮作续接；其余标题互补，保留完整卡片。
      if (boundary) return <BoundaryState snapshot={boundary} bare={boundary.code === 'model_missing'} onAction={() => navigate('settings')} />
      return (
        <EmptyState
          muted
          icon="…"
          title={"嗨。在我们说话之前,\n你得先告诉我从哪儿连过来。"}
          body="DeepSeek、Kimi、智谱、OpenRouter…… 任何 OpenAI 兼容的服务都行。"
          action={<button className="primary-button empty-cta" type="button" onClick={() => navigate('settings')}>去 设 置 页</button>}
        />
      )
    }

    if (!profile) {
      const boundary = boundaries.find((item) => item.code === 'music_empty' || item.code === 'taste_empty')
      if (boundary) return <BoundaryState snapshot={boundary} onAction={() => navigate('settings')} />
      return (
        <EmptyState
          icon="♪"
          title={"嗨,我醒了——但我还没听过你的歌.\n给我看看?"}
          body="从网易云导出的歌单 JSON · 或者直接和我聊几句也行"
          sign="— Echo"
          action={(
            <div className="empty-actions">
              <button className="primary-button empty-cta" type="button" onClick={() => navigate('settings')}>导 入 歌 单</button>
              <button className="secondary-button empty-cta sec" type="button" onClick={() => setDraft('今天适合听什么?')}>先 聊 聊</button>
            </div>
          )}
        />
      )
    }

    return null
  }

  const latestUser = [...messages].reverse().find((message) => message.role === 'user')
  const latestAssistant = [...messages].reverse().find((message) => message.role === 'assistant')
  const stageMessageIds = new Set([latestUser?.id, latestAssistant?.id].filter((id): id is number => typeof id === 'number'))
  const stageMessages = messages.filter((message) => stageMessageIds.has(message.id))
  const hasDialogue = stageMessages.length > 0
  const latestHasBoundary = Boolean(latestAssistant && messageBoundaries[latestAssistant.id])
  const chatStageMode = deriveChatStageMode({
    hasDialogue,
    sending: sending || Boolean(chatTask),
    taskPhase: chatTask?.phase,
    hasError: Boolean(chatNotice) || latestHasBoundary,
  })
  useEffect(() => {
    onStageModeChange?.(chatStageMode)
  }, [chatStageMode, onStageModeChange])
  const isListening = Boolean(playbackState.current) && (playbackState.status === 'playing' || playbackState.status === 'loading')
  const hasBoundary = !hasLlmConfig || !profile
  const [settled, setSettled] = useState(false)
  const shouldSettle = chatStageMode === 'idle' && !hasBoundary && !currentScene
  useEffect(() => {
    if (!shouldSettle) {
      setSettled(false)
      return
    }
    const timer = window.setTimeout(() => setSettled(true), 12_000)
    return () => window.clearTimeout(timer)
  }, [shouldSettle])
  const presenceTitle = !hasLlmConfig
    ? '还差一条模型连接。'
    : !profile
      ? '先让我听见你的音乐。'
      : currentScene?.line
        ?? (isListening
          ? playbackState.current?.echoNote ?? playbackState.current?.reason ?? '这首不用听懂，先让它把眼前撑开一点。'
          : chatStageMode === 'searching'
            ? '我沿着你刚才的话，找一首合适的。'
            : chatStageMode === 'streaming'
              ? '你继续说，我在听。'
              : hasDialogue
            ? '你说，我听着。'
            : '你继续忙。歌我接着，想说话时叫我。')
  return (
    <div className={`phone-surface chat-page stage-${chatStageMode}${hasDialogue ? ' stage-chat' : ''}${hasBoundary ? ' stage-boundary' : ''}${settled ? ' settled' : ''}`}>
      <div className="d2-now-presence">
        <span>{currentScene ? 'ECHO · 场景正在继续' : isListening ? 'ECHO · 一起听' : chatStageMode === 'searching' ? 'ECHO · 正在找声音' : chatStageMode === 'streaming' ? 'ECHO · 正在回应' : chatStageMode === 'error' ? 'ECHO · 这里没接上' : hasDialogue ? 'ECHO · 正在交流' : 'ECHO · 此刻'}</span>
        <h1>{presenceTitle}</h1>
        {(messages.length > 0 || !hasBoundary) && (
          <p>{currentScene ? `${currentScene.label} · 音乐会沿着这个方向继续` : isListening ? '音乐在走，你不用一直回应。' : '想说话时就说，安静也算一种回答。'}</p>
        )}
      </div>
      <div className="d2-ambient-facts" aria-hidden="true">
        <div><small>此刻节奏</small><strong>{currentScene?.label ?? (isListening ? '正在一起听' : '保持安静')}</strong></div>
        <div><small>声音状态</small><strong>{playbackState.current ? playbackState.current.title : '等你开口'}</strong></div>
        <div><small>Echo</small><strong>{sending ? '正在组织回应' : '在这里'}</strong></div>
      </div>
      <blockquote className="d2-quiet-mark">
        你不需要一直有话说。忙你的，想起我的时候再开口。
        <small>Echo · 此刻记下</small>
      </blockquote>

      {chatNotice && (
        <div className="status-ind err chat-notice" role="alert">
          <span className="status-dot" />
          {chatNotice}
        </div>
      )}

      <div className="conversation stage-dialogue" ref={scrollRef} onScroll={handleConversationScroll}>
        {messages.length === 0 ? (
          renderEmptyChat()
        ) : (
          stageMessages.map((message) => (
            <div key={message.id} className={message.role === 'user' ? 'msg me' : 'msg ai'}>
              <div className="message-stack">
                <div className="stage-turn-label">{message.role === 'user' ? '你' : 'ECHO'}</div>
                <div className="bubble">
                  {message.content || (pendingDisplayIds.has(message.id) ? (
                    <span className="waiting-line">
                      {waitingLines[message.id] ?? '我在找一首合适的'}
                      <span className="waiting-dots" aria-hidden="true">
                        <span />
                        <span />
                        <span />
                      </span>
                    </span>
                  ) : '')}
                  {message.tracks?.filter((track) => trackKey(track) !== activeTrackKey).map((track) => (
                    <TrackCard
                      key={`${message.id}-${track.title}`}
                      track={track}
                      onPlay={(track) => handleTrackAction(track, message.tracks ?? [])}
                      onToggleFavorite={toggleFavorite}
                      onFeedback={recordTrackFeedback}
                      onError={(error) => showChatNotice(actionErrorMessage(error, '这次操作失败，可以稍后再试。'))}
                      isCurrent={trackKey(track) === activeTrackKey}
                      playbackStatus={playbackState.status}
                      favorited={favoriteKeys.has(trackKey(track))}
                      feedbackState={feedbackMap[trackKey(track)]}
                    />
                  ))}
                  {authHintIds.has(message.id) && (
                    <button
                      className="primary-button empty-cta chat-cta"
                      type="button"
                      onClick={() => navigate('settings')}
                    >
                      去登录网易云
                    </button>
                  )}
                  {messageBoundaries[message.id] && (
                    <BoundaryState
                      compact
                      snapshot={messageBoundaries[message.id].snapshot}
                      onAction={() => setDraft(messageBoundaries[message.id].retryText)}
                    />
                  )}
                </div>
                {message.role === 'assistant' && <div className="timestamp">{timeLabel(message.createdAt)}</div>}
              </div>
            </div>
          ))
        )}
      </div>

      <form className="composer scene-composer" onSubmit={sendMessage}>
        {scenes.length > 0 && (
          <SceneRail
            scenes={scenes}
            currentScene={currentScene}
            loadingKey={sceneLoadingKey}
            onStart={(key) => {
              enterScene(key).catch((error) => {
                console.warn('[chat] scene action failed', error)
                showChatNotice(actionErrorMessage(error, '场景启动失败，可以再试一次。'))
              })
            }}
            compact
          />
        )}
        <div className="composer-row">
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={hasLlmConfig ? '和 Echo 说点什么...' : '先填好 LLM 才能说话...'}
            disabled={!hasLlmConfig || sceneTaskRunning}
          />
          {sending ? (
            <button className="cancel-button" type="button" onClick={cancelMessage} title="让 Echo 先停一下">
              <Square size={13} fill="currentColor" />
            </button>
          ) : (
            <button type="submit" disabled={!draft.trim() || !hasLlmConfig || sceneTaskRunning} title="发送">
              <Send size={17} />
            </button>
          )}
        </div>
      </form>
    </div>
  )
}
