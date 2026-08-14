import { spawn } from 'node:child_process'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import electron from 'electron'

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(scriptDirectory, '..')
const vitestEntry = path.join(projectRoot, 'node_modules', 'vitest', 'vitest.mjs')

const child = spawn(electron, [vitestEntry, ...process.argv.slice(2)], {
  cwd: projectRoot,
  env: {
    ...process.env,
    ELECTRON_RUN_AS_NODE: '1',
  },
  stdio: 'inherit',
  windowsHide: true,
})

child.on('error', (error) => {
  console.error('[test] Electron Node runtime failed to start:', error)
  process.exitCode = 1
})

child.on('exit', (code, signal) => {
  if (signal) {
    console.error(`[test] Vitest stopped by signal ${signal}`)
    process.exitCode = 1
    return
  }
  process.exitCode = code ?? 1
})
