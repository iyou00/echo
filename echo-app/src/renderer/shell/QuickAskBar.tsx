import { useEffect, useRef, useState } from 'react'
import type { PageKey } from '../appState'
import { isQuickAskShortcut, shouldOpenQuickAsk } from './quickAskGuard'
import { splitNarration } from '../components/listeningNarration'
import { getEchoApi } from '../api'

type QuickAskReply = {
  content: string
  trackCount: number
}

/**
 * Ctrl+K「想到就说」：任意界面的底部细线输入条，直接把一句话交给 Echo。
 * 对话页里改为聚焦现有输入框。回复就地淡入，带歌时给一个去此刻的入口。
 */
export function QuickAskBar({
  page,
  navigate,
  hasLlmConfig,
  firstRunOpen,
  onboardingOpen,
  closeDialogOpen,
}: {
  page: PageKey
  navigate: (page: PageKey) => void
  hasLlmConfig: boolean
  firstRunOpen: boolean
  onboardingOpen: boolean
  closeDialogOpen: boolean
}) {
  const [open, setOpen] = useState(false)
  const [text, setText] = useState('')
  const [pending, setPending] = useState(false)
  const [reply, setReply] = useState<QuickAskReply | null>(null)
  const [error, setError] = useState('')
  const inputRef = useRef<HTMLInputElement | null>(null)
  const askSessionRef = useRef(0)

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      if (!isQuickAskShortcut(event)) return
      if (!shouldOpenQuickAsk({ hasLlmConfig, firstRunOpen, onboardingOpen, closeDialogOpen })) return
      event.preventDefault()
      if (page === 'chat') {
        const composer = document.querySelector<HTMLInputElement>('.d2-now-page .composer-row input')
        if (composer) {
          composer.focus()
          return
        }
      }
      setOpen(true)
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [closeDialogOpen, firstRunOpen, hasLlmConfig, onboardingOpen, page])

  useEffect(() => {
    if (open) inputRef.current?.focus()
  }, [open])

  function close() {
    askSessionRef.current += 1
    setOpen(false)
    setText('')
    setReply(null)
    setError('')
  }

  async function submit() {
    const value = text.trim()
    if (!value || pending) return
    setPending(true)
    setError('')
    setReply(null)
    const session = askSessionRef.current
    try {
      const result = await getEchoApi().chat.send(value)
      if (askSessionRef.current !== session) return
      const returnedTracks = result.message.tracks?.length ? result.message.tracks : result.tracks
      setReply({ content: result.message.content, trackCount: returnedTracks.length })
      window.dispatchEvent(new CustomEvent('echo:quick-ask-exchange', {
        detail: {
          user: { id: -Date.now(), role: 'user', content: value, createdAt: new Date().toISOString() },
          assistant: { id: result.message.id, role: 'assistant', content: result.message.content, createdAt: result.message.createdAt, tracks: returnedTracks },
        },
      }))
    } catch (error) {
      if (askSessionRef.current !== session) return
      const message = error instanceof Error ? error.message : String(error)
      setError(/已有任务|稍后再试/.test(message) ? '上一句还在想，等它说完。' : '这句没接住，再试一次。')
    } finally {
      if (askSessionRef.current === session) setPending(false)
    }
  }

  if (!open) return null

  return (
    <div className="d2-quick-ask-layer" role="dialog" aria-modal="false" aria-label="想到就说">
      <div className="d2-quick-ask-panel">
        {reply && (
          <div className="d2-quick-ask-reply">
            {splitNarration(reply.content).slice(0, 4).map((sentence) => (
              <p key={sentence.text} style={{ animationDelay: `${sentence.delayMs}ms` }}>{sentence.text}</p>
            ))}
            {reply.trackCount > 0 && (
              <button type="button" className="d2-quick-ask-golink" onClick={() => { close(); navigate('chat') }}>
                去此刻看歌 →
              </button>
            )}
          </div>
        )}
        {error && <div className="d2-quick-ask-error" role="alert">{error}</div>}
        <form
          className="d2-quick-ask-bar"
          onSubmit={(event) => {
            event.preventDefault()
            void submit()
          }}
        >
          <input
            ref={inputRef}
            value={text}
            onChange={(event) => setText(event.target.value)}
            placeholder={pending ? 'Echo 正在想…' : '想到就说一句…'}
            disabled={pending}
            maxLength={500}
            onKeyDown={(event) => {
              if (event.nativeEvent.isComposing || event.keyCode === 229) return
              if (event.key === 'Escape') {
                event.preventDefault()
                close()
              }
            }}
          />
          <button type="submit" disabled={!text.trim() || pending}>{pending ? '…' : '说'}</button>
          <button type="button" className="d2-quick-ask-close" onClick={close} aria-label="收起">✕</button>
        </form>
        <div className="d2-quick-ask-hint">Ctrl+K 随叫随到 · Esc 收起</div>
      </div>
    </div>
  )
}
