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

  useEffect(() => {
    if (drawnModeRef.current === mode) return
    crossFromRef.current = drawnModeRef.current
    crossStartedAtRef.current = performance.now()
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

    function resize() {
      const bounds = canvasElement.getBoundingClientRect()
      const scale = Math.min(window.devicePixelRatio || 1, 2)
      width = Math.max(1, bounds.width)
      height = Math.max(1, bounds.height)
      canvasElement.width = Math.round(width * scale)
      canvasElement.height = Math.round(height * scale)
      ctx.setTransform(scale, 0, 0, scale, 0, 0)
    }

    function drawIdle(tt: number) {
      strokeCurve(ctx, width, height, [
        [0, 0.72],
        [0.16, 0.69 + Math.sin(tt) * 6 / height],
        [0.34, 0.74],
        [0.53, 0.64 + Math.cos(tt * 0.8) * 8 / height],
        [0.72, 0.66],
        [0.80, 0.54],
        [0.88, 0.47],
        [1, 0.45],
      ], FOREST, 1.5)
      strokeCurve(ctx, width, height, [
        [0.48, 0.53],
        [0.61, 0.47],
        [0.74, 0.57],
        [0.88, 0.43],
      ], RED, 2)
    }

    function drawScene(tt: number) {
      strokeCurve(ctx, width, height, [
        [0, 0.72],
        [0.17, 0.70 + Math.sin(tt) * 5 / height],
        [0.35, 0.75],
        [0.53, 0.69],
        [0.71, 0.72],
        [1, 0.53],
      ], FOREST, 1.5)
      strokeCurve(ctx, width, height, [
        [0.51, 0.64],
        [0.64, 0.59],
        [0.77, 0.66],
        [0.89, 0.52],
      ], RED, 2)
    }

    function drawChatFamily(tt: number, state: 'chat' | 'streaming' | 'searching' | 'error') {
      const isStreaming = state === 'streaming'
      const isSearching = state === 'searching'
      const isError = state === 'error'
      const bluePoints: Pt[] = [
        [0, 0.56],
        [0.18, 0.49],
        [0.36, 0.57 + Math.sin(tt) * 7 / height],
        [0.56, 0.31],
        [0.76, 0.51],
        [1, 0.43],
      ]
      strokeCurve(ctx, width, height, bluePoints, isError ? GREY_BLUE : BLUE, 1.4, isError ? [5, 7] : undefined)

      const echoEnd = isStreaming
        ? 0.36 + 0.13 * ((Math.sin(tt * 2) + 1) / 2)
        : 0.39
      const redPoints: Pt[] = [
        [0.07, 0.53],
        [0.22, 0.62],
        [0.39, 0.49],
        [echoEnd, 0.58],
      ]
      strokeCurve(ctx, width, height, redPoints, isError ? GREY_RED : RED, 2, isError ? [3, 8] : undefined)
      if (isStreaming && !isError) {
        ctx.fillStyle = RED
        ctx.fillRect(echoEnd * width - 3, 0.58 * height - 3, 6, 6)
      }
      if (isSearching) {
        const searchPoints: Pt[] = [
          [0.57, 0.37],
          [0.68, 0.42],
          [0.79, 0.47],
          [0.88, 0.52],
        ]
        strokeCurve(ctx, width, height, searchPoints, FOREST, 1.5)
        ctx.fillStyle = FOREST
        ctx.fillRect(0.88 * width - 3, 0.52 * height - 3, 6, 6)
      }
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

    function drawFrame(target: WindowFieldMode, tt: number) {
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
          drawChatFamily(tt, 'chat')
          break
        case 'streaming':
          drawChatFamily(tt, 'streaming')
          break
        case 'searching':
          drawChatFamily(tt, 'searching')
          break
        case 'error':
          drawChatFamily(tt, 'error')
          break
      }
    }

    const easeInOut = (p: number) => (p < 0.5 ? 2 * p * p : 1 - Math.pow(-2 * p + 2, 2) / 2)

    function draw(now: number) {
      if (width === 0 || height === 0) resize()
      // 全局连续时钟：形态切换时波动相位不跳变。
      const tt = reducedMotion ? 0 : now / 1000
      ctx.clearRect(0, 0, width, height)
      const crossFrom = crossFromRef.current
      const progress = crossFrom ? Math.min(1, (now - crossStartedAtRef.current) / 520) : 1
      if (progress < 1) {
        const eased = easeInOut(progress)
        ctx.globalAlpha = 1 - eased
        drawFrame(crossFrom as WindowFieldMode, tt)
        ctx.globalAlpha = eased
        drawFrame(mode, tt)
        ctx.globalAlpha = 1
        if (progress >= 1) crossFromRef.current = null
      } else {
        crossFromRef.current = null
        drawFrame(mode, tt)
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
