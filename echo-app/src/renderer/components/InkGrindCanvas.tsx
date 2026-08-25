import { useEffect, useRef } from 'react'
import { AUDIO_ENERGY_EVENT, type AudioEnergyDetail } from '../audioAnalysis'

/**
 * 研墨动画：Canvas 2D 上的 metaball 墨滴 + FBM 噪声扩散。
 * 墨锭沿砚池做圆周研磨，接触点持续释放墨滴粒子；
 * 粒子受布朗运动 + FBM 流场驱动，在水面融合、分离、晕开。
 * 语音能量注入速度场——说话时墨被搅动得更散。
 *
 * 纯 Canvas 2D，无需 GPU 加速，软件渲染下 60fps。
 */

interface InkDrop {
  x: number
  y: number
  vx: number
  vy: number
  r: number        // 半径（用于 metaball 阈值场）
  density: number  // 0-1，影响颜色深浅
  age: number      // 帧数
}

interface StickState {
  angle: number       // 研磨角度（弧度）
  radius: number      // 距砚池中心的距离
  speed: number       // 角速度
  tilt: number        // 墨锭倾斜角
}

// 简易 FBM（2 octave 就够——性能优先）
function fbm(x: number, y: number, t: number): number {
  const n1 = Math.sin(x * 1.7 + t * 0.3) * Math.cos(y * 1.3 - t * 0.2)
  const n2 = Math.sin(x * 3.1 - t * 0.4 + 1.3) * Math.cos(y * 2.7 + t * 0.5 + 2.1)
  return (n1 * 0.6 + n2 * 0.4) * 0.5 + 0.5
}

// metaball 阈值场：多个墨滴的引力叠加
function metaballField(drops: InkDrop[], px: number, py: number): number {
  let sum = 0
  for (const drop of drops) {
    const dx = px - drop.x
    const dy = py - drop.y
    const distSq = dx * dx + dy * dy
    sum += (drop.r * drop.r) / (distSq + 1)
  }
  return sum
}

export function InkGrindCanvas({ width = 300, height = 96 }: { width?: number; height?: number }) {
  const canvasRef = useRef<HTMLCanvasElement | null>(null)
  const energyRef = useRef(0.06)
  const dropsRef = useRef<InkDrop[]>([])
  const stickRef = useRef<StickState>({ angle: 0, radius: 0.55, speed: 0.045, tilt: 0 })
  const frameRef = useRef(0)

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

    const g = ctx // non-null alias for closure
    const reducedMotion = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const cx = width / 2
    const cy = height * 0.75
    const poolRx = width * 0.36
    const poolRy = height * 0.12

    const dpr = Math.min(window.devicePixelRatio || 1, 2)
    canvas.width = width * dpr
    canvas.height = height * dpr
    ctx.scale(dpr, dpr)

    let raf = 0
    const GRID = 4 // metaball 采样步长（像素），越小越平滑

    function tick() {
      const t = frameRef.current++
      const energy = reducedMotion ? 0 : energyRef.current
      const stick = stickRef.current
      const drops = dropsRef.current

      // --- 墨锭圆周运动 ---
      if (!reducedMotion) {
        stick.angle += stick.speed * (1 + energy * 2.5)
        stick.tilt = Math.sin(stick.angle * 2) * 0.15
      }
      const stickX = cx + Math.cos(stick.angle) * poolRx * stick.radius
      const stickY = cy + Math.sin(stick.angle) * poolRy * stick.radius - 6

      // --- 释放墨滴（研磨动作持续释墨） ---
      if (!reducedMotion && t % 6 === 0 && drops.length < 90) {
        const spread = 1 + energy * 4
        drops.push({
          x: stickX + (Math.random() - 0.5) * 3,
          y: stickY + (Math.random() - 0.5) * 2,
          vx: (Math.random() - 0.5) * 0.3 * spread,
          vy: (Math.random() - 0.5) * 0.15 * spread,
          r: 4 + Math.random() * 5,
          density: 0.15 + Math.min(0.6, t * 0.001),
          age: 0,
        })
      }

      // --- 粒子物理：布朗运动 + FBM 流场 + 重力 ---
      if (!reducedMotion) {
        for (const drop of drops) {
          drop.age++
          const flowAngle = fbm(drop.x * 0.01, drop.y * 0.02, t * 0.02) * Math.PI * 2
          const flowForce = 0.02 + energy * 0.12
          drop.vx += Math.cos(flowAngle) * flowForce
          drop.vy += Math.sin(flowAngle) * flowForce * 0.4 + 0.005 // 微重力（墨下沉）
          // 阻尼
          drop.vx *= 0.96
          drop.vy *= 0.96
          drop.x += drop.vx
          drop.y += drop.vy
          // 边界约束：不能跑出砚池
          const dx = (drop.x - cx) / poolRx
          const dy = (drop.y - cy) / poolRy
          const dist = Math.sqrt(dx * dx + dy * dy)
          if (dist > 0.92) {
            drop.vx -= dx * 0.08
            drop.vy -= dy * 0.08
          }
          // 墨滴随时间扩散变大、密度变淡
          if (drop.age % 30 === 0) {
            drop.r = Math.min(drop.r + 0.5, 14)
            drop.density *= 0.995
          }
        }
        // 移除过老的墨滴（墨已融入水中）
        for (let i = drops.length - 1; i >= 0; i--) {
          if (drops[i].density < 0.03) drops.splice(i, 1)
        }
      }

      // --- 渲染 ---
      g.clearRect(0, 0, width, height)

      // 1. 砚池细线
      g.strokeStyle = '#c8cec7'
      g.lineWidth = 1
      g.beginPath()
      g.ellipse(cx, cy, poolRx, poolRy, 0, 0, Math.PI * 2)
      g.stroke()

      // 2. Metaball 墨色场（用低分辨率 imageData + 放大渲染）
      const mw = Math.ceil(width / GRID)
      const mh = Math.ceil(height / GRID)
      const imgData = g.createImageData(mw, mh)
      const threshold = 0.55

      for (let my = 0; my < mh; my++) {
        for (let mx = 0; mx < mw; mx++) {
          const px = mx * GRID
          const py = my * GRID
          const field = metaballField(drops, px, py)
          if (field > threshold * 0.3) {
            const idx = (my * mw + mx) * 4
            const intensity = Math.min(1, (field - threshold * 0.3) / (threshold * 0.7))
            // 墨色：带一点透明度的深墨绿
            const alpha = Math.floor(30 + intensity * 80)
            imgData.data[idx] = 25 // R
            imgData.data[idx + 1] = 32 // G
            imgData.data[idx + 2] = 27 // B
            imgData.data[idx + 3] = alpha
          }
        }
      }

      // 放大绘制到主画布
      const tempCanvas = document.createElement('canvas')
      tempCanvas.width = mw
      tempCanvas.height = mh
      const tempCtx = tempCanvas.getContext('2d')
      if (tempCtx) {
        tempCtx.putImageData(imgData, 0, 0)
        g.save()
        g.imageSmoothingEnabled = true
        g.globalAlpha = 0.7
        g.drawImage(tempCanvas, 0, 0, mw, mh, 0, 0, width, height)
        g.restore()
      }

      // 3. 墨锭
      g.save()
      g.translate(stickX, stickY - 14)
      g.rotate(stick.tilt)
      g.fillStyle = '#19201b'
      g.beginPath()
      g.roundRect(-2.5, 0, 5, 22, 2)
      g.fill()
      // 红色笔尖
      g.fillStyle = '#e45036'
      g.beginPath()
      g.roundRect(-2.5, 18, 5, 4, 2)
      g.fill()
      g.restore()

      // 4. 研磨接触点的红色微光（能量越高越亮）
      if (energy > 0.08) {
        const glow = g.createRadialGradient(stickX, stickY, 0, stickX, stickY, 8 + energy * 12)
        glow.addColorStop(0, `rgba(228,80,54,${0.2 + energy * 0.3})`)
        glow.addColorStop(1, 'rgba(228,80,54,0)')
        g.fillStyle = glow
        g.beginPath()
        g.arc(stickX, stickY, 8 + energy * 12, 0, Math.PI * 2)
        g.fill()
      }

      if (!reducedMotion) raf = requestAnimationFrame(tick)
    }

    tick()

    return () => {
      cancelAnimationFrame(raf)
    }
  }, [width, height])

  return <canvas ref={canvasRef} className="ink-grind-canvas" style={{ width, height }} />
}
