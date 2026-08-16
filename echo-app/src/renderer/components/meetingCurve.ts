export const MEETING_GREEN = '#5f9b72'
export const MEETING_RED = '#e45036'

export type Cubic = [[number, number], [number, number], [number, number], [number, number]]

/** 用户的生活线：从左侧画向相遇点 */
export const GREEN_CUBIC: Cubic = [[-0.02, 0.68], [0.18, 0.63], [0.39, 0.72], [0.55, 0.51]]
/** Echo 的回应线：从右侧画向相遇点 */
export const RED_CUBIC: Cubic = [[1.02, 0.33], [0.82, 0.36], [0.68, 0.42], [0.55, 0.51]]

export function cubicPoint(cubic: Cubic, t: number): [number, number] {
  const [p0, p1, p2, p3] = cubic
  const u = 1 - t
  const a = u * u * u
  const b = 3 * u * u * t
  const c = 3 * u * t * t
  const d = t * t * t
  return [
    a * p0[0] + b * p1[0] + c * p2[0] + d * p3[0],
    a * p0[1] + b * p1[1] + c * p2[1] + d * p3[1],
  ]
}

export function drawMeetingCurve(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  cubic: Cubic,
  progress: number,
  color: string,
) {
  const steps = 72
  const last = Math.max(1, Math.round(steps * progress))
  ctx.strokeStyle = color
  ctx.lineWidth = 2
  ctx.shadowColor = color
  ctx.shadowBlur = 8
  ctx.beginPath()
  for (let index = 0; index <= last; index += 1) {
    const [nx, ny] = cubicPoint(cubic, (index / steps) * progress)
    const x = Math.min(w + 2, Math.max(-2, nx * w))
    const y = ny * h
    if (index === 0) ctx.moveTo(x, y)
    else ctx.lineTo(x, y)
  }
  ctx.stroke()
  ctx.shadowBlur = 0
  const [hx, hy] = cubicPoint(cubic, progress)
  ctx.fillStyle = color
  ctx.fillRect(Math.min(w + 2, Math.max(-2, hx * w)) - 2, hy * h - 2, 4, 4)
}

export function easeOutCubic(raw: number): number {
  return 1 - (1 - raw) ** 3
}
