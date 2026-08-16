// 读取运行中 Echo 的布局事实：conversation 容器几何、presence、空卡片，以及样式来源。
const port = Number(process.env.ECHO_DEBUG_PORT ?? 9222)

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

const expression = `(() => {
  const conversation = document.querySelector('.chat-page .conversation')
  const presence = document.querySelector('.chat-page .d2-now-presence')
  const empty = document.querySelector('.chat-page .conversation > .d2-empty')
  const rect = (el) => {
    if (!el) return null
    const r = el.getBoundingClientRect()
    return { top: Math.round(r.top), left: Math.round(r.left), w: Math.round(r.width), h: Math.round(r.height) }
  }
  const style = (el, props) => {
    if (!el) return null
    const cs = getComputedStyle(el)
    return Object.fromEntries(props.map((p) => [p, cs.getPropertyValue(p)]))
  }
  return JSON.stringify({
    conversation: { rect: rect(conversation), style: style(conversation, ['position', 'padding-top', 'padding-left', 'top', 'left']) },
    presence: { rect: rect(presence), style: style(presence, ['position', 'top', 'left']) },
    empty: { rect: rect(empty), style: style(empty, ['position', 'top', 'left', 'width']) },
    emptyClasses: empty?.className ?? null,
  }, null, 1)
})()`

ws.addEventListener('open', async () => {
  try {
    const evaluate = await send('Runtime.evaluate', { expression, returnByValue: true })
    console.log(evaluate.result.value)
    ws.close()
    process.exit(0)
  } catch (error) {
    console.error(error)
    process.exit(1)
  }
})
