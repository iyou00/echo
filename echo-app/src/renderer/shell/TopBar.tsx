import { useEffect, useState } from 'react'
import { ListMusic, MessageCircle, Mic2, Settings, UserRound } from 'lucide-react'
import type { PageKey } from '../appState'
import { WindowControls } from '../components'
import { getEchoApi } from '../api'

type TopBarWeather = { city: string; condition: string; tempC: number } | null

// 「回声」（听 Echo 说几句）是用户高频入口，2026-08-16 从输入框旁的隐形麦克风图标升回一级导航；
// 「回望」同日移除——只读时间线与对话历史/设置「此刻的理解」完全重叠，无独立价值。
const mainDestinations: Array<{ key: PageKey; label: string; icon: typeof MessageCircle }> = [
  { key: 'yinyi', label: '风信', icon: MessageCircle },
  { key: 'voice', label: '回声', icon: Mic2 },
  { key: 'profile', label: '品味', icon: UserRound },
  { key: 'queue', label: '队列', icon: ListMusic },
  { key: 'settings', label: '设置', icon: Settings },
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
  const [weather, setWeather] = useState<TopBarWeather>(null)
  useEffect(() => {
    const timer = window.setInterval(() => setClock(new Date()), 30_000)
    return () => window.clearInterval(timer)
  }, [])
  useEffect(() => {
    let alive = true
    getEchoApi().weather.get().then((info) => {
      if (alive) setWeather(info)
    }).catch(() => undefined)
    return () => {
      alive = false
    }
  }, [])
  const today = new Intl.DateTimeFormat('zh-CN', { month: 'numeric', day: 'numeric', weekday: 'short' }).format(clock)
  const now = new Intl.DateTimeFormat('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }).format(clock)

  return (
    <header className="d2-topbar">
      <button className="d2-brand" type="button" onClick={() => onNavigate('chat')} title="回到此刻">
        <strong>Echo</strong>
      </button>
      <div className="d2-context">
        <span>{today} · {now}</span>
        {weather && weather.city && Number.isFinite(weather.tempC) && (
          <span className="d2-context-weather">{weather.city} {weather.tempC}°{weather.condition ? ` · ${weather.condition}` : ''}</span>
        )}
        {!connected && <strong className="offline">等待连接</strong>}
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
      </nav>
      <WindowControls onMinimize={onMinimize} onClose={onClose} />
    </header>
  )
}
