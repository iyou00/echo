import fs from 'node:fs'
import path from 'node:path'
import { app } from 'electron'

export function getDataDir(): string {
  const dir = path.join(app.getPath('appData'), 'echo')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function getDbPath(): string {
  return path.join(getDataDir(), 'echo.db')
}

export function getSealsDir(): string {
  const dir = path.join(getDataDir(), 'seals')
  fs.mkdirSync(dir, { recursive: true })
  return dir
}

export function findRepoRoot(): string {
  // 打包后 (process.resourcesPath/prompts) 优先；开发态再回落到仓库根。
  const candidates = [
    process.resourcesPath,
    process.cwd(),
    path.join(process.cwd(), '..'),
    app.getAppPath(),
    path.join(app.getAppPath(), '..'),
    path.join(app.getAppPath(), '..', '..'),
  ].filter((value): value is string => typeof value === 'string' && value.length > 0)

  for (const candidate of candidates) {
    if (fs.existsSync(path.join(candidate, 'prompts', 'system.md'))) {
      return candidate
    }
  }

  return path.join(app.getAppPath(), '..')
}

export function readRootFile(relativePath: string): string {
  const target = path.join(findRepoRoot(), relativePath)
  return fs.existsSync(target) ? fs.readFileSync(target, 'utf8') : ''
}
