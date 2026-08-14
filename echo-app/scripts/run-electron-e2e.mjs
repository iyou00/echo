import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import electron from 'electron'

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(scriptDirectory, '..')
const rendererEntry = path.join(projectRoot, 'dist', 'index.html')
const runStamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
const runDirectory = path.join(projectRoot, 'artifacts', 'electron-e2e', runStamp)
const scenarios = ['first-run', 'first-run-sound', 'offline', 'startup-failure']

if (!fs.existsSync(rendererEntry)) {
  console.error('[e2e] dist/index.html is missing. Run npm run build first.')
  process.exit(1)
}

fs.mkdirSync(runDirectory, { recursive: true })

function runScenario(scenario) {
  return new Promise((resolve, reject) => {
    const scenarioDirectory = path.join(runDirectory, scenario)
    const userDataDirectory = path.join(runDirectory, 'profiles', scenario)
    fs.mkdirSync(scenarioDirectory, { recursive: true })
    fs.mkdirSync(userDataDirectory, { recursive: true })
    const child = spawn(electron, ['.'], {
      cwd: projectRoot,
      env: {
        ...process.env,
        ECHO_E2E: '1',
        ECHO_E2E_SCENARIO: scenario,
        ECHO_E2E_OUTPUT_DIR: scenarioDirectory,
        ECHO_E2E_USER_DATA: userDataDirectory,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    const timeout = setTimeout(() => {
      child.kill()
      reject(new Error(`${scenario} timed out after 45 seconds`))
    }, 45_000)
    child.on('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.on('exit', (code, signal) => {
      clearTimeout(timeout)
      fs.writeFileSync(path.join(scenarioDirectory, 'electron.stdout.log'), stdout, 'utf8')
      fs.writeFileSync(path.join(scenarioDirectory, 'electron.stderr.log'), stderr, 'utf8')
      if (signal || code !== 0) {
        reject(new Error(`${scenario} exited with ${signal ?? code}\n${stderr || stdout}`))
        return
      }
      const resultPath = path.join(scenarioDirectory, 'result.json')
      if (!fs.existsSync(resultPath)) {
        reject(new Error(`${scenario} did not write result.json`))
        return
      }
      const result = JSON.parse(fs.readFileSync(resultPath, 'utf8'))
      if (!result.ok || !Array.isArray(result.captures) || result.captures.length === 0) {
        reject(new Error(`${scenario} reported a failed or empty result`))
        return
      }
      resolve(result)
    })
  })
}

const summary = []
for (const scenario of scenarios) {
  process.stdout.write(`[e2e] ${scenario}... `)
  const result = await runScenario(scenario)
  summary.push(result)
  console.log(`${result.captures.length} capture(s) passed`)
}

const summaryPath = path.join(runDirectory, 'summary.json')
fs.writeFileSync(summaryPath, JSON.stringify({ ok: true, runDirectory, scenarios: summary }, null, 2), 'utf8')
console.log(`[e2e] Electron verification passed: ${summaryPath}`)
