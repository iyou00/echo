// 抓 E2E first-run 失败时的渲染端 console/异常：同 env 起实例 + CDP 监听。
import { spawn } from 'node:child_process'
import { mkdirSync } from 'node:fs'
import path from 'node:path'

const projectRoot = process.cwd()
const runDirectory = path.join(projectRoot, 'artifacts', 'e2e-debug')
mkdirSync(runDirectory, { recursive: true })
const port = 9245
const electronPath = path.join(projectRoot, 'node_modules', 'electron', 'dist', 'electron.exe')
const child = spawn(electronPath,
  ['.', `--remote-debugging-port=${port}`],
  {
    cwd: projectRoot,
    env: {
      ...process.env,
      ECHO_E2E: '1',
      ECHO_E2E_SCENARIO: 'first-run',
      ECHO_E2E_BOUNDARY: '',
      ECHO_E2E_OUTPUT_DIR: runDirectory,
      ECHO_E2E_USER_DATA: path.join(runDirectory, 'profile'),
    },
    stdio: 'ignore',
  })
const sleep = (ms) => new Promise((r) => setTimeout(r, ms))
let page = null
for (let i = 0; i < 60; i++) {
  await sleep(500)
  try {
    const list = await (await (await fetch(`http://127.0.0.1:${port}/json`)).json())
    page = list.find((t) => t.type === 'page')
    if (page) break
  } catch {}
}
if (!page) { console.log('NO-PAGE'); child.kill(); process.exit(1) }
const ws = new WebSocket(page.webSocketDebuggerUrl)
let seq = 0
const pending = new Map()
const logs = []
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
  } else if (m.method === 'Runtime.consoleAPICalled') {
    const text = (m.params.args || []).map((a) => a.value ?? a.description ?? '').join(' ')
    if (m.params.type === 'error' || m.params.type === 'warning' || /fail|error/i.test(text)) {
      logs.push(m.params.type + ': ' + text.slice(0, 200))
    }
  } else if (m.method === 'Runtime.exceptionThrown') {
    logs.push('EXCEPTION: ' + (m.params.exceptionDetails?.exception?.description ?? m.params.exceptionDetails?.text ?? '').slice(0, 400))
  }
})
await new Promise((r) => ws.addEventListener('open', r))
await send('Runtime.enable')
await send('Log.enable').catch(() => undefined)
// 等 E2E 流程自然结束或 40s
await sleep(40000)
console.log(logs.length ? logs.slice(0, 20).join('\n') : 'NO-RENDERER-ERRORS')
child.kill()
process.exit(0)
