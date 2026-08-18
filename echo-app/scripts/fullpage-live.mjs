// 0.2.0 整页化真机走查：启动安装版（CDP），非破坏性导航设置/品味，DOM 断言 + 截图。
import { spawn } from 'node:child_process'
import { mkdirSync, writeFileSync } from 'node:fs'

const exe = process.env.ECHO_EXE ?? 'C:\\Users\\Max\\AppData\\Local\\Programs\\Echo\\Echo.exe'
const port = Number(process.env.ECHO_DEBUG_PORT ?? 9224)
const outDir = 'artifacts/live-fullpage'
mkdirSync(outDir, { recursive: true })

const app = spawn(exe, [`--remote-debugging-port=${port}`], { stdio: 'ignore', detached: false })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

let page = null
for (let i = 0; i < 40; i++) {
  await sleep(500)
  try {
    const list = await (await fetch(`http://127.0.0.1:${port}/json`)).json()
    page = list.find((target) => target.type === 'page')
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
  const message = JSON.parse(event.data)
  if (message.id && pending.has(message.id)) {
    const { resolve, reject } = pending.get(message.id)
    pending.delete(message.id)
    if (message.error) reject?.(new Error(message.error.message))
    else resolve?.(message.result)
  }
})
await new Promise((resolve) => ws.addEventListener('open', resolve))

async function evalJson(expression) {
  const result = await send('Runtime.evaluate', { expression, returnByValue: true })
  return result.result.value
}

async function click(selector) {
  return evalJson(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (el instanceof HTMLElement) { el.click(); return true } return false })()`)
}

async function visible(selector) {
  return evalJson(`(() => { const el = document.querySelector(${JSON.stringify(selector)}); if (!el) return false; const rect = el.getBoundingClientRect(); return rect.width > 0 && rect.height > 0 })()`)
}

async function shot(name) {
  const capture = await send('Page.captureScreenshot', { format: 'png' })
  writeFileSync(`${outDir}/${name}.png`, Buffer.from(capture.data, 'base64'))
}

await send('Runtime.enable')
await send('Page.enable')
await sleep(3500) // boot / daily reconnect

const report = {}

report.topNav = await evalJson(`[...document.querySelectorAll('.d2-nav-button')].map((b) => b.getAttribute('aria-label'))`)
report.chatAlive = await visible('.chat-page')

// 设置：rail 项数 + 三个分区直达
report.settingsOpen = await click('.d2-nav-button[aria-label="设置"]')
await sleep(900)
report.settingsVisible = await visible('.shell-page[data-page="settings"] .settings-page')
report.railItems = await evalJson(`[...document.querySelectorAll('.d2-settings-rail .d2-rail-item')].map((b) => b.textContent.trim())`)
report.railLlm = await click('[data-testid="settings-rail-llm"]')
await sleep(500)
report.detailLlm = await visible('.d2-settings-form.detail-llm')
report.detailMusic = await (await click('[data-testid="settings-rail-music"]') && sleep(400).then(() => visible('.d2-settings-form.detail-music')))
await click('[data-testid="settings-rail-window"]')
await sleep(500)
report.windowOptions = await evalJson(`document.querySelectorAll('.window-size-options .window-size-option').length`)
await shot('live-settings-window')
await shot('live-settings')

// 品味：整页 + hero 或空态
await click('.d2-nav-button[aria-label="品味"]')
await sleep(1000)
report.profileVisible = await visible('.shell-page[data-page="profile"] .d2-profile')
report.profileMode = await evalJson(`(() => {
  if (document.querySelector('.pf-hero')) return 'hero'
  if (document.querySelector('.pf-empty')) return 'empty'
  if (document.querySelector('.shell-page[data-page="profile"] .d2-profile .boundary')) return 'boundary'
  return document.querySelector('.shell-page[data-page="profile"] .d2-profile')?.firstElementChild?.className ?? 'unknown'
})()`)
report.dimsCount = await evalJson(`document.querySelectorAll('.pf-dims .dim').length`)
report.evidenceRows = await evalJson(`document.querySelectorAll('.ev-row').length`)
await shot('live-profile')

// 回首页收尾
await click('.d2-brand')
await sleep(600)
report.backToChat = await visible('.chat-page')

console.log(JSON.stringify(report, null, 2))
app.kill()
process.exit(0)
