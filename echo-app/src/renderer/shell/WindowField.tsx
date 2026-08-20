import { useEffect, useRef } from 'react'
import { AUDIO_ENERGY_EVENT, type AudioEnergyDetail } from '../audioAnalysis'

export type WindowFieldMode = 'idle' | 'chat' | 'streaming' | 'searching' | 'error' | 'listening' | 'voice' | 'scene' | 'quiet'

const FOREST = '#184734'
const RED = '#e45036'
const BLUE = '#315bd6'
const MINT = '#a7cda9'
const WHITE = '#f5f5ec'
const GREY_BLUE = '#8d958e'
const GREY_RED = '#b0b6b0'

type Pt = [number, number]

function smoothPath(ctx: CanvasRenderingContext2D, w: number, h: number, points: Pt[]) {
  ctx.beginPath()
  const first = points[0]
  ctx.moveTo(first[0] * w, first[1] * h)
  for (let index = 1; index < points.length - 1; index += 1) {
    const prev = points[index]
    const next = points[index + 1]
    const midX = (prev[0] + next[0]) / 2 * w
    const midY = (prev[1] + next[1]) / 2 * h
    ctx.quadraticCurveTo(prev[0] * w, prev[1] * h, midX, midY)
  }
  const last = points[points.length - 1]
  ctx.lineTo(last[0] * w, last[1] * h)
  ctx.stroke()
}

function strokeCurve(
  ctx: CanvasRenderingContext2D,
  w: number,
  h: number,
  points: Pt[],
  color: string,
  lineWidth: number,
  dash?: number[],
) {
  ctx.strokeStyle = color
  ctx.lineWidth = lineWidth
  ctx.setLineDash(dash ?? [])
  smoothPath(ctx, w, h, points)
  ctx.setLineDash([])
}

export function WindowField({ mode }: { mode: WindowFieldMode }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const audioEnergyRef = useRef(0)
  // 形态切换的交叉淡化：记录上一次绘制的形态与切换时刻，避免线条硬切跳变。
  const drawnModeRef = useRef<WindowFieldMode>(mode)
  const crossFromRef = useRef<WindowFieldMode | null>(null)
  const crossStartedAtRef = useRef(0)
  const modeEnteredAtRef = useRef(performance.now())
  // 交叉淡化期间，旧形态的 growth/pluck 必须用「它自己进入时」的时间戳，
  // 否则切走瞬间旧红线会缩回起点、蓝线被重新拨动一下。
  const prevModeEnteredAtRef = useRef(performance.now())

  useEffect(() => {
    if (drawnModeRef.current === mode) return
    crossFromRef.current = drawnModeRef.current
    crossStartedAtRef.current = performance.now()
    prevModeEnteredAtRef.current = modeEnteredAtRef.current
    modeEnteredAtRef.current = performance.now()
    drawnModeRef.current = mode
  }, [mode])

  useEffect(() => {
    const updateEnergy = (event: Event) => {
      audioEnergyRef.current = (event as CustomEvent<AudioEnergyDetail>).detail?.energy ?? 0
    }
    window.addEventListener(AUDIO_ENERGY_EVENT, updateEnergy)
    return () => window.removeEventListener(AUDIO_ENERGY_EVENT, updateEnergy)
  }, [])

  useEffect(() => {
    if (!canvasRef.current) return
    const canvasElement = canvasRef.current as HTMLCanvasElement
    const candidateContext = canvasElement.getContext('2d')
    if (!candidateContext) return
    const ctx = candidateContext as CanvasRenderingContext2D

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    let width = 0
    let height = 0
    let animationFrame = 0
    let smoothedEnergy = 0.06

    function resize() {
      const bounds = canvasElement.getBoundingClientRect()
      const scale = Math.min(window.devicePixelRatio || 1, 2)
      width = Math.max(1, bounds.width)
      height = Math.max(1, bounds.height)
      canvasElement.width = Math.round(width * scale)
      canvasElement.height = Math.round(height * scale)
      ctx.setTransform(scale, 0, 0, scale, 0, 0)
    }

    // 行波采样管线：所有曲线共用。
    // y = 走向(base) + 多频行波(相位随时间平移，波沿线条前进) x 端点包络
    function sampleLine(
      base: (x: number) => number,
      t: number,
      ampPx: number,
      speed: number,
      seed: number,
    ): Pt[] {
      const points: Pt[] = []
      for (let index = 0; index <= 56; index += 1) {
        const x = index / 56
        const env = Math.sin(Math.PI * x)
        const wave =
          Math.sin(x * 9.4 - t * speed + seed) * 0.62 +
          Math.sin(x * 17.2 - t * speed * 1.6 + seed * 2.1) * 0.28 +
          Math.sin(x * 4.6 - t * speed * 0.7 + seed * 3.7) * 0.35
        points.push([x, base(x) + (wave * env * ampPx) / height])
      }
      return points
    }

    // 墨点：中心实心 + 径向洇开
    function drawInkDot(xPx: number, yPx: number, color: string, bloom = 7) {
      const alpha = ctx.globalAlpha
      const gradient = ctx.createRadialGradient(xPx, yPx, 0, xPx, yPx, bloom)
      gradient.addColorStop(0, color)
      gradient.addColorStop(1, 'rgba(0,0,0,0)')
      ctx.globalAlpha = alpha * 0.35
      ctx.fillStyle = gradient
      ctx.beginPath()
      ctx.arc(xPx, yPx, bloom, 0, Math.PI * 2)
      ctx.fill()
      ctx.globalAlpha = alpha
      ctx.fillStyle = color
      ctx.beginPath()
      ctx.arc(xPx, yPx, 2.2, 0, Math.PI * 2)
      ctx.fill()
    }

    // 截取到 growth 比例的折线（末点插值）
    function clipToGrowth(points: Pt[], growth: number): Pt[] {
      if (growth >= 1) return points
      const scaled = growth * (points.length - 1)
      const cut = Math.floor(scaled)
      const frac = scaled - cut
      const out = points.slice(0, cut + 1)
      const a = points[cut]
      const b = points[cut + 1] ?? a
      out.push([a[0] + (b[0] - a[0]) * frac, a[1] + (b[1] - a[1]) * frac])
      return out
    }

    function drawIdle(tt: number) {
      strokeCurve(ctx, width, height, sampleLine((x) => 0.72 - 0.27 * x * x - 0.02 * Math.sin(x * 5), tt, 5, 0.55, 1.7), FOREST, 1.5)
      strokeCurve(ctx, width, height, sampleLine((x) => 0.53 - 0.09 * x + 0.045 * Math.sin(x * 6.2), tt, 4, 0.62, 4.1), RED, 2)
    }

    function drawScene(tt: number) {
      strokeCurve(ctx, width, height, sampleLine((x) => 0.73 - 0.2 * x * x, tt, 4, 0.5, 2.3), FOREST, 1.5)
      strokeCurve(ctx, width, height, sampleLine((x) => 0.64 - 0.12 * x + 0.04 * Math.sin(x * 5.4), tt, 3.5, 0.58, 5.2), RED, 2)
    }

    function drawChatFamily(tt: number, enteredAgo: number, state: 'chat' | 'streaming' | 'searching' | 'error') {
      const isStreaming = state === 'streaming'
      const isSearching = state === 'searching'
      const isError = state === 'error'

      // 提问的扰动：进入 streaming 后 1.4s 内蓝线被拨动一下再平息
      const pluck = state === 'streaming' ? Math.max(0, 1 - enteredAgo / 1400) : 0
      const blueAmp = 4 + 12 * pluck
      strokeCurve(
        ctx, width, height,
        sampleLine((x) => 0.58 - 0.16 * x + 0.05 * Math.sin(x * 4.2 + 0.6), tt, blueAmp, 0.85, 7.3),
        isError ? GREY_BLUE : BLUE, 1.4, isError ? [5, 7] : undefined,
      )

      // 红线（Echo 的回应）：streaming 时从左往右生长，振幅接正在播放的
      // 音乐能量（絮语回复是文字流，无语音可接），笔端一颗洇开的墨点；
      // searching 同律生长绿线（找歌）。
      if (isStreaming || isSearching) {
        const growth = reducedMotion ? 1 : Math.min(1, enteredAgo / 12000)
        if (isStreaming) {
          const redAmp = 3.5 + 13 * (reducedMotion ? 0 : smoothedEnergy)
          const redFull = sampleLine((x) => 0.5 + 0.075 * Math.sin(x * 3.4 + 0.5) + 0.03 * Math.sin(x * 8), tt, redAmp, 1.05, 11.8)
          const red = clipToGrowth(redFull, growth)
          strokeCurve(ctx, width, height, red, RED, 2)
          const tip = red[red.length - 1]
          drawInkDot(tip[0] * width, tip[1] * height, RED, 7)
        } else {
          const greenAmp = 3 + 8 * (reducedMotion ? 0 : smoothedEnergy)
          const greenFull = sampleLine((x) => 0.44 + 0.09 * Math.sin(x * 2.9 + 2.1), tt, greenAmp, 0.9, 15.4)
          const green = clipToGrowth(greenFull, growth)
          strokeCurve(ctx, width, height, green, FOREST, 1.5)
          const tip = green[green.length - 1]
          drawInkDot(tip[0] * width, tip[1] * height, FOREST, 5)
        }
        return
      }

      strokeCurve(
        ctx, width, height,
        sampleLine((x) => 0.5 + 0.075 * Math.sin(x * 3.4 + 0.5) + 0.03 * Math.sin(x * 8), tt, 4, 0.7, 9.9),
        isError ? GREY_RED : RED, 2, isError ? [3, 8] : undefined,
      )
    }

    function drawWaveform(tt: number, voiceBoost: number) {
      const center = height * 0.84
      const barCount = 72
      const startX = width * 0.49
      const available = width - startX
      const energy = Math.min(1, Math.max(0.18, audioEnergyRef.current))
      for (let index = 0; index < barCount; index += 1) {
        const x = startX + (available * index) / (barCount - 1)
        const amplitude = (7 + 18 * Math.abs(Math.sin(index * 0.43 + tt * 2.1))) * energy * voiceBoost
        const isAccent = index % 9 === 0
        ctx.strokeStyle = isAccent ? RED : MINT
        ctx.lineWidth = isAccent ? 3 : 2
        ctx.beginPath()
        ctx.moveTo(x, center - amplitude / 2)
        ctx.lineTo(x, center + amplitude / 2)
        ctx.stroke()
      }
      strokeCurve(ctx, width, height, [
        [0.48, 0.84],
        [0.64, 0.84 - 14 / height],
        [0.79, 0.84 + 11 / height],
        [1, 0.84 - 7 / height],
      ], WHITE, 1)
    }

    function drawFrame(target: WindowFieldMode, tt: number, nowMs: number) {
      switch (target) {
        case 'idle':
        case 'quiet':
          drawIdle(tt)
          break
        case 'scene':
          drawScene(tt)
          break
        case 'listening':
          drawWaveform(tt, 1)
          break
        case 'voice':
          drawWaveform(tt, 1.15 + 0.28 * Math.sin(tt * 2.8))
          break
        case 'chat':
        case 'streaming':
        case 'searching':
        case 'error': {
          const enteredAgo = nowMs - (target === mode ? modeEnteredAtRef.current : prevModeEnteredAtRef.current)
          drawChatFamily(tt, enteredAgo, target as 'chat' | 'streaming' | 'searching' | 'error')
          break
        }
      }
    }

    const easeInOut = (p: number) => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2)

    function draw(now: number) {
      if (width === 0 || height === 0) resize()
      // 全局连续时钟：形态切换时波动相位不跳变。
      const tt = reducedMotion ? 0 : now / 1000
      smoothedEnergy += (Math.min(1, Math.max(0.05, audioEnergyRef.current)) - smoothedEnergy) * 0.12
      ctx.clearRect(0, 0, width, height)
      const crossFrom = crossFromRef.current
      const progress = crossFrom ? Math.min(1, (now - crossStartedAtRef.current) / 520) : 1
      if (progress < 1) {
        const eased = easeInOut(progress)
        ctx.globalAlpha = 1 - eased
        drawFrame(crossFrom as WindowFieldMode, tt, now)
        ctx.globalAlpha = eased
        drawFrame(mode, tt, now)
        ctx.globalAlpha = 1
        if (progress >= 1) crossFromRef.current = null
      } else {
        crossFromRef.current = null
        drawFrame(mode, tt, now)
      }
      // reduced-motion 下形态过渡仍走完（一次性渐变，无持续运动），结束后停帧。
      if (!reducedMotion || progress < 1) animationFrame = window.requestAnimationFrame(draw)
    }

    const resizeObserver = new ResizeObserver(() => {
      resize()
      if (reducedMotion) draw(performance.now())
    })
    resizeObserver.observe(canvasElement)
    resize()
    draw(performance.now())

    return () => {
      resizeObserver.disconnect()
      window.cancelAnimationFrame(animationFrame)
    }
  }, [mode])

  return <canvas className="d2-window-field" ref={canvasRef} aria-hidden="true" />
}
