import { dialog } from 'electron'
import { createHash } from 'node:crypto'
import { promises as fs } from 'node:fs'
import path from 'node:path'
import JSZip from 'jszip'
import { getDb, resetDatabase } from '../db'
import { getSettings, saveSettings, updateSetting, updateSettingsBatch, type SettingUpdatePatch } from '../db/settings'
import { parseJson } from '../db/json'
import { clearImportedTracksCache, getAllImportedTracks, importPlaylist as savePlaylist, type PlaylistPayload } from '../db/playlists'
import { buildInitialProfile } from './taste'
import { buildSemanticsForTracks } from './semantics'
import { clearImportTaskSnapshot, hasRunningImportTask, runImportTask } from './importTasks'
import { completeChat, LlmError } from '../llm/client'
import type { ImportPlaylistResult, LlmTestResult } from '../../types/ipc'
import { recordHealth } from './health'

export { getSettings, updateSetting, updateSettingsBatch, type SettingUpdatePatch }

const playlistImportTemplate = {
  _说明: {
    用途: '这是 Echo 通用歌单导入模板。你可以把网易云、QQ 音乐、Apple Music、Spotify 或手工整理的歌曲填到 tracks 里。',
    必填字段: ['title', 'artist'],
    选填字段: ['album', 'year', 'durationMs', 'platform', 'platformId', 'neteaseId', 'genres', 'moods', 'scenes', 'notes'],
    提示: '没有的信息可以删掉。Echo 会先用 title + artist 识别歌曲，再用选填信息辅助建立你的品味画像。',
  },
  source: 'manual',
  name: '我的常听歌单',
  tracks: [
    {
      title: '一格格',
      artist: '卫兰',
      album: 'Love And Other Things',
      year: 2017,
      platform: 'netease',
      platformId: '123456',
      neteaseId: '123456',
      genres: ['华语流行'],
      moods: ['放松', '怀旧'],
      scenes: ['夜晚', '独处'],
      notes: '晚上常听，情绪比较稳。',
    },
    {
      title: 'Cold',
      artist: 'Maroon 5 / Future',
      album: 'Red Pill Blues',
      year: 2017,
      platform: 'spotify',
      platformId: '',
      genres: ['Pop', 'R&B'],
      moods: ['轻快', '清醒'],
      notes: '适合走路或工作前半段。',
    },
  ],
}

export async function testLlm(): Promise<LlmTestResult> {
  const settings = getSettings()
  const started = Date.now()
  try {
    await completeChat(settings, [
      { role: 'system', content: '你是 Echo。只回答 ok。' },
      { role: 'user', content: 'hi' },
    ], { maxTokens: 50 })
    saveSettings({
      ...settings,
      llm: { ...settings.llm, lastTestedAt: new Date().toISOString(), lastTestedOk: true },
    }, true)
    recordHealth('llm', 'ok', '模型连接正常。')
    return { ok: true, latencyMs: Date.now() - started, message: `连接正常 ${Date.now() - started} ms` }
  } catch (error) {
    saveSettings({
      ...settings,
      llm: { ...settings.llm, lastTestedAt: new Date().toISOString(), lastTestedOk: false },
    }, true)
    const message = error instanceof LlmError ? error.message : '连接失败'
    recordHealth('llm', error instanceof LlmError && (error.kind === 'auth' || error.kind === 'config') ? 'error' : 'degraded', 'Echo 连不上模型。去设置里检查 API key。', message)
    return { ok: false, message }
  }
}

function normalizeArtists(value: unknown): string {
  if (Array.isArray(value)) return value.map(String).filter(Boolean).join(' / ')
  return String(value ?? '')
}

function normalizePlaylist(payload: unknown): PlaylistPayload {
  const parsed = payload as { name?: string; source?: string; tracks?: unknown[] }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('JSON 顶层需要是一个对象')
  }
  if (!Array.isArray(parsed.tracks)) {
    throw new Error('JSON 里需要有 tracks 数组')
  }
  const tracks = (parsed.tracks ?? []).map((item) => {
    const track = item as Record<string, unknown>
    const platform = String(track.platform ?? '').toLowerCase()
    const platformId = track.platformId ? String(track.platformId) : undefined
    const neteaseId = track.neteaseId ? String(track.neteaseId) : platform === 'netease' ? platformId : undefined
    return {
      id: track.id ? String(track.id) : undefined,
      neteaseId,
      title: String(track.title ?? track.name ?? ''),
      artist: normalizeArtists(track.artist ?? track.artists),
      album: track.album ? String(track.album) : undefined,
      year: track.year ? Number(track.year) : undefined,
      durationMs: track.durationMs ? Number(track.durationMs) : undefined,
      source: parsed.source ? String(parsed.source) : 'imported',
    }
  }).filter((track) => track.title && track.artist)
  return {
    name: parsed.name ?? '导入歌单',
    tracks,
  }
}

export async function importPlaylistFromDialog(): Promise<ImportPlaylistResult> {
  if (hasRunningImportTask()) throw new Error('已有导入任务正在进行，请稍后再试。')

  const result = await dialog.showOpenDialog({
    title: '导入歌单 JSON',
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile'],
  })
  if (result.canceled || !result.filePaths[0]) {
    return { imported: false, count: 0, message: '导入已取消' }
  }

  try {
    const selectedPath = path.resolve(result.filePaths[0])
    const fileContent = await fs.readFile(selectedPath, 'utf8')
    const payload = normalizePlaylist(JSON.parse(fileContent))
    const sourceId = createHash('sha256').update(selectedPath.toLowerCase()).digest('hex').slice(0, 20)
    payload.source = `file:${sourceId}`
    if (payload.tracks.length === 0) {
      return { imported: false, count: 0, name: payload.name, message: '没有识别到有效歌曲。每首歌至少需要 title 和 artist。' }
    }
    return await runImportTask('playlist-file', payload.name, async (report, signal) => {
      savePlaylist(payload)
      await buildSemanticsForTracks(payload.tracks, report, { signal })
      report({ phase: 'profile', current: 0, total: 1 })
      const profile = await buildInitialProfile(getAllImportedTracks())
      report({ phase: 'done', current: 1, total: 1 })
      return {
        imported: true,
        count: payload.tracks.length,
        name: payload.name,
        profile,
        message: `已导入 ${payload.tracks.length} 首`,
      }
    })
  } catch (error) {
    console.error('[settings] playlist import failed', error)
    return {
      imported: false,
      count: 0,
      message: error instanceof SyntaxError
        ? '这个文件的 JSON 格式有问题，请检查后再导入。'
        : '这次导入没有完成，请稍后再试。',
    }
  }
}

export async function downloadPlaylistTemplate(): Promise<{ ok: boolean; path?: string; message: string }> {
  const result = await dialog.showSaveDialog({
    title: '下载 Echo 歌单模板',
    defaultPath: 'echo-playlist-template.json',
    filters: [{ name: 'JSON', extensions: ['json'] }],
  })
  if (result.canceled || !result.filePath) return { ok: false, message: '已取消' }

  await fs.writeFile(result.filePath, `${JSON.stringify(playlistImportTemplate, null, 2)}\n`, 'utf8')
  return { ok: true, path: result.filePath, message: '模板已保存' }
}

export async function exportData(): Promise<{ ok: boolean; path?: string; message: string }> {
  const result = await dialog.showSaveDialog({
    title: '导出 Echo 数据',
    defaultPath: `echo-data-${new Date().toISOString().slice(0, 10)}.zip`,
    filters: [{ name: 'Zip', extensions: ['zip'] }],
  })
  if (result.canceled || !result.filePath) return { ok: false, message: '已取消' }

  const zip = new JSZip()
  const tables = [
    'users',
    'settings',
    'taste_profile',
    'events',
    'conversations',
    'conversation_summaries',
    'yinyi',
    'care_pings',
    'care_pings_mute',
    'care_ping_schedule',
    'scene_sessions',
    'scheduled_jobs',
    'service_health',
    'tracks_listened',
    'queue_history_hidden_dates',
    'favorite_tracks',
    'track_semantics',
    'recommendation_cache',
    'track_feedback',
    'track_feedback_events',
    'playlists_imported',
    'taste_questions',
    'taste_question_prompts',
    'netease_auth',
  ]
  for (const table of tables) {
    const rows = getDb().prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>
    const safeRows = rows.map((row) => {
      if (table === 'settings' && typeof row.data_json === 'string') {
        const data = parseJson<Record<string, unknown>>(row.data_json, {}, 'settings.export.data_json')
        const llm = data.llm && typeof data.llm === 'object' ? data.llm as Record<string, unknown> : {}
        if (llm.apiKey) {
          data.llm = { ...llm, apiKey: '<API_KEY_REDACTED>' }
        }
        return { ...row, data_json: JSON.stringify(data) }
      }
      if (table === 'netease_auth' && row.cookie_encrypted) {
        return { ...row, cookie_encrypted: '<NETEASE_COOKIE_REDACTED>' }
      }
      return row
    })
    zip.file(`${table}.json`, JSON.stringify(safeRows, null, 2))
  }
  const bytes = await zip.generateAsync({ type: 'nodebuffer' })
  await fs.writeFile(result.filePath, bytes)
  return { ok: true, path: result.filePath, message: '已导出' }
}

export function resetAllData(): { ok: boolean } {
  if (hasRunningImportTask()) throw new Error('导入任务还在进行，完成后再清空数据。')
  clearImportTaskSnapshot()
  resetDatabase()
  clearImportedTracksCache()
  return { ok: true }
}
