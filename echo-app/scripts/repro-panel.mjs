// 复现一起听面板长文案遮盖：从收藏放一首进入 listening，注入长文案，量几何。
const port = Number(process.env.PROBE_PORT ?? 9232)
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
const evalJson = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true })).result.value
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

await sleep(1200)
const played = await evalJson(`window.echo.favorites.list().then(([t]) => t ? window.echo.playback.play(t) : 'nofav').catch((e) => 'ERR:' + e.message); 'sent'`)
console.log('play:', played)
const coverClick = await evalJson(`(() => { const el = document.querySelector('.d2-sound-art'); if (el instanceof HTMLElement) { el.click(); return true } return false })()`)
console.log('cover click:', coverClick)
let field = null
for (let i = 0; i < 16; i++) {
  await sleep(1000)
  field = await evalJson(`document.querySelector('.d2-shell')?.className.match(/field-(\\w+)/)?.[1] ?? null`)
  if (field === 'listening') break
}
console.log('field:', field)
if (field !== 'listening') process.exit(0)

await evalJson(`(() => {
  const h2 = document.querySelector('.d2-listening-panel h2')
  if (!h2) return 'no-h2'
  h2.innerHTML = ''
  for (let i = 1; i <= 12; i++) {
    const span = document.createElement('span')
    span.className = 'd2-narration-line'
    span.textContent = '第' + i + '行测试文案——山谷醒得慢，雾比歌先到，这句用来撑高度看遮盖。'
    h2.appendChild(span)
  }
  return 'injected'
})()`)
await sleep(600)
console.log(JSON.stringify(await evalJson(`(() => {
  const panel = document.querySelector('.d2-listening-panel')
  const h2 = panel?.querySelector('h2')
  const p = panel?.querySelector('p')
  const controls = document.querySelector('.d2-listen-controls')
  const h2r = h2?.getBoundingClientRect()
  const cr = controls?.getBoundingClientRect()
  const pr = panel?.getBoundingClientRect()
  const cs = h2 ? getComputedStyle(h2) : null
  return {
    panel: pr ? { top: Math.round(pr.top), bottom: Math.round(pr.bottom), h: Math.round(pr.height) } : null,
    h2: h2r ? { top: Math.round(h2r.top), bottom: Math.round(h2r.bottom), h: Math.round(h2r.height), scrollH: h2?.scrollHeight ?? null } : null,
    h2Style: cs ? { display: cs.display, clamp: cs.webkitLineClamp, overflow: cs.overflow, flexShrink: cs.flexShrink } : null,
    controls: cr ? { top: Math.round(cr.top), bottom: Math.round(cr.bottom) } : null,
    h2PastControlsBy: h2r && cr ? Math.round(h2r.bottom - cr.top) : null,
  }
})()`), null, 1))
process.exit(0)
