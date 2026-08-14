import { spawnSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url))
const projectRoot = path.resolve(scriptDirectory, '..')
const electronBuilderCli = path.join(projectRoot, 'node_modules', 'electron-builder', 'out', 'cli', 'cli.js')

function usablePython(candidate) {
  if (!candidate) return null
  if (path.isAbsolute(candidate) && !fs.existsSync(candidate)) return null
  const probe = spawnSync(candidate, ['--version'], { encoding: 'utf8', windowsHide: true })
  return probe.status === 0 ? candidate : null
}

function findPython() {
  const candidates = [
    process.env.PYTHON,
    process.platform === 'win32' ? 'python.exe' : 'python3',
    process.platform === 'win32' ? 'python3.exe' : 'python',
    process.platform === 'win32' ? 'py.exe' : undefined,
    path.join(os.homedir(), '.cache', 'codex-runtimes', 'codex-primary-runtime', 'dependencies', 'python', process.platform === 'win32' ? 'python.exe' : 'bin/python3'),
  ]
  for (const candidate of candidates) {
    const resolved = usablePython(candidate)
    if (resolved) return resolved
  }
  return null
}

const python = findPython()
if (!python) {
  console.error('[native] Python 3 is required to rebuild Electron native modules.')
  console.error('[native] Install Python 3 or set the PYTHON environment variable, then run npm run rebuild:native.')
  process.exit(1)
}

const result = spawnSync(process.execPath, [electronBuilderCli, 'install-app-deps'], {
  cwd: projectRoot,
  env: { ...process.env, PYTHON: python },
  stdio: 'inherit',
  windowsHide: true,
})

if (result.error) {
  console.error('[native] Failed to start electron-builder:', result.error)
  process.exit(1)
}
process.exit(result.status ?? 1)
