// 对运行中的 Echo 做非破坏性 DOM 断言（不播放、不写数据）。
const port = Number(process.env.ECHO_DEBUG_PORT ?? 9222)

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

const checks = `(() => {
  const tools = document.querySelectorAll('.d2-sound-tools button')
  const objectPlay = document.querySelectorAll('.d2-object-play')
  const nextUp = document.querySelector('.d2-next-up')
  const footer = document.querySelector('.global-player')
  return JSON.stringify({
    miniToolButtons: tools.length,
    miniToolLabels: [...tools].map((b) => b.getAttribute('aria-label') || b.title),
    objectPlayCount: objectPlay.length,
    nextUpEntry: nextUp ? { aria: nextUp.getAttribute('aria-label'), text: nextUp.textContent.slice(0, 20) } : null,
    footerClasses: footer?.className ?? null,
    version: document.title,
  }, null, 1)
})()`

ws.addEventListener('open', async () => {
  try {
    const result = await send('Runtime.evaluate', { expression: checks, returnByValue: true })
    console.log(result.result.value)
    ws.close()
    process.exit(0)
  } catch (error) {
    console.error(error)
    process.exit(1)
  }
})
