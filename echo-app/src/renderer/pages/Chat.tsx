import { FormEvent, useEffect, useRef, useState } from 'react'
import { Send, Square } from 'lucide-react'
import type { ActiveScene, ChatMessage, EchoApi, PlaybackState, SceneDefinition, SceneKey, ScenePlaybackResult, TasteProfile, Track } from '../../types/ipc'
import type { AppPageProps } from '../../App'
import { BrandLogo, EmptyState, SceneRail, TrackCard } from '../components'

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
}

const WAITING_LINES = [
  '等我翻翻我的宝藏歌单',
  '让我在旋律里捞一首合适的',
  '我在听，也在找，稍等呀',
  '耳朵已经竖起来了，在找了',
  '音符正在赶来的路上',
  '这次有点难到我了，让我再琢磨下',
  '你的心情有点复杂，我需要多听几秒',
  '这个氛围有点微妙，得仔细挑一首',
  '我在很认真地感受你说的',
  '正在把感觉翻译成旋律',
  '别急，好音乐值得等一小下',
  '想给你一首，刚好接住你心情的歌',
  '在脑内开了一场小型试听会',
  '像翻旧唱片一样，为你找那一轨',
  '嗯，我听到了',
  '正在感受你此刻的心情频率',
  '马上就好，旋律正在加载',
  '在翻了在翻了，歌单有点长',
  '等等，我正从耳机里往外掏歌',
  '脑内点歌台，正在为你连线',
  '挑歌中，请允许我纠结几秒',
  '马上，等我抓个旋律塞给你',
  '稍等，我在心里过一遍前奏',
  '嗯……这首味道好像对了',
  '让我猜猜你现在想听什么',
  '别急，好旋律不怕晚',
  '感觉要来了，就在下一首',
  '正在调动我的音乐直觉',
  '快了，音符排队上车中',
  '等我，在跟某首歌对个眼神',
  '耳朵已经忙起来了，马上好',
]

const CASUAL_WAITING_LINES = [
  '嗯，我在听',
  '等我想想怎么接你这句话',
  '这句我得认真回',
  '让我慢慢想一下',
  '我先接住你这句话',
  '有点懂你的意思了',
  '我在想怎么说更贴近一点',
  '等我把话放软一点',
  '我听见了，等我一下',
  '这句我想认真想想',
  '我在心里过一遍',
  '让我找个更像朋友的说法',
]

// 让 Echo 看起来像在"打字思考":
// - DELAY: 接到 result 后先压住至少 2 秒, 让"思考期"明确
// - TICK 间隔动态算: 短回复放慢看清, 长回复不卡死, 总打字时长目标 ≥ MIN_TOTAL_MS
// - REPLY_CHARS_PER_TICK 固定 1, 一字一字露出, 才像真人在敲
const REPLY_DELAY_MS = 2000
const REPLY_MIN_TICK_MS = 90
const REPLY_MAX_TICK_MS = 600
const REPLY_MIN_TOTAL_MS = 4500
const REPLY_CHARS_PER_TICK = 1
const WAITING_APPEAR_DELAY_MS = 750
const WAITING_TICK_MS = 55

function computeTickInterval(totalChars: number): number {
  if (totalChars <= 0) return REPLY_MIN_TICK_MS
  const ideal = Math.floor(REPLY_MIN_TOTAL_MS / totalChars)
  return Math.max(REPLY_MIN_TICK_MS, Math.min(REPLY_MAX_TICK_MS, ideal))
}

function looksLikeMusicRelated(text: string): boolean {
  return /推|推荐|来几首|听什么|听啥|值得听|适合听|想听|能听|放点|放首|来点|歌|曲|歌单|music|song|慢|快|安静|热闹|循环|舒缓|轻|燃|治愈|怀旧|睡前|通勤|粤语|英文|欧美|韩|日语|kpop|雨天|发呆/i.test(text)
}

function pickWaitingLineFor(text: string) {
  const pool = looksLikeMusicRelated(text) ? WAITING_LINES : CASUAL_WAITING_LINES
  return pool[Math.floor(Math.random() * pool.length)] ?? CASUAL_WAITING_LINES[0]
}

function timeLabel(value: string) {
  return new Date(value).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })
}

function trackKey(track?: Track | null): string {
  if (!track) return ''
  return `${track.neteaseId ?? track.id ?? ''}:${track.title}:${track.artist}`
}

function friendlyChatError(error: unknown) {
  const message = error instanceof Error ? error.message : ''
  if (/401|unauthorized|api key|apikey|余额|quota|credit|billing/i.test(message)) {
    return '我连不上自己的脑子了——你的 API key 可能过期或者余额没了。去设置页看看?'
  }
  if (/network|fetch|timeout|econn|enotfound|断网|网络/i.test(message)) {
    return '网络断了——Echo 等你回来。正在播的歌可以继续听。'
  }
  return message || 'Echo 这会儿接不上模型。先去设置里看一眼。'
}

export function ChatPage({ echo, navigate, playbackState, setPlaybackState, hasLlmConfig, profile, refreshQueue, restoreOnStart, scenes, currentScene, playScene, endScene, autoPlayNext, updateAutoPlayNext, focusApiSettings }: ChatPageProps) {
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [draft, setDraft] = useState('')
  const [sending, setSending] = useState(false)
  const [loadingScene, setLoadingScene] = useState<string | null>(null)
  const [favoriteKeys, setFavoriteKeys] = useState<Set<string>>(new Set())
  const [feedbackMap, setFeedbackMap] = useState<Record<string, 'more_like_this' | 'not_right'>>({})
  const [waitingLines, setWaitingLines] = useState<Record<number, string>>({})
  const [pendingDisplayIds, setPendingDisplayIds] = useState<Set<number>>(new Set())
  // 仅会话内有效：标记需要展示"去登录网易云"CTA 的助手消息 id（不持久化）。
  const [authHintIds, setAuthHintIds] = useState<Set<number>>(new Set())
  const activeAssistantId = useRef<number | null>(null)
  const scrollRef = useRef<HTMLDivElement | null>(null)
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
      echo.chat.loadRecent(30).then(setMessages)
    } else {
      setMessages([])
    }
    echo.favorites.list().then((tracks) => setFavoriteKeys(new Set(tracks.map(trackKey)))).catch(() => setFavoriteKeys(new Set()))
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
    }
  }, [])

  useEffect(() => {
    return echo.chat.onMessageInjected((message) => {
      setMessages((items) => items.some((item) => item.id === message.id) ? items : [...items, message])
    })
  }, [echo])

  useEffect(() => {
    return echo.settings.onChanged((payload) => {
      if (payload.path === '*') setMessages([])
    })
  }, [echo])

  useEffect(() => {
    if (!scrollRef.current) return
    scrollRef.current.scrollTop = scrollRef.current.scrollHeight
  }, [messages])

  async function sendMessage(event: FormEvent) {
    event.preventDefault()
    await submitText(draft)
  }

  async function submitText(rawText: string) {
    const text = rawText.trim()
    if (!text || sending || !hasLlmConfig || currentScene) return

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
      finalMessages.current[assistantMessage.id] = result.message
      // 不再依赖 onChunk 累积, send return 时直接用完整 content 灌满。
      chunkBuffers.current[assistantMessage.id] = result.message.content
      if (result.hints?.neteaseAuthRequired) {
        // 把按钮挂在最终落地的 message id 上（持久化到 DB 的真实 id），打字结束后会替换占位 message。
        const finalId = result.message.id
        setAuthHintIds((items) => {
          const next = new Set(items)
          next.add(finalId)
          return next
        })
      }
      scheduleReplyStart(assistantMessage.id)
      const returnedTracks = result.message.tracks?.length ? result.message.tracks : result.tracks
      const nextTrack = returnedTracks.find((track) => track.playUrl) ?? null
      if (nextTrack) {
        const nextState = await echo.playback.play(nextTrack)
        setPlaybackState(nextState)
        await primePlaybackQueue(returnedTracks, nextTrack)
      }
      await refreshQueue()
    } catch (error) {
      if (cancelTokens.current.has(assistantMessage.id)) {
        cancelTokens.current.delete(assistantMessage.id)
        return
      }
      finalMessages.current[assistantMessage.id] = { ...assistantMessage, content: friendlyChatError(error) }
      chunkBuffers.current[assistantMessage.id] = friendlyChatError(error)
      scheduleReplyStart(assistantMessage.id)
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

  function scheduleWaitingLine(id: number, line: string) {
    waitingBuffers.current[id] = line
    waitingAppearTimers.current[id] = window.setTimeout(() => {
      delete waitingAppearTimers.current[id]
      if (finalMessages.current[id] || cancelTokens.current.has(id)) return
      setWaitingLines((items) => ({ ...items, [id]: '' }))
      setPendingDisplayIds((items) => new Set(items).add(id))
      startWaitingTyping(id)
    }, WAITING_APPEAR_DELAY_MS)
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
    echo.chat.cancel().catch(() => undefined)
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
    if (sending || !hasLlmConfig) return
    // toggle：点击已激活的场景 = 退出
    if (currentScene?.key === key) {
      await endScene()
      return
    }
    if (!autoPlayNext) await updateAutoPlayNext(true)
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
    } finally {
      setLoadingScene(null)
    }
  }

  async function recordTrackFeedback(track: Track, action: 'more_like_this' | 'not_right') {
    const key = trackKey(track)
    setFeedbackMap((items) => ({ ...items, [key]: action }))
    try {
      await echo.feedback.record(track, action, 'chat_recommendation_card')
    } catch {
      setFeedbackMap((items) => {
        const next = { ...items }
        delete next[key]
        return next
      })
    }
  }

  function renderEmptyChat() {
    if (!hasLlmConfig) {
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
      return (
        <EmptyState
          icon="♪"
          title={"嗨,我醒了——但我还没听过你的歌。\n给我看看?"}
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

    return (
      <EmptyState
        icon={<BrandLogo className="empty-logo" size={56} />}
        title={"我粗看了你的歌单。\n现在开始,你可以直接问我该听什么。"}
        body={'比如“来点慢的”“我想睡了”“这个下午适合什么”。\n我会先挑能播的歌。'}
        sign="— Echo"
        action={<button className="primary-button empty-cta" type="button" onClick={() => setDraft('这个时候有什么值得听的吗')}>开 始 聊</button>}
      />
    )
  }

  return (
    <div className="phone-surface chat-page">
      {!hasLlmConfig && (
        <button className="setup-banner" onClick={() => { focusApiSettings?.(); navigate('settings') }}>
          先填好模型设置，Echo 才能开口。
        </button>
      )}

      <div className="conversation" ref={scrollRef}>
        {messages.length === 0 ? (
          renderEmptyChat()
        ) : (
          messages.map((message) => (
            <div key={message.id} className={message.role === 'user' ? 'msg me' : 'msg ai'}>
              <div className="message-stack">
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
                  {message.tracks?.map((track) => (
                    <TrackCard
                      key={`${message.id}-${track.title}`}
                      track={track}
                      onPlay={(track) => handleTrackAction(track, message.tracks ?? [])}
                      onToggleFavorite={toggleFavorite}
                      onFeedback={recordTrackFeedback}
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
            loadingKey={loadingScene}
            onStart={(key) => { void enterScene(key) }}
            compact
          />
        )}
        <div className="composer-row">
          <input
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder={currentScene ? `正在「${currentScene.label}」中…` : hasLlmConfig ? '和 Echo 说点什么...' : '先填好 LLM 才能说话...'}
            disabled={Boolean(currentScene) || !hasLlmConfig}
          />
          {sending ? (
            <button className="cancel-button" type="button" onClick={cancelMessage} title="让 Echo 先停一下">
              <Square size={13} fill="currentColor" />
            </button>
          ) : (
            <button type="submit" disabled={!draft.trim() || !hasLlmConfig || Boolean(currentScene)} title="发送">
              <Send size={17} />
            </button>
          )}
        </div>
      </form>
    </div>
  )
}
