import { useEffect, useRef } from 'react'
import { AUDIO_ENERGY_EVENT, type AudioEnergyDetail } from '../audioAnalysis'

/**
 * 研墨动画：墨迹累积画布。
 * 每帧在墨锭位置画一个极淡的墨晕，不清屏——墨随研磨自然累积变浓。
 * 轨道画过的地方墨越来越浓，没画过的地方保持清澈。
 * 语音能量注入扩散半径和沉淀速度。
 */

export function InkGrindCanvas({ width = 300, height = 96 }: { width?: number; height?: number }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const energyRef = useRef(0.06)

  useEffect(() => {
    const updateEnergy = (event: Event) => {
      energyRef.current = (event as CustomEvent<AudioEnergyDetail>).detail?.energy ?? 0
    }
    window.addEventListener(AUDIO_ENERGY_EVENT, updateEnergy)
    return () => window.removeEventListener(AUDIO_ENERGY_EVENT, updateEnergy)
  }, [])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const ctx = canvas.getContext('2d')
    if (!ctx) return

    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const cx = width / 2
    const cy = height * 0.75
    const poolRx = width * 0.36
    const poolRy = height * 0.11

    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = width * dpr
    canvas.height = height * dpr
    ctx.scale(dpr, dpr)

    const g = ctx
    let raf = 0
    let angle = 0
    let frame = 0

    function tick() {
      frame++
      const energy = energyRef.current

      // 墨锭圆周运动
      if (!reducedMotion) angle += 0.035 + energy * 0.06
      const stickX = cx + Math.cos(angle) * poolRx * 0.5
      const stickY = cy + Math.sin(angle) * poolRy * 0.5 - 4
      const tilt = Math.sin(angle * 2) * 0.12

      // ——— 核心：墨迹累积（不清屏） ———
      // 每帧在墨锭位置画一个极淡的径向墨晕
      // 语音能量增大半径和浓度
      const blobR = 7 + energy * 8 + Math.min(6, frame * 0.008)
      const blobAlpha = 0.015 + energy * 0.02
      const blob = g.createRadialGradient(stickX, stickY, 0, stickX, stickY, blobR)
      blob.addColorStop(0, `rgba(25, 32, 27, ${blobAlpha})`)
      blob.addColorStop(0.6, `rgba(25, 32, 27, ${blobAlpha * 0.5})`)
      blob.addColorStop(1, 'rgba(25, 32, 27, 0)')
      g.fillStyle = blob
      g.beginPath()
      g.arc(stickX, stickY, blobR, 0, Math.PI * 2)
      g.fill()

      // 轻微扩散：每隔几帧用 destination-out 擦掉一点边缘
      // 模拟墨在水中的自然扩散（把浓的地方推向淡的地方）
      if (!reducedMotion && frame % 20 === 0) {
        g.save()
        g.globalCompositeOperation = 'destination-out'
        g.fillStyle = 'rgba(0, 0, 0, 0.008)'
        g.beginPath()
        g.ellipse(cx, cy, poolRx * 0.98, poolRy * 0.98, 0, 0, Math.PI * 2)
        g.fill()
        g.restore()
      }

      // ——— 墨锭（清掉自身区域再画，保证锭不被墨迹遮盖） ———
      g.save()
      g.globalCompositeOperation = 'destination-out'
      g.fillStyle = 'rgba(0,0,0,0.9)'
      g.beginPath()
      g.arc(stickX, stickY - 10, 14, 0, Math.PI * 2)
      g.fill()
      g.restore()

      // 画墨锭
      g.save()
      g.translate(stickX, stickY - 14)
      g.rotate(tilt)
      g.fillStyle = '#19201b'
      g.beginPath()
      g.roundRect(-2.5, 0, 5, 22, 2)
      g.fill()
      g.fillStyle = '#e45036'
      g.beginPath()
      g.roundRect(-2.5, 18, 5, 4, 2)
      g.fill()
      g.restore()

      // 砚池细线（最上层，始终可见）
      g.strokeStyle = '#c8cec7'
      g.lineWidth = 0.8
      g.beginPath()
      g.ellipse(cx, cy, poolRx, poolRy, 0, 0, Math.PI * 2)
      g.stroke()

      if (!reducedMotion) raf = requestAnimationFrame(tick)
    }

    tick()

    return () => cancelAnimationFrame(raf)
  }, [width, height])

  return <canvas ref={canvasRef} className="ink-grind-canvas" style={{ width, height }} />
}
