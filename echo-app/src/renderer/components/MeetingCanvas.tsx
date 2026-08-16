import { useEffect, useRef } from 'react'
import { drawMeetingCurve, easeOutCubic, GREEN_CUBIC, MEETING_GREEN, MEETING_RED, RED_CUBIC } from './meetingCurve'

export function MeetingCanvas({
  durationMs,
  onComplete,
  className,
}: {
  durationMs: number
  onComplete?: () => void
  className?: string
}) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const onCompleteRef = useRef(onComplete)
  onCompleteRef.current = onComplete

  useEffect(() => {
    if (!canvasRef.current) return
    const canvasElement = canvasRef.current as HTMLCanvasElement
    const candidate = canvasElement.getContext('2d')
    if (!candidate) return
    const ctx = candidate as CanvasRenderingContext2D
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    let width = 0
    let height = 0
    let frame = 0
    let completed = false
    const startedAt = performance.now()

    function finish() {
      if (completed) return
      completed = true
      onCompleteRef.current?.()
    }

    function resize() {
      const bounds = canvasElement.getBoundingClientRect()
      const scale = Math.min(window.devicePixelRatio || 1, 2)
      width = Math.max(1, bounds.width)
      height = Math.max(1, bounds.height)
      canvasElement.width = Math.round(width * scale)
      canvasElement.height = Math.round(height * scale)
      ctx.setTransform(scale, 0, 0, scale, 0, 0)
    }

    function draw(now: number) {
      if (width === 0 || height === 0) resize()
      const raw = reducedMotion ? 1 : Math.min(1, (now - startedAt) / durationMs)
      const eased = easeOutCubic(raw)
      ctx.clearRect(0, 0, width, height)
      drawMeetingCurve(ctx, width, height, GREEN_CUBIC, eased, MEETING_GREEN)
      drawMeetingCurve(ctx, width, height, RED_CUBIC, eased, MEETING_RED)
      if (raw >= 1) {
        finish()
        return
      }
      if (!reducedMotion) frame = window.requestAnimationFrame(draw)
    }

    const observer = new ResizeObserver(() => {
      resize()
      draw(performance.now())
    })
    observer.observe(canvasElement)
    resize()
    draw(startedAt)
    return () => {
      observer.disconnect()
      window.cancelAnimationFrame(frame)
    }
  }, [durationMs])

  return <canvas className={className} ref={canvasRef} aria-hidden="true" />
}
