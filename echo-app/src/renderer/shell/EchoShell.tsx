import type { ReactNode } from 'react'
import type { PageKey } from '../appState'
import { TopBar } from './TopBar'
import { WindowField, type WindowFieldMode } from './WindowField'

export function EchoShell({
  page,
  fieldMode,
  yinyiUnread,
  connected,
  children,
  onNavigate,
  onMinimize,
  onClose,
}: {
  page: PageKey
  fieldMode: WindowFieldMode
  yinyiUnread: boolean
  connected: boolean
  children: ReactNode
  onNavigate: (page: PageKey) => void
  onMinimize: () => void
  onClose: () => void
}) {
  const drawerOpen = page === 'review' || page === 'queue' || page === 'profile' || page === 'settings' || page === 'about'
  return (
    <div className={`echo-shell d2-shell field-${fieldMode}${drawerOpen ? ' drawer-open' : ''}`}>
      <main className="app-frame has-global-player">
        <WindowField mode={fieldMode} />
        <TopBar
          page={page}
          yinyiUnread={yinyiUnread}
          connected={connected}
          onNavigate={onNavigate}
          onMinimize={onMinimize}
          onClose={onClose}
        />
        <div className="d2-shell-content">{children}</div>
      </main>
    </div>
  )
}
