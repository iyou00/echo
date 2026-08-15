import { useEffect, useState } from 'react'
import { History, MessageCircle, Settings, UserRound } from 'lucide-react'
import type { PageKey } from '../appState'
import { WindowControls } from '../components'

const mainDestinations: Array<{ key: PageKey; label: string; icon: typeof MessageCircle }> = [
  { key: 'yinyi', label: '风信', icon: MessageCircle },
  { key: 'review', label: '回望', icon: History },
]

export function TopBar({
  page,
  yinyiUnread,
  connected,
  onNavigate,
  onMinimize,
  onClose,
}: {
  page: PageKey
  yinyiUnread: boolean
  connected: boolean
  onNavigate: (page: PageKey) => void
  onMinimize: () => void
  onClose: () => void
}) {
  const [clock, setClock] = useState(() => new Date())
  useEffect(() => {
    const timer = window.setInterval(() => setClock(new Date()), 30_000)
    return () => window.clearInterval(timer)
  }, [])
  const today = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', weekday: 'short' }).format(clock)
  const now = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(clock)

  return (
    <header className="d2-topbar">
      <button className="d2-brand" type="button" onClick={() => onNavigate('chat')} title="回到此刻">
        <strong>Echo</strong>
      </button>
      <div className="d2-context" aria-live="polite">
        <span>{today} · {now}</span>
        <strong className={connected ? 'connected' : 'offline'}>{connected ? '在这里' : '等待连接'}</strong>
      </div>
      <nav className="d2-nav" aria-label="Echo 页面">
        {mainDestinations.map(({ key, label, icon: Icon }) => (
          <button
            className={page === key ? 'd2-nav-button active' : 'd2-nav-button'}
            type="button"
            key={key}
            onClick={() => onNavigate(key)}
            title={label}
            aria-label={label}
          >
            <Icon size={14} strokeWidth={1.7} />
            <span>{label}</span>
            {key === 'yinyi' && yinyiUnread && <i aria-label="有新风信" />}
          </button>
        ))}
        <button className={page === 'profile' ? 'd2-icon-button active' : 'd2-icon-button'} type="button" onClick={() => onNavigate('profile')} title="品味" aria-label="品味">
          <UserRound size={17} strokeWidth={1.7} /><span>品味</span>
        </button>
        <button className={page === 'settings' || page === 'about' ? 'd2-icon-button active' : 'd2-icon-button'} type="button" onClick={() => onNavigate('settings')} title="设置" aria-label="设置">
          <Settings size={17} strokeWidth={1.7} /><span>设置</span>
        </button>
      </nav>
      <WindowControls onMinimize={onMinimize} onClose={onClose} />
    </header>
  )
}
