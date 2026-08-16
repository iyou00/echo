// CDP：打开设置→「Echo 学到了什么」审计页并截图。
import fs from 'node:fs'

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

ws.addEventListener('open', async () => {
  try {
    await send('Runtime.evaluate', {
      expression: `(() => { const btn = document.querySelector('.d2-icon-button[aria-label="设置"]'); if (btn instanceof HTMLElement) { btn.click(); return true } return false })()`,
      returnByValue: true,
    })
    await new Promise((resolve) => setTimeout(resolve, 600))
    await send('Runtime.evaluate', {
      expression: `(() => { const entry = document.querySelector('[data-testid="settings-learned-entry"]'); if (entry instanceof HTMLElement) { entry.click(); return true } return false })()`,
      returnByValue: true,
    })
    await new Promise((resolve) => setTimeout(resolve, 800))
    const shot = await send('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync('artifacts/live-capture/learned-audit.png', Buffer.from(shot.data, 'base64'))
    const rows = await send('Runtime.evaluate', {
      expression: `document.querySelectorAll('.d2-settings-form.detail-learned .target-learned .d2-learned-row, .d2-settings-form.detail-learned .d2-learned-row').length`,
      returnByValue: true,
    })
    console.log('rows:', rows.result.value)
    console.log('saved artifacts/live-capture/learned-audit.png')
    ws.close()
    process.exit(0)
  } catch (error) {
    console.error(error)
    process.exit(1)
  }
})
