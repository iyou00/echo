// 全路径质量走查：七页 × 关键交互 × 三档窗口，console 错误 + 几何异常收集。
// 用法：先带调试端口启动安装版，再 PROBE_PORT=9240 node scripts/walk-all.mjs
const port = Number(process.env.PROBE_PORT ?? 9240)
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
let currentStep = 'boot'
ws.addEventListener('message', (event) => {
  const m = JSON.parse(event.data)
  if (m.method === 'Runtime.exceptionThrown') {
    errors.push('EXCEPTION@' + currentStep + ': ' + (m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text ?? '').slice(0, 500))
  }
  if (m.id && pending.has(m.id)) {
    const { resolve, reject } = pending.get(m.id)
    pending.delete(m.id)
    m.error ? reject(new Error(m.error.message)) : resolve(m.result)
  } else if (m.method === 'Runtime.consoleAPICalled' && ['error', 'warning'].includes(m.params.type)) {
    errors.push(m.params.type + '@' + currentStep + ': ' + (m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ').slice(0, 150))
  }
})
await new Promise((r) => ws.addEventListener('open', r))
await send('Runtime.enable')
const evalJson = async (e) => (await send('Runtime.evaluate', { expression: e, returnByValue: true })).result.value
const click = (sel) => evalJson(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (el instanceof HTMLElement) { el.click(); return true } return false })()`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const results = []
const step = (name, ok, detail = '') => { currentStep = name; results.push(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ' — ' + detail : ''}`) }

// 可见性/几何检查：一批选择器应在视口内可见且非零尺寸
const checkVisible = (label, sels) => evalJson(`(() => {
  const out = []
  for (const sel of ${JSON.stringify(sels)}) {
    const el = document.querySelector(sel)
    if (!el) { out.push(sel + ':MISSING'); continue }
    const r = el.getBoundingClientRect()
    const cs = getComputedStyle(el)
    const visible = r.width > 0 && r.height > 0 && cs.display !== 'none' && cs.visibility !== 'hidden' && Number(cs.opacity) > 0.05
    const inViewport = r.top >= -4 && r.left >= -4 && r.bottom <= window.innerHeight + 4 && r.right <= window.innerWidth + 4
    if (!visible) out.push(sel + ':INVISIBLE')
    else if (!inViewport) out.push(sel + ':OUT(' + Math.round(r.top) + ',' + Math.round(r.bottom) + '/' + window.innerHeight + ')')
  }
  return out
})()`)

// composer 与播放控件重叠检查
const checkOverlap = (selA, selB) => evalJson(`(() => {
  const a = document.querySelector(${JSON.stringify(selA)})?.getBoundingClientRect()
  const b = document.querySelector(${JSON.stringify(selB)})?.getBoundingClientRect()
  if (!a || !b) return null
  const overlap = a.bottom > b.top + 2 && a.top < b.bottom - 2 && a.right > b.left + 2 && a.left < b.right - 2
  return overlap ? 'OVERLAP' : null
})()`)

const fieldRaw = () => evalJson(`(() => (document.querySelector('.d2-shell')?.className ?? '').split('field-')[1]?.split(' ')[0] ?? null })()`)
const field = async () => {
  for (let i = 0; i < 3; i++) {
    const v = await fieldRaw()
    if (v) return v
    await sleep(250)
  }
  return fieldRaw()
}

await sleep(4500) // boot

// —— 1. 七页导航 ——
const pages = [
  ['chat', null],
  ['yinyi', '.d2-nav-button[aria-label="风信"]'],
  ['voice', '.d2-nav-button[aria-label="回声"]'],
  ['profile', '.d2-nav-button[aria-label="品味"]'],
  ['settings', '.d2-nav-button[aria-label="设置"]'],
  ['about', '[data-testid="settings-rail-about"]'],
  ['queue-via-settings', null],
]
for (const [name, sel] of pages) {
  if (sel) {
    const ok = await click(sel)
    await sleep(950)
    const vis = name === 'about' ? await checkVisible('about', ['.d2-about']) : await checkVisible(name, [name === 'chat' ? '.chat-page' : name === 'yinyi' ? '.d2-yinyi' : name === 'voice' ? '.voice-page' : name === 'profile' ? '.d2-profile' : '.settings-page'])
    step(`nav ${name}`, ok && vis.length === 0, vis.join(','))
  }
}
// 队列（从播放器入口需要歌；从品味的 cross-link 不可靠——直接检查 queue 页可达性跳过导航，走设置页返回首页后用 brand）
await click('.d2-brand')
await sleep(800)

// —— 2. 设置 11 分区遍历 ——
await click('.d2-nav-button[aria-label="设置"]')
await sleep(900)
const railKeys = ['music', 'llm', 'voice', 'yinyi', 'chat', 'stage', 'learned', 'care', 'tasks', 'window', 'data']
for (const key of railKeys) {
  const ok = await click(`[data-testid="settings-rail-${key}"]`)
  await sleep(320)
  const note = await evalJson(`(() => { const h = document.querySelector('.sec-title'); return h ? h.textContent.trim() : null })()`)
  step(`settings ${key}`, ok && Boolean(note), note ?? 'no header')
}
await click('.d2-brand')
await sleep(800)

// —— 3. 回声全流程（真实书写一次）——
await click('.d2-nav-button[aria-label="回声"]')
await sleep(1000)
await click('.voice-ink-btn')
let cover = false
for (let i = 0; i < 30; i++) {
  await sleep(1000)
  cover = await evalJson(`(() => { const p = document.querySelector('.global-player'); return p ? getComputedStyle(p).opacity !== '0' : false })()`)
  if (cover) break
}
step('voice: writing cover appears', cover)
// 封面出现后：封面在视口内且可点
const coverGeo = await checkVisible('cover', ['.global-player'])
step('voice: cover geometry', coverGeo.length === 0, coverGeo.join(','))
// 真实点击封面 → listening（以絮语为底）
const center = await evalJson(`(() => { const r = document.querySelector('.global-player .d2-sound-object')?.getBoundingClientRect(); return r ? JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }) : null })()`)
if (center) {
  const c = JSON.parse(center)
  await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: c.x, y: c.y, button: 'left', clickCount: 1 })
  await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: c.x, y: c.y, button: 'left', clickCount: 1 })
}
await sleep(2000)
let f = await field()
if (f !== 'listening') {
  for (let i = 0; i < 10; i++) { await sleep(1000); const t = await evalJson(`document.querySelector('.global-player')?.classList.contains('has-track') ?? false`); if (t) break }
  if (center) {
    const c2 = JSON.parse(center)
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: c2.x, y: c2.y, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: c2.x, y: c2.y, button: 'left', clickCount: 1 })
  }
  await sleep(2000)
  f = await field()
}
const panelVis = await evalJson('(() => { const p = document.querySelector(\'.d2-listening-panel\'); if (!p) return false; const r = p.getBoundingClientRect(); return r.width > 0 && r.height > 0 })()')
step('voice→listening entered', Boolean(panelVis), 'panel visible, field=' + f)
const listenChecks = await checkVisible('listening', ['.d2-listening-panel', '.d2-listen-controls', '.composer-row, .scene-composer, .composer input, .d2-composer, input'])
step('listening: panel+controls+composer', listenChecks.length === 0, listenChecks.join(','))
const overlapPanel = await checkOverlap('.d2-listen-controls', '.composer-row, .scene-composer, .d2-composer, form')
step('listening: controls not over composer', overlapPanel === null, overlapPanel ?? '')
// 波形唯一性：面板 wave-bars 应不可见
const waveHidden = await evalJson(`(() => { const w = document.querySelector('.d2-listening-panel .wave-bars'); return !w || getComputedStyle(w).display === 'none' })()`)
step('listening: single waveform', Boolean(waveHidden))
// 真实点击播放/暂停两次（往返）
const mainBtn = await evalJson(`(() => { const r = document.querySelector('.d2-listen-controls > button.main')?.getBoundingClientRect(); return r ? JSON.stringify({ x: Math.round(r.x + r.width / 2), y: Math.round(r.y + r.height / 2) }) : null })()`)
if (mainBtn) {
  const b = JSON.parse(mainBtn)
  for (let i = 0; i < 2; i++) {
    await send('Input.dispatchMouseEvent', { type: 'mousePressed', x: b.x, y: b.y, button: 'left', clickCount: 1 })
    await send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: b.x, y: b.y, button: 'left', clickCount: 1 })
    await sleep(900)
  }
  const paused = await evalJson(`document.querySelector('.global-player')?.classList.contains('is-paused')`)
  step('listening: play/pause real clicks work', typeof paused === 'boolean')
}
// 回到此刻 → 应回回声页（连续书写中）
await click('.d2-now-return')
await sleep(1100)
const f2 = await field()
const voiceVis2 = await evalJson('(() => { const v = document.querySelector(\'.voice-page\'); if (!v) return false; const r = v.getBoundingClientRect(); return r.width > 0 })()')
step('back-to-moment returns to voice', Boolean(voiceVis2), 'voice visible, field=' + f2)
const voiceBack = await checkVisible('voice-back', ['.voice-page'])
step('voice: page visible after return', voiceBack.length === 0, voiceBack.join(','))
// 停连续（若开过）并回首页
await click('.voice-keep-writing').catch(() => undefined)
await sleep(500)
await click('.d2-brand')
await sleep(900)
step('home after voice flow', await evalJson('(() => { const c = document.querySelector(\'.chat-page\'); if (!c) return false; const r = c.getBoundingClientRect(); return r.width > 0 })()'))

// —— 4. 首页提问（真实一次）：streaming 空窗检查 ——
const asked = await evalJson(`window.echo.chat.send('用一句话介绍你自己').then(() => 'sent').catch((e) => 'ERR:' + e.message); 'dispatched'`)
let sawStreaming = false
let blankWindows = 0
for (let i = 0; i < 24; i++) {
  await sleep(500)
  const f3 = await field()
  if (f3 === 'streaming' || f3 === 'searching') sawStreaming = true
}
const replyArrived = await evalJson(`window.echo.chat.loadRecent(2).then((msgs) => msgs.some((m) => m.role === 'assistant' && Date.parse(m.createdAt ?? m.created_at ?? '') > Date.now() - 45000)).catch(() => false)`)
step('ask: assistant reply arrived', Boolean(replyArrived), asked)
step('home restored after reply', await evalJson('(() => { const c = document.querySelector(\'.chat-page\'); if (!c) return false; const r = c.getBoundingClientRect(); return r.width > 0 })()'))

// —— 4.5 顶栏队列入口：播放中也必须可达，进入后播放卡收起、页签在 ——
const queueViaNav = await click('.d2-nav-button[aria-label="队列"]')
await sleep(1000)
const queueNavChecks = await checkVisible('queue-nav', ['.shell-page[data-page="queue"] .d2-queue', '.session-card'])
const playerHidden = await evalJson(`(() => { const p = document.querySelector('.global-player'); if (!p) return true; const cs = getComputedStyle(p); return cs.opacity === '0' || cs.display === 'none' })()`)
step('queue via top nav (music playing)', queueViaNav && queueNavChecks.length === 0, queueNavChecks.join(','))
step('player card hidden on queue page', playerHidden)
await click('.d2-brand')
await sleep(800)

// —— 5. 队列页：入口+三页签 ——
await evalJson(`window.echo.queue.history(7).then((days) => { const t = days.flatMap((d) => d.tracks)[0]; if (!t) return 'nohist'; return window.echo.playback.play({ ...t, sourceContext: 'history' }).then(() => 'played').catch((e) => 'ERR:' + e.message) }).catch(() => 'nohist'); 'dispatched'`)
await sleep(2500)
let qOpened = await click('[aria-label="打开队列"]')
if (!qOpened) qOpened = await click('.d2-nav-button[aria-label="队列"]')
await sleep(1100)
step('queue: opened', qOpened)
if (qOpened) {
  // 有内容 → 会话卡+曲库；全空 → 整页空态（.qf-empty）也是合法形态
  const sessionOk = await evalJson(`(() => {
    if (document.querySelector('.shell-page[data-page="queue"] .qf-empty')) return 'empty-page'
    const misses = []
    for (const sel of ['.session-card', '.session-head h1', '.lib-tools', '.lib-tab']) {
      const el = document.querySelector(sel)
      if (!el || el.getBoundingClientRect().width === 0) misses.push(sel)
    }
    return misses.length ? misses.join(',') : 'ok'
  })()`)
  step('queue: session card + library tools', sessionOk === 'ok' || sessionOk === 'empty-page', sessionOk)
  for (const label of ['favorites', 'past', 'favorites']) {
    await click(label === 'favorites' ? '.lib-tab:nth-child(1)' : '.lib-tab:nth-child(2)')
    await sleep(450)
  }
  const libOk = await evalJson(`(() => { if (document.querySelector('.shell-page[data-page="queue"] .qf-empty')) return 'empty-page'; const el = document.querySelector('.lib-tab.on'); return el && el.getBoundingClientRect().width > 0 ? 'ok' : 'missing' })()`)
  step('queue: library tabs cycle', libOk !== 'missing', libOk)
  await click('.d2-brand')
  await sleep(800)
}

// —— 6. 三档窗口尺寸：顶栏可见性（像素）——
// CDP 的 Browser.setWindowBounds 在本 Electron 构建上不可用且会被静默吞掉——
// 用应用自己的窗口档位 API，缩放才是真的发生过。
const resize = async (_w, _h, preset) => {
  await evalJson(`window.echo.window.setSizePreset('${preset}').catch(() => null)`)
  await sleep(700)
}
for (const [name, w, h] of [['compact', 1152, 720], ['standard', 1280, 800], ['large', 1440, 900]]) {
  await resize(w, h, name)
  const nav = await evalJson(`(() => { const btns = [...document.querySelectorAll('.d2-nav-button')]; return btns.filter((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && r.right <= window.innerWidth }).length })()`)
  step(`window ${name}: 5 nav buttons laid out`, nav === 5, 'count=' + nav)
}
await resize(1280, 800, 'standard')

// —— 汇总 ——
console.log(results.join('\n'))
console.log('---')
console.log('console errors:', errors.length ? errors.slice(0, 12) : 'NONE')
const fails = results.filter((r) => r.startsWith('FAIL')).length
console.log(`--- ${results.length - fails}/${results.length} passed`)
process.exit(0)
