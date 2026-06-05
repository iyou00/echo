import fs from 'node:fs'
import fsp from 'node:fs/promises'
import path from 'node:path'
import { app } from 'electron'
import { hasEmbeddedPrompt, readEmbeddedPrompt } from '../prompts/store'

let dataDirReady = false

function legacyDataDir(): string {
  return path.join(path.dirname(app.getPath('exe')), 'data')
}

function copyIfExists(from: string, to: string): void {
  if (!fs.existsSync(from) || fs.existsSync(to)) return
  fs.cpSync(from, to, { recursive: true, force: false, errorOnExist: false })
}

function hasUsableFile(filePath: string): boolean {
  try {
    return fs.statSync(filePath).size > 0
  } catch {
    return false
  }
}

function removeDirQuietly(dir: string): void {
  try {
    fs.rmSync(dir, { recursive: true, force: true })
  } catch {
    // best effort cleanup
  }
}

function copyLegacyDataToTemp(legacyDir: string, tempDir: string): string {
  fs.mkdirSync(tempDir, { recursive: true })
  const legacyDb = path.join(legacyDir, 'echo.db')
  const tempDb = path.join(tempDir, 'echo.db')
  copyIfExists(legacyDb, tempDb)
  copyIfExists(`${legacyDb}-wal`, `${tempDb}-wal`)
  copyIfExists(`${legacyDb}-shm`, `${tempDb}-shm`)
  copyIfExists(path.join(legacyDir, 'seals'), path.join(tempDir, 'seals'))
  if (!hasUsableFile(tempDb)) throw new Error('legacy database copy is empty')
  return tempDb
}

function promoteLegacyDataTemp(tempDir: string, targetDir: string): void {
  const tempDb = path.join(tempDir, 'echo.db')
  const targetDb = path.join(targetDir, 'echo.db')
  for (const suffix of ['-wal', '-shm']) {
    const tempSidecar = `${tempDb}${suffix}`
    const targetSidecar = `${targetDb}${suffix}`
    if (fs.existsSync(tempSidecar)) {
      fs.rmSync(targetSidecar, { force: true })
      fs.renameSync(tempSidecar, targetSidecar)
    }
  }
  fs.renameSync(tempDb, targetDb)
  const tempSeals = path.join(tempDir, 'seals')
  const targetSeals = path.join(targetDir, 'seals')
  if (fs.existsSync(tempSeals) && !fs.existsSync(targetSeals)) {
    fs.renameSync(tempSeals, targetSeals)
  }
}

export function migrateLegacyDataDir(targetDir: string, legacyDir = legacyDataDir()): boolean {
  if (path.resolve(legacyDir) === path.resolve(targetDir)) return true
  const legacyDb = path.join(legacyDir, 'echo.db')
  const targetDb = path.join(targetDir, 'echo.db')
  if (!hasUsableFile(legacyDb)) return true
  if (hasUsableFile(targetDb)) return true

  const tempDir = path.join(targetDir, `.legacy-migration-${process.pid}`)
  try {
    fs.mkdirSync(targetDir, { recursive: true })
    fs.rmSync(targetDb, { force: true })
    fs.rmSync(`${targetDb}-wal`, { force: true })
    fs.rmSync(`${targetDb}-shm`, { force: true })
    removeDirQuietly(tempDir)
    copyLegacyDataToTemp(legacyDir, tempDir)
    promoteLegacyDataTemp(tempDir, targetDir)
    console.info('[paths] migrated legacy data directory', { from: legacyDir, to: targetDir })
    return true
  } catch (error) {
    console.error('[paths] legacy data migration failed', error)
    return false
  } finally {
    removeDirQuietly(tempDir)
  }
}

export function getDataDir(): string {
  const dir = path.join(app.getPath('userData'), 'data')
  fs.mkdirSync(dir, { recursive: true })
  if (!dataDirReady) {
    dataDirReady = migrateLegacyDataDir(dir)
  }
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
  // Packaged builds keep public resources under process.resourcesPath; prompts are bundled into main code.
  const candidates = [
    process.resourcesPath,
    process.cwd(),
    path.join(process.cwd(), '..'),
    app.getAppPath(),
    path.join(app.getAppPath(), '..'),
    path.join(app.getAppPath(), '..', '..'),
  ].filter((value): value is string => typeof value === 'string' && value.length > 0)

  for (const candidate of candidates) {
    const hasPromptSource = fs.existsSync(path.join(candidate, 'prompts', 'system.md'))
    const hasSampleSource = fs.existsSync(path.join(candidate, 'samples', 'artist-genre-seed.json'))
    if (hasPromptSource || hasSampleSource) {
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

function shouldPreferEmbeddedPrompt(relativePath: string): boolean {
  return shouldReuseRootFileCache() && hasEmbeddedPrompt(relativePath)
}

function cacheEmbeddedPrompt(relativePath: string): string {
  const content = readEmbeddedPrompt(relativePath) ?? ''
  fileCache.set(relativePath, { content, mtimeMs: null })
  return content
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
  if (shouldPreferEmbeddedPrompt(relativePath)) {
    if (cached) return cached.content
    return cacheEmbeddedPrompt(relativePath)
  }

  const target = resolveRootFile(relativePath)
  if (!target) return readEmbeddedPrompt(relativePath) ?? ''
  if (shouldReuseRootFileCache() && cached) return cached.content

  try {
    const stat = fs.statSync(target)
    if (cached && cached.mtimeMs === stat.mtimeMs) return cached.content
    const content = fs.readFileSync(target, 'utf8')
    fileCache.set(relativePath, { content, mtimeMs: stat.mtimeMs })
    return content
  } catch {
    if (shouldReuseRootFileCache() && cached) return cached.content
    const embedded = readEmbeddedPrompt(relativePath)
    if (embedded !== undefined) {
      fileCache.set(relativePath, { content: embedded, mtimeMs: null })
      return embedded
    }
    fileCache.set(relativePath, { content: '', mtimeMs: null })
    return ''
  }
}

export async function readRootFileAsync(relativePath: string): Promise<string> {
  const cached = fileCache.get(relativePath)
  if (shouldPreferEmbeddedPrompt(relativePath)) {
    if (cached) return cached.content
    return cacheEmbeddedPrompt(relativePath)
  }

  const target = resolveRootFile(relativePath)
  if (!target) return readEmbeddedPrompt(relativePath) ?? ''
  if (shouldReuseRootFileCache() && cached) return cached.content

  try {
    const stat = await fsp.stat(target)
    if (cached && cached.mtimeMs === stat.mtimeMs) return cached.content
    const content = await fsp.readFile(target, 'utf8')
    fileCache.set(relativePath, { content, mtimeMs: stat.mtimeMs })
    return content
  } catch {
    if (shouldReuseRootFileCache() && cached) return cached.content
    const embedded = readEmbeddedPrompt(relativePath)
    if (embedded !== undefined) {
      fileCache.set(relativePath, { content: embedded, mtimeMs: null })
      return embedded
    }
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
