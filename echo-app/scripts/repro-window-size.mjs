// 复现「窗口与关闭」多次切换尺寸失效：连续点击档位，逐步记录窗口 bounds 与激活态。
import { spawn } from 'node:child_process'

const exe = process.env.ECHO_EXE ?? 'C:\\Users\\Max\\AppData\\Local\\Programs\\Echo\\Echo.exe'
const port = Number(process.env.ECHO_DEBUG_PORT ?? 9225)
const app = spawn(exe, [`--remote-debugging-port=${port}`], { stdio: 'ignore' })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let page = null
for (let i = 0; i < 40; i++) {
  await sleep(500)
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
    page = list.find((t) => t.type === 'page')
    if (page) break
  } catch { /* retry */ }
}
if (!page) { app.kill(); throw new Error('no CDP page target') }

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

const evalJson = async (expression) => {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true })
  return result.result.value
}
const bounds = async () => {
  const result = await send('Runtime.evaluate', { expression: `window.outerWidth + 'x' + window.outerHeight + ' inner:' + window.innerWidth + 'x' + window.innerHeight + ' dpr:' + window.devicePixelRatio`, returnByValue: true })
  return result.result.value
}

await sleep(3500)
await evalJson(`(() => { document.querySelector('.d2-nav-button[aria-label="设置"]')?.click(); return true })()`)
await sleep(900)
await evalJson(`(() => { document.querySelector('[data-testid="settings-rail-window"]')?.click(); return true })()`)
await sleep(600)

const sequence = ['compact', 'standard', 'large', 'compact', 'standard', 'compact', 'large', 'standard', 'compact']
console.log('screen:', await evalJson(`JSON.stringify({ w: screen.width, h: screen.height, aw: screen.availWidth, ah: screen.availHeight })`))
console.log('start bounds:', await bounds())
for (const preset of sequence) {
  const clicked = await evalJson(`(() => {
    const buttons = [...document.querySelectorAll('.window-size-options .window-size-option')]
    const hit = buttons.find((b) => b.textContent.includes(${'`'}${preset === 'compact' ? '小号' : preset === 'standard' ? '标准' : '大号'}${'`'}))
    if (hit instanceof HTMLElement) { hit.click(); return true }
    return false
  })()`)
  await sleep(700)
  const state = await evalJson(`(() => {
    const active = document.querySelector('.window-size-options .window-size-option.active')
    const busy = [...document.querySelectorAll('.window-size-option')].every((b) => !b.disabled)
    const status = document.querySelector('.window-size-note')
    return JSON.stringify({ active: active ? active.textContent.slice(0, 6) : null, buttonsEnabled: busy })
  })()`)
  console.log(`click ${preset}: clicked=${clicked} bounds=${await bounds()} state=${state}`)
}
app.kill()
process.exit(0)
