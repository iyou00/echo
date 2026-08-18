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
await shot('live-settings')

// 逐分区采样：内容区里所有非透明、非纸面的计算底色元素
const sections = ['music','llm','voice','yinyi','chat','stage','learned','care','tasks','window','data']
report.sectionBackgrounds = {}
for (const key of sections) {
  const clicked = await click(`[data-testid="settings-rail-${key}"]`)
  if (!clicked) { report.sectionBackgrounds[key] = 'RAIL-MISS'; continue }
  await sleep(260)
  if (key === 'music' || key === 'care' || key === 'learned') await shot(`live-settings-${key}`)
  report.sectionBackgrounds[key] = await evalJson(`(() => {
    const main = document.querySelector('.d2-settings-main')
    if (!main) return 'NO-MAIN'
    const hits = []
    const walk = (el) => {
      for (const child of el.children) {
        const bg = getComputedStyle(child).backgroundColor
        const cls = (child.className && typeof child.className === 'string') ? child.className.split(' ')[0] : child.tagName
        if (child instanceof HTMLElement && bg && bg !== 'rgba(0, 0, 0, 0)') {
          const rgb = bg.match(/\d+(?:\.\d+)?/g)
          const r = Math.round(Number(rgb?.[0] ?? 0)), g = Math.round(Number(rgb?.[1] ?? 0)), b = Math.round(Number(rgb?.[2] ?? 0))
          const isPaper = Math.abs(r-238)<6 && Math.abs(g-240)<6 && Math.abs(b-235)<6
          if (!isPaper) hits.push(cls + ':' + bg)
        }
        walk(child)
      }
    }
    walk(main)
    const inputs = []
    for (const el of document.querySelectorAll('.d2-settings-main input, .d2-settings-main select')) {
      const bg = getComputedStyle(el).backgroundColor
      if (bg && bg !== 'rgba(0, 0, 0, 0)') inputs.push(el.type + '|' + el.className + '|' + bg)
    }
    return { blocks: hits.length ? hits.slice(0, 8) : [], inputs }
  })()`)
}

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
