// 复现「回声 → 点封面 → 播放视图」：真实书写一次，点封面进入，量几何+截图。
const port = 9234
const list = await (await (await fetch(`http://127.0.0.1:${port}/json`)).json())
const page = list.find((t) => t.type === 'page')
if (!page) { console.log('NO-PAGE'); process.exit(1) }
const ws = new WebSocket(page.webSocketDebuggerUrl)
let seq = 0
const pending = new Map()
function send(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++seq
    pending.set(id, { resolve, reject })
    ws.send(JSON.stringify({ id, method, params }))
  })
}
ws.addEventListener('message', (event) => {
  const m = JSON.parse(event.data)
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id)
    pending.delete(m.id)
    m.error ? reject(new Error(m.error.message)) : resolve(m.result)
  }
})
await new Promise((r) => ws.addEventListener('open', r))
await send('Runtime.enable')
await send('Page.enable')
const evalJson = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true })).result.value
const click = (sel) => evalJson(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (el instanceof HTMLElement) { el.click(); return true } return false })()`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

await sleep(1500)
// 1. 进回声，点「赏歌一曲」触发真实书写
await click('.d2-nav-button[aria-label="回声"]')
await sleep(1000)
const started = await click('.voice-ink-btn')
console.log('ink-btn clicked:', started)
// 等书写开始（封面出现）
let coverVisible = false
for (let i = 0; i < 26; i++) {
  await sleep(1000)
  coverVisible = await evalJson(`(() => { const p = document.querySelector('.global-player'); return p ? getComputedStyle(p).opacity !== '0' : false })()`)
  if (coverVisible) break
}
console.log('cover visible:', coverVisible)
if (!coverVisible) {
  console.log('status:', await evalJson(`document.querySelector('.voice-status-pill')?.textContent ?? null`))
  process.exit(0)
}
// 2. 真实鼠标点击封面卡中心（用户路径，走完整命中测试）
const center = await evalJson(`(() => { const r = document.querySelector('.global-player .d2-sound-object')?.getBoundingClientRect(); return r ? JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }) : null })()`)
console.log('card center:', center)
const realClick = async () => {
  const pos = await evalJson(`(() => { const r = document.querySelector('.global-player .d2-sound-object')?.getBoundingClientRect(); return r ? JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }) : null })()`)
  if (!pos) return false
  const c = JSON.parse(pos)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: c.x, y: c.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: c.x, y: c.y, button: 'left', clickCount: 1 })
  return true
}
if (center) await realClick()
await sleep(1800)
// 歌未接上时展开条件不满足——等有歌后重试一次
let fieldNow = await evalJson(`(() => (document.querySelector('.d2-shell')?.className ?? '').split('field-')[1]?.split(' ')[0] ?? null })()`)
if (fieldNow !== 'listening') {
  for (let i = 0; i < 10; i++) {
    await sleep(1000)
    const hasTrack = await evalJson(`document.querySelector('.global-player')?.classList.contains('has-track') ?? false`)
    if (hasTrack) break
  }
  await realClick()
  await sleep(1800)
}
const snap = await evalJson(`(() => {
  const field = (document.querySelector('.d2-shell')?.className ?? '').split('field-')[1]?.split(' ')[0] ?? null
  const layer = document.querySelector('.d2-player-layer')?.className ?? ''
  const panel = document.querySelector('.d2-listening-panel')
  const controls = document.querySelector('.d2-listen-controls')
  const composer = document.querySelector('.composer-row, .scene-composer input, .d2-composer')
  const wavebars = document.querySelectorAll('.wave-bars').length
  const voicePage = document.querySelector('.voice-page')
  const chatPage = document.querySelector('.chat-page')
  const pr = panel?.getBoundingClientRect()
  const cr = controls?.getBoundingClientRect()
  const card = document.querySelector('.global-player')?.getBoundingClientRect()
  return JSON.stringify({
    field, layer: layer.slice(0, 55),
    panelRect: pr ? { top: Math.round(pr.top), bottom: Math.round(pr.bottom) } : null,
    controlsRect: cr ? { top: Math.round(cr.top), bottom: Math.round(cr.bottom) } : null,
    cardRect: card ? { top: Math.round(card.top), h: Math.round(card.height) } : null,
    waveBarsCount: wavebars,
    composerVisible: composer ? composer.getBoundingClientRect().width > 0 : false,
    voicePageVisible: voicePage ? voicePage.getBoundingClientRect().width > 0 : false,
    chatPageVisible: chatPage ? chatPage.getBoundingClientRect().width > 0 : false,
  })
})()`)
console.log(snap)
const shot = await send('Page.captureScreenshot', { format: 'png' })
const fs = await import('node:fs')
fs.writeFileSync('artifacts/live-fullpage/live-voice-to-listening.png', Buffer.from(shot.data, 'base64'))
console.log('captured')
process.exit(0)
