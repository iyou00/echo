// 复现「回复中曲线消失又出现」：发一条带歌提问，逐拍记录 fieldMode 序列。
import { spawn } from 'node:child_process'

const port = 9231
const app = spawn('C:/Users/Max/AppData/Local/Programs/Echo/Echo.exe', [`--remote-debugging-port=${port}`], { stdio: 'ignore' })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let page = null
for (let i = 0; i < 40; i++) {
  await sleep(500)
  try {
    const list = await (await (await fetch(`http://127.0.0.1:${port}/json`)).json())
    page = list.find((t) => t.type === 'page')
    if (page) break
  } catch {}
}
if (!page) { app.kill(); throw new Error('no target') }
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

await sleep(4200)
const t0 = Date.now()
const timeline = []
let sent = false
for (let i = 0; i < 76; i++) {
  if (!sent && i === 4) {
    sent = true
    await evalJson(`window.echo.chat.send('随便来一首轻一点的歌').catch((e) => 'ERR:' + e.message); 'sent'`)
  }
  const snap = await evalJson(`(() => {
    const shell = document.querySelector('.d2-shell')
    const layer = document.querySelector('.d2-player-layer')
    const player = document.querySelector('.global-player')
    const field = shell?.className.match(/field-(\\w+)/)?.[1] ?? null
    const pl = layer?.className ?? ''
    const stage = document.querySelector('.chat-page')?.className ?? ''
    return JSON.stringify({ field, pl: pl.slice(0, 60), playerOpacity: player ? getComputedStyle(player).opacity : null })
  })()`)
  timeline.push(`${((Date.now() - t0) / 1000).toFixed(1)}s ${snap}`)
  await sleep(250)
}
console.log(timeline.join('\n'))
app.kill()
process.exit(0)
