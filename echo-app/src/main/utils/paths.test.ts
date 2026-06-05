import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { afterEach, describe, expect, it, vi } from 'vitest'

vi.mock('electron', () => ({
  app: {
    getPath: vi.fn(() => path.join(os.tmpdir(), 'echo-test-exe', 'Echo.exe')),
    getAppPath: vi.fn(() => process.cwd()),
  },
}))

import { clearRootFileCache, migrateLegacyDataDir, readRootFile } from './paths'
import { embeddedPromptPaths } from '../prompts/store'

const tempRoots: string[] = []

function makeTempRoot(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'echo-paths-'))
  tempRoots.push(root)
  return root
}

afterEach(() => {
  clearRootFileCache()
  for (const root of tempRoots.splice(0)) {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

describe('legacy data directory migration', () => {
  it('promotes legacy db sidecars and seals into the target data dir', () => {
    const root = makeTempRoot()
    const legacy = path.join(root, 'legacy')
    const target = path.join(root, 'target')
    fs.mkdirSync(path.join(legacy, 'seals'), { recursive: true })
    fs.writeFileSync(path.join(legacy, 'echo.db'), 'db')
    fs.writeFileSync(path.join(legacy, 'echo.db-wal'), 'wal')
    fs.writeFileSync(path.join(legacy, 'echo.db-shm'), 'shm')
    fs.writeFileSync(path.join(legacy, 'seals', '2026-05-31.json'), '{}')

    expect(migrateLegacyDataDir(target, legacy)).toBe(true)

    expect(fs.readFileSync(path.join(target, 'echo.db'), 'utf8')).toBe('db')
    expect(fs.readFileSync(path.join(target, 'echo.db-wal'), 'utf8')).toBe('wal')
    expect(fs.readFileSync(path.join(target, 'echo.db-shm'), 'utf8')).toBe('shm')
    expect(fs.readFileSync(path.join(target, 'seals', '2026-05-31.json'), 'utf8')).toBe('{}')
    expect(fs.readdirSync(target).some((name) => name.startsWith('.legacy-migration-'))).toBe(false)
  })

  it('keeps an existing usable target database intact', () => {
    const root = makeTempRoot()
    const legacy = path.join(root, 'legacy')
    const target = path.join(root, 'target')
    fs.mkdirSync(legacy, { recursive: true })
    fs.mkdirSync(target, { recursive: true })
    fs.writeFileSync(path.join(legacy, 'echo.db'), 'legacy-db')
    fs.writeFileSync(path.join(target, 'echo.db'), 'target-db')

    expect(migrateLegacyDataDir(target, legacy)).toBe(true)
    expect(fs.readFileSync(path.join(target, 'echo.db'), 'utf8')).toBe('target-db')
  })

  it('returns false on a failed attempt and succeeds on the next valid attempt', () => {
    const root = makeTempRoot()
    const legacy = path.join(root, 'legacy')
    const target = path.join(root, 'target')
    fs.mkdirSync(legacy, { recursive: true })
    fs.writeFileSync(path.join(legacy, 'echo.db'), 'legacy-db')
    fs.writeFileSync(target, 'blocking-file')

    expect(migrateLegacyDataDir(target, legacy)).toBe(false)

    fs.rmSync(target, { force: true })
    expect(migrateLegacyDataDir(target, legacy)).toBe(true)
    expect(fs.readFileSync(path.join(target, 'echo.db'), 'utf8')).toBe('legacy-db')
  })
})

describe('root file prompts', () => {
  it('serves every embedded prompt when running in packaged mode', () => {
    const previousDevServerUrl = process.env.VITE_DEV_SERVER_URL
    delete process.env.VITE_DEV_SERVER_URL
    clearRootFileCache()

    try {
      expect(embeddedPromptPaths.length).toBeGreaterThan(0)
      for (const promptPath of embeddedPromptPaths) {
        const prompt = readRootFile(promptPath)
        expect(prompt, promptPath).toContain('Echo')
        expect(prompt.length, promptPath).toBeGreaterThan(100)
      }
    } finally {
      if (previousDevServerUrl === undefined) {
        delete process.env.VITE_DEV_SERVER_URL
      } else {
        process.env.VITE_DEV_SERVER_URL = previousDevServerUrl
      }
      clearRootFileCache()
    }
  })

  it('normalizes Windows prompt paths before reading embedded prompts', () => {
    const previousDevServerUrl = process.env.VITE_DEV_SERVER_URL
    delete process.env.VITE_DEV_SERVER_URL
    clearRootFileCache()

    try {
      const prompt = readRootFile('prompts\\system.md')
      expect(prompt).toContain('Echo')
      expect(prompt.length).toBeGreaterThan(100)
    } finally {
      if (previousDevServerUrl === undefined) {
        delete process.env.VITE_DEV_SERVER_URL
      } else {
        process.env.VITE_DEV_SERVER_URL = previousDevServerUrl
      }
      clearRootFileCache()
    }
  })
})
