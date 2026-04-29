import { dialog } from 'electron'
import fs from 'node:fs'
import JSZip from 'jszip'
import { getDb, resetDatabase } from '../db'
import { getSettings, saveSettings, updateSetting } from '../db/settings'
import { importPlaylist as savePlaylist, type PlaylistPayload } from '../db/playlists'
import { buildInitialProfile } from './taste'
import { broadcastImportProgress, buildSemanticsForTracks } from './semantics'
import { completeChat, LlmError } from '../llm/client'
import type { ImportPlaylistResult, LlmTestResult } from '../../types/ipc'
import { recordHealth } from './health'

export { getSettings, updateSetting }

export async function testLlm(): Promise<LlmTestResult> {
  const settings = getSettings()
  const started = Date.now()
  try {
    await completeChat(settings, [
      { role: 'system', content: '你是 Echo。只回答 ok。' },
      { role: 'user', content: 'hi' },
    ])
    saveSettings({
      ...settings,
      llm: { ...settings.llm, lastTestedAt: new Date().toISOString(), lastTestedOk: true },
    })
    recordHealth('llm', 'ok', '模型连接正常。')
    return { ok: true, latencyMs: Date.now() - started, message: `连接正常 ${Date.now() - started} ms` }
  } catch (error) {
    saveSettings({
      ...settings,
      llm: { ...settings.llm, lastTestedAt: new Date().toISOString(), lastTestedOk: false },
    })
    const message = error instanceof LlmError ? error.message : '连接失败'
    recordHealth('llm', error instanceof LlmError && (error.kind === 'auth' || error.kind === 'config') ? 'error' : 'degraded', 'Echo 连不上模型。去设置里检查 API key。', message)
    return { ok: false, message }
  }
}

function normalizePlaylist(payload: unknown): PlaylistPayload {
  const parsed = payload as { name?: string; tracks?: unknown[] }
  if (!parsed || typeof parsed !== 'object') {
    throw new Error('JSON 顶层需要是一个对象')
  }
  if (!Array.isArray(parsed.tracks)) {
    throw new Error('JSON 里需要有 tracks 数组')
  }
  const tracks = (parsed.tracks ?? []).map((item) => {
    const track = item as Record<string, unknown>
    return {
      id: track.id ? String(track.id) : undefined,
      neteaseId: track.neteaseId ? String(track.neteaseId) : undefined,
      title: String(track.title ?? track.name ?? ''),
      artist: String(track.artist ?? track.artists ?? ''),
      album: track.album ? String(track.album) : undefined,
      year: track.year ? Number(track.year) : undefined,
      durationMs: track.durationMs ? Number(track.durationMs) : undefined,
      source: 'imported',
    }
  }).filter((track) => track.title && track.artist)
  return {
    name: parsed.name ?? '导入歌单',
    tracks,
  }
}

export async function importPlaylistFromDialog(): Promise<ImportPlaylistResult> {
  const result = await dialog.showOpenDialog({
    title: '导入歌单 JSON',
    filters: [{ name: 'JSON', extensions: ['json'] }],
    properties: ['openFile'],
  })
  if (result.canceled || !result.filePaths[0]) {
    return { imported: false, count: 0, message: '导入已取消' }
  }

  try {
    const payload = normalizePlaylist(JSON.parse(fs.readFileSync(result.filePaths[0], 'utf8')))
    if (payload.tracks.length === 0) {
      return { imported: false, count: 0, name: payload.name, message: '没有识别到有效歌曲。每首歌至少需要 title 和 artist。' }
    }
    savePlaylist(payload)
    const startedAt = new Date().toISOString()
    const semantics = await buildSemanticsForTracks(payload.tracks)
    broadcastImportProgress({ phase: 'profile', current: 0, total: 1, startedAt })
    const profile = await buildInitialProfile(payload.tracks)
    broadcastImportProgress({ phase: 'done', current: 1, total: 1, startedAt })
    return {
      imported: true,
      count: payload.tracks.length,
      name: payload.name,
      profile,
      message: `已导入 ${payload.tracks.length} 首，新增语义标签 ${semantics.tagged} 首`,
    }
  } catch (error) {
    return {
      imported: false,
      count: 0,
      message: error instanceof Error ? error.message : '导入失败，JSON 格式可能有问题',
    }
  }
}

export async function exportData(): Promise<{ ok: boolean; path?: string; message: string }> {
  const result = await dialog.showSaveDialog({
    title: '导出 Echo 数据',
    defaultPath: `echo-data-${new Date().toISOString().slice(0, 10)}.zip`,
    filters: [{ name: 'Zip', extensions: ['zip'] }],
  })
  if (result.canceled || !result.filePath) return { ok: false, message: '已取消' }

  const zip = new JSZip()
  const tables = ['settings', 'taste_profile', 'events', 'conversations', 'yinyi', 'scheduled_jobs', 'service_health', 'care_pings', 'care_pings_mute', 'care_ping_schedule', 'tracks_listened', 'favorite_tracks', 'track_feedback', 'track_semantics', 'recommendation_cache', 'playlists_imported', 'taste_questions', 'netease_auth']
  for (const table of tables) {
    const rows = getDb().prepare(`SELECT * FROM ${table}`).all() as Array<Record<string, unknown>>
    const safeRows = rows.map((row) => {
      if (table === 'settings' && typeof row.data_json === 'string') {
        const data = JSON.parse(row.data_json)
        if (data.llm?.apiKey) data.llm.apiKey = '<API_KEY_REDACTED>'
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
  fs.writeFileSync(result.filePath, bytes)
  return { ok: true, path: result.filePath, message: '已导出' }
}

export function resetAllData(): { ok: boolean } {
  resetDatabase()
  return { ok: true }
}
