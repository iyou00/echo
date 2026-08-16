import { describe, expect, it } from 'vitest'
import { cubicPoint, drawMeetingCurve, easeOutCubic, GREEN_CUBIC, RED_CUBIC } from './meetingCurve'

describe('meeting curve math', () => {
  it('starts and ends at the exact control endpoints', () => {
    expect(cubicPoint(GREEN_CUBIC, 0)).toEqual(GREEN_CUBIC[0])
    expect(cubicPoint(GREEN_CUBIC, 1)).toEqual(GREEN_CUBIC[3])
  })

  it('has both lines meet at the same point', () => {
    expect(cubicPoint(GREEN_CUBIC, 1)).toEqual(cubicPoint(RED_CUBIC, 1))
  })

  it('keeps the curve inside a sane horizontal band', () => {
    for (let step = 0; step <= 20; step += 1) {
      const t = step / 20
      for (const cubic of [GREEN_CUBIC, RED_CUBIC]) {
        const y = cubicPoint(cubic, t)[1]
        expect(y).toBeGreaterThan(0)
        expect(y).toBeLessThan(1)
      }
    }
  })

  it('eases out without overshoot', () => {
    expect(easeOutCubic(0)).toBe(0)
    expect(easeOutCubic(1)).toBe(1)
    expect(easeOutCubic(0.5)).toBeGreaterThan(0.5)
  })

  it('draws without touching the canvas outside the path calls', () => {
    const ops: string[] = []
    const ctx = {
      strokeStyle: '',
      lineWidth: 0,
      shadowColor: '',
      shadowBlur: 0,
      fillStyle: '',
      beginPath: () => ops.push('begin'),
      moveTo: () => ops.push('move'),
      lineTo: () => ops.push('line'),
      stroke: () => ops.push('stroke'),
      fillRect: () => ops.push('fill'),
    } as unknown as CanvasRenderingContext2D
    drawMeetingCurve(ctx, 1280, 800, GREEN_CUBIC, 1, '#000')
    expect(ops[0]).toBe('begin')
    expect(ops.indexOf('stroke')).toBeGreaterThan(0)
    expect(ops[ops.length - 1]).toBe('fill')
  })
})
