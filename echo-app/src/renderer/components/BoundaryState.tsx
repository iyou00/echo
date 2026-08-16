import { AlertCircle, RefreshCw } from 'lucide-react'
import type { UiBoundarySnapshot } from '../../types/ipc'
import { boundaryPresentation } from '../boundaryPresentation'
import { EmptyState } from '../components'

export function BoundaryState({
  snapshot,
  onAction,
  compact = false,
  bare = false,
}: {
  snapshot: UiBoundarySnapshot
  onAction?: () => void
  compact?: boolean
  bare?: boolean
}) {
  const copy = boundaryPresentation(snapshot)
  const action = copy.actionLabel && onAction
    ? (
        <button className={compact ? 'boundary-action compact' : 'primary-button empty-cta'} type="button" onClick={onAction}>
          {snapshot.retryable && <RefreshCw size={compact ? 12 : 14} aria-hidden="true" />}
          {copy.actionLabel}
        </button>
      )
    : undefined

  if (!compact) {
    return <EmptyState muted bare={bare} icon={<AlertCircle size={24} />} title={copy.title} body={copy.body} action={action} />
  }

  return (
    <div className={`boundary-notice ${snapshot.scope}`} role="status" aria-live="polite">
      <AlertCircle size={15} aria-hidden="true" />
      <div className="boundary-notice-copy">
        <strong>{copy.title}</strong>
        <span>{copy.body}</span>
      </div>
      {action}
    </div>
  )
}
