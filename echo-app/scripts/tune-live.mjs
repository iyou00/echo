// 向运行中的 Echo 注入候选 CSS，测量并截图，供布局调准迭代。
import fs from 'node:fs'
import path from 'node:path'

const port = Number(process.env.ECHO_DEBUG_PORT ?? 9222)
const outDir = process.argv[2] ?? 'artifacts/live-capture'
const css = fs.readFileSync(process.argv[3], 'utf8')
fs.mkdirSync(outDir, { recursive: true })

const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
const page = list.find((target) => target.type === 'page')
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
  const message = JSON.parse(event.data)
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id)
    pending.delete(message.id)
    if (message.error) reject(new Error(message.error.message))
    else resolve(message.result)
  }
})

const measure = `(() => {
  const rect = (sel) => {
    const el = document.querySelector(sel)
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { top: Math.round(r.top), left: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height), bottom: Math.round(r.bottom) }
  }
  return JSON.stringify({ presence: rect('.chat-page .d2-now-presence'), empty: rect('.chat-page .conversation > .d2-empty') })
})()`

ws.addEventListener('open', async () => {
  try {
    await send('Runtime.evaluate', {
      expression: `(() => { const tag = document.getElementById('live-tune'); if (tag) tag.remove(); const style = document.createElement('style'); style.id = 'live-tune'; style.textContent = ${JSON.stringify(css)}; document.head.appendChild(style); 'ok' })()`,
      returnByValue: true,
    })
    await new Promise((resolve) => setTimeout(resolve, 250))
    const before = await send('Runtime.evaluate', { expression: measure, returnByValue: true })
    console.log('after:', before.result.value)
    const shot = await send('Page.captureScreenshot', { format: 'png' })
    const file = path.join(outDir, 'tuned.png')
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'))
    console.log('saved', file)
    ws.close()
    process.exit(0)
  } catch (error) {
    console.error(error)
    process.exit(1)
  }
})
