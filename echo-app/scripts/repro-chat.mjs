// 通过 CDP 在运行中的 Echo 里发送一句话，等待回复并输出结果与耗时。
const port = Number(process.env.ECHO_DEBUG_PORT ?? 9222)
const text = process.argv[2] ?? '你觉得陈默之有什么好听的，随便推荐一首给我'

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

ws.addEventListener('open', async () => {
  try {
    const startedAt = Date.now()
    const result = await send('Runtime.evaluate', {
      expression: `window.echo.chat.send(${JSON.stringify(text)})`,
      awaitPromise: true,
      returnByValue: true,
    })
    const value = result.result.value ?? {}
    console.log(JSON.stringify({
      elapsedMs: Date.now() - startedAt,
      content: value.message?.content ?? null,
      trackCount: value.message?.tracks?.length ?? 0,
      tracks: (value.message?.tracks ?? []).slice(0, 3).map((t) => `${t.title} - ${t.artist}`),
      hints: value.hints ?? null,
      boundary: value.boundary?.code ?? null,
    }, null, 1))
    ws.close()
    process.exit(0)
  } catch (error) {
    console.error('repro failed:', error)
    process.exit(1)
  }
})
