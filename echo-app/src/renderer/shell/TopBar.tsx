import { History, ListMusic, MessageCircle, Mic2, Settings, UserRound } from 'lucide-react'
import type { PageKey } from '../appState'
import { WindowControls } from '../components'

const mainDestinations: Array<{ key: PageKey; label: string; icon: typeof MessageCircle }> = [
  { key: 'chat', label: '絮语', icon: MessageCircle },
  { key: 'yinyi', label: '风信', icon: MessageCircle },
  { key: 'voice', label: '回声', icon: Mic2 },
  { key: 'review', label: '回望', icon: History },
  { key: 'queue', label: '拾音', icon: ListMusic },
]

function pageTitle(page: PageKey): string {
  if (page === 'profile') return 'Echo 眼里的你'
  if (page === 'settings') return '设置'
  if (page === 'about') return '关于 Echo'
  return mainDestinations.find((item) => item.key === page)?.label ?? '此刻'
}

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
  const today = new Intl.DateTimeFormat('zh-CN', { month: 'long', day: 'numeric', weekday: 'short' }).format(new Date())

  return (
    <header className="d2-topbar">
      <button className="d2-brand" type="button" onClick={() => onNavigate('chat')} title="回到此刻">
        <strong>Echo</strong>
        <span className={connected ? 'connected' : 'offline'}>{connected ? '在这里' : '等待连接'}</span>
      </button>
      <div className="d2-context" aria-live="polite">
        <span>{today}</span>
        <strong>{pageTitle(page)}</strong>
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
            <Icon size={16} strokeWidth={1.7} />
            <span>{label}</span>
            {key === 'yinyi' && yinyiUnread && <i aria-label="有新风信" />}
          </button>
        ))}
        <button className={page === 'profile' ? 'd2-icon-button active' : 'd2-icon-button'} type="button" onClick={() => onNavigate('profile')} title="品味" aria-label="品味">
          <UserRound size={17} strokeWidth={1.7} />
        </button>
        <button className={page === 'settings' || page === 'about' ? 'd2-icon-button active' : 'd2-icon-button'} type="button" onClick={() => onNavigate('settings')} title="设置" aria-label="设置">
          <Settings size={17} strokeWidth={1.7} />
        </button>
      </nav>
      <WindowControls onMinimize={onMinimize} onClose={onClose} />
    </header>
  )
}
