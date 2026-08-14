import { useEffect, useRef } from 'react'
import { AUDIO_ENERGY_EVENT, type AudioEnergyDetail } from '../audioAnalysis'

export type WindowFieldMode = 'idle' | 'chat' | 'streaming' | 'searching' | 'error' | 'listening' | 'voice' | 'scene' | 'quiet' | 'welcome'

const MODE_ENERGY: Record<WindowFieldMode, { green: number; red: number; speed: number }> = {
  idle: { green: 5, red: 3, speed: 0.18 },
  chat: { green: 7, red: 9, speed: 0.28 },
  streaming: { green: 9, red: 12, speed: 0.42 },
  searching: { green: 13, red: 6, speed: 0.58 },
  error: { green: 3, red: 14, speed: 0.18 },
  listening: { green: 12, red: 7, speed: 0.55 },
  voice: { green: 8, red: 14, speed: 0.72 },
  scene: { green: 10, red: 10, speed: 0.46 },
  quiet: { green: 3, red: 2, speed: 0.08 },
  welcome: { green: 18, red: 18, speed: 0.42 },
}

export function WindowField({ mode }: { mode: WindowFieldMode }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const audioEnergyRef = useRef(0)

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
    const drawingContext = candidateContext as CanvasRenderingContext2D

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    let width = 0
    let height = 0
    let animationFrame = 0
    let startedAt = performance.now()

    function resize() {
      const bounds = canvasElement.getBoundingClientRect()
      const scale = Math.min(window.devicePixelRatio || 1, 2)
      width = Math.max(1, bounds.width)
      height = Math.max(1, bounds.height)
      canvasElement.width = Math.round(width * scale)
      canvasElement.height = Math.round(height * scale)
      drawingContext.setTransform(scale, 0, 0, scale, 0, 0)
    }

    function strokeField(color: string, baseline: number, amplitude: number, phase: number, reverse = false) {
      drawingContext.beginPath()
      drawingContext.strokeStyle = color
      drawingContext.lineWidth = 1.35
      drawingContext.lineCap = 'round'
      const steps = Math.max(80, Math.floor(width / 8))
      for (let index = 0; index <= steps; index += 1) {
        const ratio = index / steps
        const x = reverse ? width * (1 - ratio) : width * ratio
        const envelope = Math.sin(Math.PI * ratio)
        const wave = Math.sin(ratio * Math.PI * 4.2 + phase) * amplitude
          + Math.sin(ratio * Math.PI * 10.8 - phase * 0.65) * amplitude * 0.22
        const y = baseline + wave * envelope
        if (index === 0) drawingContext.moveTo(x, y)
        else drawingContext.lineTo(x, y)
      }
      drawingContext.stroke()
    }

    function draw(now: number) {
      if (width === 0 || height === 0) resize()
      const energy = MODE_ENERGY[mode]
      const audioBoost = mode === 'listening' ? audioEnergyRef.current * 34 : 0
      const elapsed = reducedMotion ? 0 : (now - startedAt) / 1000
      drawingContext.clearRect(0, 0, width, height)
      strokeField('rgba(77, 140, 67, 0.78)', height * 0.64, energy.green + audioBoost, elapsed * energy.speed)
      strokeField('rgba(194, 78, 72, 0.76)', height * 0.43, energy.red + audioBoost * 0.58, elapsed * energy.speed * 0.86 + 1.7, true)
      if (!reducedMotion) animationFrame = window.requestAnimationFrame(draw)
    }

    const resizeObserver = new ResizeObserver(() => {
      resize()
      if (reducedMotion) draw(performance.now())
    })
    resizeObserver.observe(canvasElement)
    resize()
    startedAt = performance.now()
    draw(startedAt)

    return () => {
      resizeObserver.disconnect()
      window.cancelAnimationFrame(animationFrame)
    }
  }, [mode])

  return <canvas className="d2-window-field" ref={canvasRef} aria-hidden="true" />
}
