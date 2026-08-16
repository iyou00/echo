import { useEffect, useState } from 'react'
import { MeetingCanvas } from './MeetingCanvas'
import { DAILY_RECONNECT_FADE_MS, dailyReconnectDuration } from './dailyReconnectPolicy'

/**
 * 普通启动时的 1.5 秒"重新接上"：你的生活和 Echo 的回应两条线再次相遇。
 * 只在冷启动出现；从托盘唤醒不会重播。
 */
export function DailyReconnect({ onComplete }: { onComplete: () => void }) {
  const [leaving, setLeaving] = useState(false)
  const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
  const durationMs = dailyReconnectDuration(reducedMotion)

  useEffect(() => {
    if (durationMs === 0) {
      onComplete()
      return
    }
  }, [durationMs, onComplete])

  function handleComplete() {
    setLeaving(true)
    window.setTimeout(onComplete, DAILY_RECONNECT_FADE_MS)
  }

  return (
    <div className={leaving ? 'daily-reconnect-layer leaving' : 'daily-reconnect-layer'} role="status" aria-label="Echo 正在重新接上">
      <MeetingCanvas durationMs={Math.max(1, durationMs)} onComplete={durationMs === 0 ? undefined : handleComplete} className="daily-reconnect-field" />
      <div className="daily-reconnect-mark">E C H O</div>
      <div className="daily-reconnect-tip">重新接上</div>
    </div>
  )
}
