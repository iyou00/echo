// 播放页（一起听）专项走查：全控件真实点击 + 几何/重叠矩阵 + 跳页路径，两档窗口。
const port = Number(process.env.PROBE_PORT ?? 9241)
const list = await (await (await fetch(`http://127.0.0.1:${port}/json`)).json())
const page = list.find((t) => t.type === 'page')
if (!page) { console.log('NO-PAGE'); process.exit(1) }
const ws = new WebSocket(page.webSocketDebuggerUrl)
let seq = 0
const pending = new Map()
const errors = []
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
  } else if (m.method === 'Runtime.consoleAPICalled' && m.params.type === 'error') {
    errors.push('console: ' + (m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 140))
  } else if (m.method === 'Runtime.exceptionThrown') {
    errors.push('EXCEPTION: ' + (m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text ?? '').slice(0, 300))
  }
})
await new Promise((r) => ws.addEventListener('open', r))
await send('Runtime.enable')
const evalJson = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true, awaitPromise: true })).result.value
const click = (sel) => evalJson(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (el instanceof HTMLElement) { el.click(); return true } return false })()`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const step = (name, ok, detail = '') => results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`)
const realClick = async (sel) => {
  const pos = await evalJson(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (!el) return null; const r = el.getBoundingClientRect(); return JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }) })()`)
  if (!pos) return false
  const c = JSON.parse(pos)
  await send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: c.x, y: c.y })
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: c.x, y: c.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: c.x, y: c.y, button: 'left', clickCount: 1 })
  return true
}
const state = () => evalJson(`window.echo.playback.getState().catch(() => null)`)
const rects = (sels) => evalJson(`(() => {
  const out = {}
  for (const [k, sel] of ${JSON.stringify(Object.entries(sels))}) {
    const el = document.querySelector(sel)
    if (!el) { out[k] = null; continue }
    const r = el.getBoundingClientRect()
    out[k] = el.getBoundingClientRect().width === 0 ? null : { t: Math.round(r.top), b: Math.round(r.bottom), l: Math.round(r.left), rr: Math.round(r.right) }
  }
  return out
})()`)
const overlap = (a, b) => a && b && a.b > b.t + 3 && a.t < b.b - 3 && a.rr > b.l + 3 && a.l < b.rr - 3
const inViewport = (a, w, h) => a && a.t >= -4 && a.l >= -4 && a.b <= h + 4 && a.rr <= w + 4

await sleep(4000)
// 起一首歌并进入 listening（从首页）
await evalJson(`window.echo.queue.history(7).then(async (days) => { const tracks = days.flatMap((d) => d.tracks).filter(Boolean); window.__tracks = tracks; if (tracks[1]) await window.echo.playback.enqueue(tracks[1]).catch(() => null); if (tracks[0]) await window.echo.playback.play({ ...tracks[0], sourceContext: 'history' }); return 'ok' }).catch(() => null); 'ok'`)
await sleep(2600)
await realClick('.global-player .d2-sound-object')
await sleep(2000)
let panelOn = await evalJson(`(() => { const p = document.querySelector('.d2-listening-panel'); return p ? p.getBoundingClientRect().width > 0 : false })()`)
if (!panelOn) {
  for (let i = 0; i < 8; i++) { await sleep(1000); if (await evalJson(`document.querySelector('.global-player')?.classList.contains('has-track')`)) break }
  await realClick('.global-player .d2-sound-object')
  await sleep(2000)
  panelOn = await evalJson(`(() => { const p = document.querySelector('.d2-listening-panel'); return p ? p.getBoundingClientRect().width > 0 : false })()`)
}
step('enter listening', panelOn)

for (const [win, expectW, expectH] of [['compact', 1152, 720], ['standard', 1280, 800]]) {
  await evalJson(`window.echo.window.setSizePreset('${win}').catch(() => null)`); await sleep(900)
  const g = await rects({
    card: '.global-player',
    panel: '.d2-listening-panel',
    controls: '.d2-listen-controls',
    prev: '.d2-listen-controls > button:not(.main)',
    main: '.d2-listen-controls > button.main',
    next: '.d2-listen-controls > button:nth-child(3)',
    progress: '.d2-listen-controls .seg-track',
    statusLine: '.d2-listen-status-line',
    volume: '.d2-listen-volume input',
    composer: '.composer.scene-composer',
    returnBtn: '.d2-now-return',
    topbar: '.d2-topbar',
  })
  const vw = await evalJson('window.innerWidth'), vh = await evalJson('window.innerHeight')
  for (const k of Object.keys(g)) step(`${win}: ${k} in viewport`, inViewport(g[k], vw, vh), g[k] ? JSON.stringify(g[k]) : 'missing')
  step(`${win}: controls not over composer`, !overlap(g.controls, g.composer))
  step(`${win}: status line not over composer`, !overlap(g.statusLine, g.composer))
  step(`${win}: volume not over composer`, !overlap(g.volume, g.composer))
  step(`${win}: card not over composer`, !overlap(g.card, g.composer))
  step(`${win}: return btn sits in card top zone`, Boolean(g.returnBtn) && g.returnBtn.t >= (g.card?.t ?? 0) && g.returnBtn.b <= (g.card?.t ?? 0) + 80)
}
// 回 standard，真实点击全部控件
await evalJson(`window.echo.window.setSizePreset('standard').catch(() => null)`); await sleep(900)

// 播放/暂停（两次往返）
const pausedBefore = await evalJson(`document.querySelector('.global-player')?.classList.contains('is-paused')`)
await realClick('.d2-listen-controls > button.main'); await sleep(900)
const pausedMid = await evalJson(`document.querySelector('.global-player')?.classList.contains('is-paused')`)
await realClick('.d2-listen-controls > button.main'); await sleep(900)
const pausedAfter = await evalJson(`document.querySelector('.global-player')?.classList.contains('is-paused')`)
step('play/pause real clicks toggle', pausedBefore !== pausedMid && pausedMid !== pausedAfter, `${pausedBefore}->${pausedMid}->${pausedAfter}`)

// 下一曲
const before = await state()
const queueLen = (before?.queue ?? []).length
const nextDisabled = await evalJson(`document.querySelector('.d2-listen-controls > button:nth-child(3)')?.disabled ?? null`)
await realClick('.d2-listen-controls > button:nth-child(3)'); await sleep(1800)
const afterNext = await state()
if (queueLen >= 2 && !nextDisabled) {
  step('next real click changes track', Boolean(afterNext?.current) && afterNext.current?.title !== before?.current?.title, `${before?.current?.title} → ${afterNext?.current?.title}`)
} else {
  step('next disabled on single-track queue', nextDisabled === true, `queue=${queueLen} disabled=${nextDisabled}`)
}

// 进度条 seek（点右侧 75%）
const seekPos = await evalJson(`(() => { const r = document.querySelector('.d2-listen-controls .seg-track')?.getBoundingClientRect(); return r ? JSON.stringify({ x: Math.round(r.x + r.width * 0.75), y: Math.round(r.y + r.height / 2) }) : null })()`)
if (seekPos) {
  const c = JSON.parse(seekPos)
  const posBefore = (await state())?.position ?? 0
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: c.x, y: c.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: c.x, y: c.y, button: 'left', clickCount: 1 })
  await sleep(1200)
  const posAfter = (await state())?.position ?? 0
  step('progress real click seeks', posAfter > posBefore + 5000, `${Math.round(posBefore / 1000)}s → ${Math.round(posAfter / 1000)}s`)
}

// 跳页路径：listening → 打开队列（卡上的按钮）
const queueBtn = await realClick('[aria-label="打开队列"]')
await sleep(1300)
const queueVisible = await evalJson(`(() => { const q = document.querySelector('.shell-page[data-page="queue"] .d2-queue'); return q ? q.getBoundingClientRect().width > 0 : false })()`)
const panelStill = await evalJson(`(() => { const p = document.querySelector('.d2-listening-panel'); return p ? p.getBoundingClientRect().width > 0 : false })()`)
step('queue from listening opens queue page', queueVisible && queueBtn)
step('listening overlay hides on queue page', !panelStill, panelStill ? 'panel still visible over queue' : '')
await click('.d2-brand'); await sleep(900)

// 尾段：回首页 → 再进 listening → 回到此刻 → 首页恢复
await click('.d2-brand'); await sleep(900)
let back = await evalJson(`(() => { const b = document.querySelector('.d2-now-return'); return b ? b.getBoundingClientRect().width > 0 : false })()`)
if (!back) { await realClick('.global-player .d2-sound-object'); await sleep(1600); back = await evalJson(`(() => { const b = document.querySelector('.d2-now-return'); return b ? b.getBoundingClientRect().width > 0 : false })()`) }
if (back) { await realClick('.d2-now-return'); await sleep(1200) }
const homeOk = await evalJson(`(() => { const c = document.querySelector('.chat-page'); return c ? c.getBoundingClientRect().width > 0 : false })()`)
const panelGone = await evalJson(`(() => { const p = document.querySelector('.d2-listening-panel'); return p ? p.getBoundingClientRect().width > 0 : false })()`)
// 输入区可点性：面板区域不再吞掉 composer 点击（pointer-events 穿透）
const composerClickable = await evalJson(`(() => { const c = document.querySelector('.composer.scene-composer'); if (!c) return null; const r = c.getBoundingClientRect(); const el = document.elementFromPoint(Math.round(r.x + r.width / 2), Math.round(r.y + r.height / 2)); return el ? (c.contains(el) || c === el) : false })()`)
step('back-to-moment restores home', homeOk && !panelGone)
step('composer clickable through panel zone', composerClickable === true, 'hit=' + composerClickable)

console.log(results.join('\n'))
console.log('---')
console.log('errors:', errors.length ? errors.slice(0, 10) : 'NONE')
const fails = results.filter((r) => r.startsWith('FAIL')).length
console.log(`--- ${results.length - fails}/${results.length} passed`)
process.exit(0)
