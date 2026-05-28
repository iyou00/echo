import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { app } from 'electron'

export function getDataDir(): string {
  const exeDir = path.dirname(app.getPath('exe'))
  const dir = path.join(exeDir, 'data')
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

let repoRootCache: string | null = null

export function findRepoRoot(): string {
  if (repoRootCache) return repoRootCache
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
      repoRootCache = candidate
      return candidate
    }
  }

  repoRootCache = path.join(app.getAppPath(), '..')
  return repoRootCache
}

interface RootFileCacheEntry {
  content: string
  mtimeMs: number | null
}

const fileCache = new Map<string, RootFileCacheEntry>()

function shouldReuseRootFileCache(): boolean {
  return !process.env.VITE_DEV_SERVER_URL
}

function resolveRootFile(relativePath: string): string | null {
  if (path.isAbsolute(relativePath)) return null
  const root = path.resolve(findRepoRoot())
  const target = path.resolve(root, relativePath)
  const relative = path.relative(root, target)
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) return null
  return target
}

export function readRootFile(relativePath: string): string {
  const cached = fileCache.get(relativePath)
  const target = resolveRootFile(relativePath)
  if (!target) return ''
  if (shouldReuseRootFileCache() && cached) return cached.content

  try {
    const stat = fs.statSync(target)
    if (cached && cached.mtimeMs === stat.mtimeMs) return cached.content
    const content = fs.readFileSync(target, 'utf8')
    fileCache.set(relativePath, { content, mtimeMs: stat.mtimeMs })
    return content
  } catch {
    if (shouldReuseRootFileCache() && cached) return cached.content
    fileCache.set(relativePath, { content: '', mtimeMs: null })
    return ''
  }
}

export async function readRootFileAsync(relativePath: string): Promise<string> {
  const cached = fileCache.get(relativePath)
  const target = resolveRootFile(relativePath)
  if (!target) return ''
  if (shouldReuseRootFileCache() && cached) return cached.content

  try {
    const stat = await fsp.stat(target)
    if (cached && cached.mtimeMs === stat.mtimeMs) return cached.content
    const content = await fsp.readFile(target, 'utf8')
    fileCache.set(relativePath, { content, mtimeMs: stat.mtimeMs })
    return content
  } catch {
    if (shouldReuseRootFileCache() && cached) return cached.content
    fileCache.set(relativePath, { content: '', mtimeMs: null })
    return ''
  }
}

export function clearRootFileCache(): void {
  fileCache.clear()
  repoRootCache = null
}

export async function warmRootFileCache(relativePaths: readonly string[]): Promise<void> {
  await Promise.all(relativePaths.map((relativePath) => readRootFileAsync(relativePath)))
}
