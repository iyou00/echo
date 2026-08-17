// CDP：进入回声页并触发一次说话，截取书写态。
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

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

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
      expression: `document.querySelector('.d2-nav-button[aria-label="回声"]').click(); 'ok'`,
      returnByValue: true,
    })
    await wait(900)
    const shot1 = await send('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync('artifacts/live-021/voice-standby.png', Buffer.from(shot1.data, 'base64'))
    console.log('standby saved')

    const started = await send('Runtime.evaluate', {
      expression: `(() => { const btn = document.querySelector('.voice-ink-btn'); if (btn instanceof HTMLElement) { btn.click(); return true } return false })()`,
      returnByValue: true,
    })
    console.log('speak clicked:', started.result.value)
    await wait(4200)
    const state = await send('Runtime.evaluate', {
      expression: `(() => ({ pill: document.querySelector('.voice-status-pill')?.textContent ?? '', hand: document.querySelector('.voice-hand')?.textContent?.slice(0, 40) ?? '', paras: document.querySelectorAll('.voice-para').length, interludes: document.querySelectorAll('.voice-interlude').length, bookmark: document.querySelector('.voice-music-mark')?.textContent ?? '' }))()`,
      returnByValue: true,
    })
    console.log('state:', JSON.stringify(state.result.value))
    const shot2 = await send('Page.captureScreenshot', { format: 'png' })
    fs.writeFileSync('artifacts/live-021/voice-writing.png', Buffer.from(shot2.data, 'base64'))
    console.log('writing saved')
    ws.close()
    process.exit(0)
  } catch (error) {
    console.error(error)
    process.exit(1)
  }
})
