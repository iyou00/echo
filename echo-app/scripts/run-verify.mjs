import { spawn } from 'node:child_process'

const npmEntry = process.env.npm_execpath
if (!npmEntry) throw new Error('npm_execpath is unavailable')
const steps = ['lint', 'test', 'build', 'test:e2e:electron']

function runStep(step) {
  return new Promise((resolve, reject) => {
    const env = { ...process.env }
    delete env.npm_lifecycle_event
    delete env.npm_lifecycle_script
    const child = spawn(process.execPath, [npmEntry, 'run', step], {
      env,
      stdio: 'inherit',
      windowsHide: true,
    })
    child.on('error', reject)
    child.on('exit', (code, signal) => {
      if (signal) reject(new Error(`${step} stopped by signal ${signal}`))
      else if (code !== 0) reject(new Error(`${step} failed with exit code ${code}`))
      else resolve()
    })
  })
}

for (const step of steps) {
  console.log(`\n[verify] ${step}`)
  await runStep(step)
}

console.log('\n[verify] all checks passed')
