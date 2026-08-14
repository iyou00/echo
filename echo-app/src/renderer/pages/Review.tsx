import { useCallback, useEffect, useState } from 'react'
import { Clock3, RefreshCw } from 'lucide-react'
import type { EchoApi, StageContext } from '../../types/ipc'
import { EmptyState } from '../components'
import { buildReviewTimeline, type ReviewTimelineItem } from './reviewTimeline'

function timeLabel(value: string): string {
  return new Date(value).toLocaleString('zh-CN', { month: 'numeric', day: 'numeric', hour: '2-digit', minute: '2-digit' })
}

export function ReviewPage({ echo, isActive }: { echo: EchoApi; isActive: boolean }) {
  const [items, setItems] = useState<ReviewTimelineItem[]>([])
  const [context, setContext] = useState<StageContext | null>(null)
  const [loading, setLoading] = useState(false)
  const [notice, setNotice] = useState('')

  const load = useCallback(async () => {
    setLoading(true)
    setNotice('')
    try {
      const [messages, history, actions, activeContext] = await Promise.all([
        echo.chat.loadRecent(18),
        echo.queue.history(7),
        echo.stageContext.recentActions(20),
        echo.stageContext.getActive(),
      ])
      setItems(buildReviewTimeline(messages, history, actions))
      setContext(activeContext)
    } catch {
      setNotice('最近发生的内容暂时没有完整读出来。')
    } finally {
      setLoading(false)
    }
  }, [echo])

  useEffect(() => {
    if (!isActive) return
    void load()
  }, [isActive, load])

  return (
    <div className="phone-surface review-page">
      <div className="page-toolbar">
        <div className="tb-status">只读回望 · 不改变画像与记忆</div>
        <button className="tb-btn icon-only" type="button" onClick={() => { void load() }} disabled={loading} title="刷新" aria-label="刷新回望">
          <RefreshCw size={13} />
        </button>
      </div>
      <div className="review-scroll">
        {context && (
          <section className="review-context">
            <span>Echo 此刻的理解</span>
            <strong>{context.summary}</strong>
            <small>{context.kind} · {context.goal} · 第 {context.revision} 次更新</small>
          </section>
        )}
        {notice && <div className="status-ind err" role="alert"><span className="status-dot" />{notice}</div>}
        {loading && items.length === 0 ? (
          <div className="quiet-line">正在把最近发生的事放回时间里...</div>
        ) : items.length === 0 ? (
          <EmptyState muted icon={<Clock3 size={20} />} title="这里还没有可以回望的片段。" body="聊过、听过或明确执行过的动作会按时间留在这里。" />
        ) : (
          <div className="review-timeline">
            {items.map((item) => (
              <article className={`review-item tone-${item.tone}`} key={item.id}>
                <time>{timeLabel(item.occurredAt)}</time>
                <div>
                  <span>{item.label}</span>
                  <strong>{item.title}</strong>
                  {item.detail && <p>{item.detail}</p>}
                </div>
              </article>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
