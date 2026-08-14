import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

if (process.platform !== 'win32') {
  console.error('[installer] NSIS smoke verification only runs on Windows.')
  process.exit(1)
}

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(scriptDirectory, '..')
const packageJson = JSON.parse(fs.readFileSync(path.join(projectRoot, 'package.json'), 'utf8'))
const installerPath = path.join(projectRoot, 'release', `Echo-Setup-${packageJson.version}.exe`)
const runStamp = new Date().toISOString().replaceAll(':', '-').replaceAll('.', '-')
const runDirectory = path.join(projectRoot, 'artifacts', 'installer-smoke', runStamp)
const installDirectory = path.join(runDirectory, 'installed', 'Echo')
const profileDirectory = path.join(runDirectory, 'profile')
const captureDirectory = path.join(runDirectory, 'packaged-first-run')
const appExecutable = path.join(installDirectory, 'Echo.exe')
const uninstallerExecutable = path.join(installDirectory, 'Uninstall Echo.exe')

if (!fs.existsSync(installerPath)) {
  console.error(`[installer] Missing ${installerPath}. Run npm run dist first.`)
  process.exit(1)
}

fs.mkdirSync(runDirectory, { recursive: true })
fs.mkdirSync(profileDirectory, { recursive: true })
fs.mkdirSync(captureDirectory, { recursive: true })

function runProcess(executable, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = spawn(executable, args, {
      cwd: options.cwd ?? projectRoot,
      env: options.env ?? process.env,
      stdio: ['ignore', 'pipe', 'pipe'],
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    const timeout = setTimeout(() => {
      child.kill()
      reject(new Error(`${path.basename(executable)} timed out`))
    }, options.timeoutMs ?? 120_000)
    child.stdout.on('data', (chunk) => { stdout += chunk.toString() })
    child.stderr.on('data', (chunk) => { stderr += chunk.toString() })
    child.on('error', (error) => {
      clearTimeout(timeout)
      reject(error)
    })
    child.on('exit', (code, signal) => {
      clearTimeout(timeout)
      if (signal || code !== 0) {
        reject(new Error(`${path.basename(executable)} exited with ${signal ?? code}\n${stderr || stdout}`))
        return
      }
      resolve({ stdout, stderr })
    })
  })
}

async function waitForMissing(target, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    if (!fs.existsSync(target)) return
    await new Promise((resolve) => setTimeout(resolve, 250))
  }
  throw new Error(`Timed out waiting for removal of ${target}`)
}

function assertFile(target, label) {
  if (!fs.existsSync(target) || fs.statSync(target).size === 0) {
    throw new Error(`${label} is missing: ${target}`)
  }
}

console.log('[installer] clean install')
await runProcess(installerPath, ['/S', `/D=${installDirectory}`])
assertFile(appExecutable, 'installed executable')
assertFile(
  path.join(installDirectory, 'resources', 'app.asar.unpacked', 'node_modules', 'better-sqlite3', 'build', 'Release', 'better_sqlite3.node'),
  'packaged better-sqlite3 binding',
)
if (fs.existsSync(path.join(installDirectory, 'resources', 'prompts'))) {
  throw new Error('Prompt source directory must not be exposed beside the packaged app')
}

console.log('[installer] packaged app with clean profile')
await runProcess(appExecutable, [], {
  cwd: installDirectory,
  timeoutMs: 60_000,
  env: {
    ...process.env,
    ECHO_E2E: '1',
    ECHO_E2E_SCENARIO: 'first-run',
    ECHO_E2E_OUTPUT_DIR: captureDirectory,
    ECHO_E2E_USER_DATA: profileDirectory,
  },
})
const packagedResultPath = path.join(captureDirectory, 'result.json')
assertFile(packagedResultPath, 'packaged first-run result')
const packagedResult = JSON.parse(fs.readFileSync(packagedResultPath, 'utf8'))
if (!packagedResult.ok || packagedResult.captures?.length !== 8) {
  throw new Error('Packaged first-run verification did not complete all eight captures')
}

const retentionMarker = path.join(profileDirectory, 'update-retention.marker')
fs.writeFileSync(retentionMarker, 'keep', 'utf8')
console.log('[installer] in-place update')
await runProcess(installerPath, ['/S', `/D=${installDirectory}`])
assertFile(appExecutable, 'updated executable')
assertFile(retentionMarker, 'user data retained after update')

console.log('[installer] silent uninstall')
assertFile(uninstallerExecutable, 'uninstaller')
await runProcess(uninstallerExecutable, ['/S'], { cwd: installDirectory })
await waitForMissing(installDirectory)
assertFile(retentionMarker, 'user data retained after uninstall')

const summaryPath = path.join(runDirectory, 'summary.json')
fs.writeFileSync(summaryPath, JSON.stringify({
  ok: true,
  installerPath,
  installDirectory,
  profileDirectory,
  packagedCaptures: packagedResult.captures,
  updateRetainedUserData: true,
  uninstallRetainedUserData: true,
}, null, 2), 'utf8')
console.log(`[installer] verification passed: ${summaryPath}`)
