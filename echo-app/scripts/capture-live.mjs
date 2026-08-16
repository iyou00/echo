// 连上正在运行的 Echo（--remote-debugging-port=9222），导出真实视口的截图与布局诊断。
import fs from 'node:fs'
import path from 'node:path'

const port = Number(process.env.ECHO_DEBUG_PORT ?? 9222)
const outDir = process.argv[2] ?? 'artifacts/live-capture'
fs.mkdirSync(outDir, { recursive: true })

const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
const page = list.find((target) => target.type === 'page')
if (!page) throw new Error('no page target')

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

const diagnosticExpression = `(() => {
  const rectOf = (el) => {
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { top: Math.round(r.top), left: Math.round(r.left), width: Math.round(r.width), height: Math.round(r.height), bottom: Math.round(r.bottom), text: (el.textContent || '').slice(0, 40) }
  }
  return JSON.stringify({
    viewport: { w: innerWidth, h: innerHeight, dpr: devicePixelRatio },
    chatPage: document.querySelector('.chat-page')?.className ?? null,
    presence: rectOf(document.querySelector('.d2-now-presence')),
    presenceH1: rectOf(document.querySelector('.d2-now-presence h1')),
    presenceP: rectOf(document.querySelector('.d2-now-presence p')),
    empty: rectOf(document.querySelector('.conversation > .d2-empty, .conversation > .empty-state, .conversation > .boundary-state')),
    emptyHtml: document.querySelector('.conversation > .d2-empty')?.outerHTML?.slice(0, 400) ?? null,
    bodyOverflow: document.body.style.overflow,
  }, null, 1)
})()`

ws.addEventListener('open', async () => {
  try {
    const evaluate = await send('Runtime.evaluate', { expression: diagnosticExpression, returnByValue: true })
    const report = evaluate.result.value
    fs.writeFileSync(path.join(outDir, 'diagnostic.json'), report)
    console.log(report)
    const shot = await send('Page.captureScreenshot', { format: 'png' })
    const file = path.join(outDir, 'live.png')
    fs.writeFileSync(file, Buffer.from(shot.data, 'base64'))
    console.log('saved', file)
    ws.close()
    process.exit(0)
  } catch (error) {
    console.error(error)
    process.exit(1)
  }
})
