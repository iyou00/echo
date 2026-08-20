// 回声页返回流走查：开连续 → 回首页（field 应回 chat）→ 再进回声（voice）。
const port = Number(process.env.PROBE_PORT ?? 9233)
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
const click = (sel) => evalJson(`(() => { const el = document.querySelector(${JSON.stringify(sel)}); if (el instanceof HTMLElement) { el.click(); return true } return false })()`)
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
const field = () => evalJson(`(() => { const c = document.querySelector('.d2-shell')?.className ?? ''; const hit = c.split('field-')[1]; return hit ? hit.split(' ')[0] : null })()`)

await sleep(1500)
await click('.d2-nav-button[aria-label="回声"]')
await sleep(1000)
console.log('1. enter voice, field:', await field(), '(expect voice)')
// 连续开关：keep-writing 在待写页与书写页都存在；仅在待写页点它（会触发一次真实书写）
const opened = await click('.voice-keep-writing')
await sleep(1200)
console.log('2. continuous clicked:', opened)
await click('.d2-brand')
await sleep(1000)
const homeField = await field()
console.log('3. back home, field:', homeField, homeField === 'chat' ? 'PASS' : 'FAIL')
await click('.d2-nav-button[aria-label="回声"]')
await sleep(900)
console.log('4. re-enter voice, field:', await field(), '(expect voice)')
process.exit(0)
