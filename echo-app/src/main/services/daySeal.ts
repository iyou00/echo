import fs from 'node:fs'
import path from 'node:path'
import { getDb } from '../db'
import { getSettings } from '../db/settings'
import { completeChat } from '../llm/client'
import { getSealsDir, readRootFile } from '../utils/paths'

interface ConversationRow {
  role: string
  content: string
  created_at: string
}

interface TrackRow {
  title: string
  artist: string
  listened_at: string
  meta_json?: string
}

function todayDate(): string {
  return new Date().toLocaleDateString('sv-SE')
}

function weekday(): string {
  return new Intl.DateTimeFormat('zh-CN', { weekday: 'short' }).format(new Date())
}

function sealPath(date = todayDate()): string {
  return path.join(getSealsDir(), `${date}.md`)
}

function getTodayConversations(): ConversationRow[] {
  return getDb()
    .prepare(`
      SELECT role, content, created_at
      FROM conversations
      WHERE user_id = 1
        AND date(created_at, 'localtime') = date('now', 'localtime')
      ORDER BY created_at ASC, id ASC
    `)
    .all() as ConversationRow[]
}

function getTodayTracks(): TrackRow[] {
  return getDb()
    .prepare(`
      SELECT title, artist, listened_at, meta_json
      FROM tracks_listened
      WHERE user_id = 1
        AND date(listened_at, 'localtime') = date('now', 'localtime')
      ORDER BY listened_at ASC, id ASC
    `)
    .all() as TrackRow[]
}

function frontMatter(date: string, conversations: ConversationRow[], tracks: TrackRow[]): string {
  return `---
date: ${date}
weekday: ${weekday()}
sealed_at: ${new Date().toISOString()}
conversations_count: ${conversations.length}
tracks_played: ${tracks.length}
echo_recommendations: ${tracks.length}
schema_version: 1
---`
}

function fallbackSeal(conversations: ConversationRow[], tracks: TrackRow[]): string {
  const lastUser = [...conversations].reverse().find((item) => item.role === 'user')?.content ?? '今天对话很少。'
  const trackLine = tracks.slice(-5).map((track) => `${track.title} - ${track.artist}`).join('、') || '今天还没有推荐歌曲。'
  return `## 摘要(200 字以内)

今天用户主要留下的线索是:${lastUser.slice(0, 120)}
Echo 今日推荐:${trackLine}

## 关键时刻

- ${new Date().toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit' })} · 日封自动归档 · 给明天的 Echo 保留上下文

## 标记(可选)

- day_seal · 自动生成 · schema_version 1`
}

const SEAL_LLM_TIMEOUT_MS = 5000

function withTimeout<T>(promise: Promise<T>, ms: number): Promise<T | null> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(null), ms)
    promise
      .then((value) => {
        clearTimeout(timer)
        resolve(value)
      })
      .catch(() => {
        clearTimeout(timer)
        resolve(null)
      })
  })
}

async function generateSeal(conversations: ConversationRow[], tracks: TrackRow[]): Promise<string> {
  const prompt = readRootFile('prompts/seal-writer.md')
  const settings = getSettings()
  // 写日封通常发生在 before-quit 路径上，慢响应不能拖住关闭。5 秒不行就走 fallback。
  const content = await withTimeout(
    completeChat(settings, [
      { role: 'system', content: prompt || '你是 Echo。为自己写一份简洁、结构化的日封摘要。' },
      {
        role: 'user',
        content: `今天对话:
${conversations.map((item) => `${item.created_at} ${item.role}: ${item.content}`).join('\n')}

今日推荐:
${tracks.map((track) => `${track.listened_at} ${track.title} - ${track.artist}`).join('\n')}`,
      },
    ]),
    SEAL_LLM_TIMEOUT_MS,
  )
  if (typeof content === 'string' && content.trim()) return content.trim()
  return fallbackSeal(conversations, tracks)
}

export async function archiveDaySeal(): Promise<void> {
  const conversations = getTodayConversations()
  if (conversations.length === 0) return
  const tracks = getTodayTracks()
  const date = todayDate()
  const target = sealPath(date)
  const content = await generateSeal(conversations, tracks)
  const section = `${frontMatter(date, conversations, tracks)}

# ${date} · 日封

${content}
`

  if (fs.existsSync(target)) {
    const previous = fs.readFileSync(target, 'utf8')
    if (previous.includes(content.slice(0, 80))) return
    fs.writeFileSync(target, `${previous.trim()}

---

${content}
`, 'utf8')
    invalidateSealCache()
    return
  }
  fs.writeFileSync(target, section, 'utf8')
  invalidateSealCache()
}

interface SealCacheEntry {
  filename: string
  fullPath: string
  mtimeMs: number
  content: string
}

let sealCache: SealCacheEntry | null = null

/**
 * 取最近一份 day seal 摘要内容。
 * 频繁路径(每次 chat / 每次 listening / 每次 carePing 都会被读)，因此引入 mtime 缓存：
 * - 每次拿到目录 listing 就取最新文件名 + mtime；
 * - 文件名/mtime 与缓存一致就直接返回（避免一次 readFileSync）；
 * - 文件改名 / 内容变化 / 缓存第一次构建时才真正读盘。
 */
export function getMostRecentSeal(): string {
  const dir = getSealsDir()
  let files: string[]
  try {
    files = fs.readdirSync(dir).filter((file) => /^\d{4}-\d{2}-\d{2}\.md$/.test(file)).sort().reverse()
  } catch {
    return ''
  }
  const filename = files[0]
  if (!filename) {
    sealCache = null
    return ''
  }

  const fullPath = path.join(dir, filename)
  let mtimeMs = 0
  try {
    mtimeMs = fs.statSync(fullPath).mtimeMs
  } catch {
    sealCache = null
    return ''
  }

  if (sealCache && sealCache.fullPath === fullPath && sealCache.mtimeMs === mtimeMs) {
    return sealCache.content
  }

  try {
    const content = fs.readFileSync(fullPath, 'utf8').slice(0, 2500)
    sealCache = { filename, fullPath, mtimeMs, content }
    return content
  } catch {
    sealCache = null
    return ''
  }
}

/**
 * archiveDaySeal 每天写完后调用，让下一次 getMostRecentSeal 强制重新读盘。
 */
export function invalidateSealCache(): void {
  sealCache = null
}
