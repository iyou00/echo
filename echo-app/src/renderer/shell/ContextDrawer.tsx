import { useEffect, useRef, type ReactNode } from 'react'
import { X } from 'lucide-react'

export function ContextDrawer({
  open,
  title,
  view,
  children,
  onClose,
}: {
  open: boolean
  title: string
  view: string
  children: ReactNode
  onClose: () => void
}) {
  const closeButtonRef = useRef<HTMLButtonElement | null>(null)

  useEffect(() => {
    if (!open) return
    closeButtonRef.current?.focus({ preventScroll: true })
    const handleKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose()
    }
    window.addEventListener('keydown', handleKeyDown)
    return () => window.removeEventListener('keydown', handleKeyDown)
  }, [onClose, open])

  return (
    <div className={open ? 'd2-drawer-layer open' : 'd2-drawer-layer'} aria-hidden={!open}>
      <button className="d2-drawer-scrim" type="button" onClick={onClose} tabIndex={open ? 0 : -1} aria-label="关闭侧栏" />
      <aside className={`d2-context-drawer view-${view}`} role="dialog" aria-modal="true" aria-labelledby="d2-drawer-title">
        <header className="d2-drawer-header">
          <div>
            <span>Echo · 此刻延伸</span>
            <h2 id="d2-drawer-title">{title}</h2>
          </div>
          <button ref={closeButtonRef} type="button" onClick={onClose} title="关闭" aria-label="关闭侧栏">
            <X size={18} />
          </button>
        </header>
        <div className="d2-drawer-body">{children}</div>
      </aside>
    </div>
  )
}
