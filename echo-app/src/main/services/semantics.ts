import type { ImportProgressPayload, SemanticSummary, Track, TrackSemantic } from '../../types/ipc'
import { getAllImportedTracks } from '../db/playlists'
import { getSemanticSummary as readSemanticSummary, splitMissingSemantics, upsertTrackSemantic } from '../db/semantics'
import { completeChat, LlmError } from '../llm/client'
import { safePromptJson } from '../llm/promptData'
import { getSettings } from '../db/settings'
import { reportStandaloneImportProgress, runImportTask } from './importTasks'

export function broadcastImportProgress(payload: ImportProgressPayload): void {
  reportStandaloneImportProgress(payload)
}

const GENRES = ['华语流行', '粤语流行', '欧美流行', 'R&B', '民谣', '摇滚', '说唱', '电子', 'K-pop', '日语流行', '轻音乐']
const MOODS = ['放松', '发呆', '清醒', '治愈', '怀旧', '孤独', '轻快', '热烈', '松弛', '陪伴']
const SCENES = ['上午', '午休', '下午工作', '通勤', '下班路上', '夜晚', '睡前', '雨天', '独处', '运动']

function clamp(value: number): number {
  return Math.max(0, Math.min(1, Number(value.toFixed(2))))
}

function hasChinese(text: string): boolean {
  return /[\u4e00-\u9fff]/.test(text)
}

function inferLanguage(track: Track): string {
  const text = `${track.title} ${track.artist} ${track.album ?? ''}`
  if (/陈慧娴|张学友|陈奕迅|Beyond|容祖儿|杨千嬅|粤|广东|香港/.test(text)) return '粤语'
  if (/newjeans|blackpink|twice|bts|exo|seventeen|stray kids|k-pop|kpop/i.test(text)) return '韩语'
  if (/yoasobi|aimyon|ado|one ok rock|宇多田|米津|日语|日本/.test(text)) return '日语'
  if (hasChinese(text)) return '华语'
  return '英语'
}

function inferGenres(track: Track, language: string): string[] {
  const text = `${track.title} ${track.artist} ${track.album ?? ''}`.toLowerCase()
  if (/rap|说唱|hip.?hop/.test(text)) return ['说唱']
  if (/r&b|rhythm/.test(text)) return ['R&B']
  if (/rock|摇滚|band|乐队/.test(text)) return ['摇滚']
  if (/folk|民谣/.test(text)) return ['民谣']
  if (/electro|edm|电子|remix|dj/.test(text)) return ['电子']
  if (language === '粤语') return ['粤语流行']
  if (language === '韩语') return ['K-pop']
  if (language === '日语') return ['日语流行']
  if (language === '英语') return ['欧美流行']
  return ['华语流行']
}

function inferMoods(track: Track): string[] {
  const text = `${track.title} ${track.artist} ${track.album ?? ''}`.toLowerCase()
  const moods: string[] = []
  if (/夜|晚|moon|dream|sleep|孤|雪|雨|sad|blue|miss|想|怀念|飘/.test(text)) moods.push('孤独', '怀旧')
  if (/阳光|快乐|happy|love|甜|summer|dance|season|training/.test(text)) moods.push('轻快')
  if (/云|海|风|普通|慢|calm|soft|home|回家/.test(text)) moods.push('放松', '松弛')
  if (/醒|run|fire|少年|骄傲|power/.test(text)) moods.push('清醒', '热烈')
  if (moods.length === 0) moods.push('陪伴', '治愈')
  return Array.from(new Set(moods)).slice(0, 3)
}

function inferScenes(track: Track, moods: string[]): string[] {
  const text = `${track.title} ${track.artist} ${track.album ?? ''}`.toLowerCase()
  if (/夜|晚|sleep|moon|孤/.test(text)) return ['夜晚', '睡前', '独处']
  if (/雨|雪/.test(text)) return ['雨天', '独处']
  if (moods.includes('清醒') || moods.includes('热烈')) return ['下午工作', '运动']
  if (moods.includes('轻快')) return ['通勤', '上午']
  return ['下班路上', '夜晚']
}

export function inferTrackSemanticFallback(track: Track): TrackSemantic {
  const language = inferLanguage(track)
  const moods = inferMoods(track)
  const energy = moods.includes('热烈') || moods.includes('清醒') ? 0.78 : moods.includes('轻快') ? 0.62 : 0.38
  return {
    language,
    genres: inferGenres(track, language),
    moods,
    scenes: inferScenes(track, moods),
    energy,
    tempo: energy > 0.7 ? 'fast' : energy < 0.45 ? 'slow' : 'medium',
    familiarity: 'safe',
    confidence: 0.52,
  }
}

function parseJsonArray(text: string): unknown[] | null {
  const match = text.match(/\[[\s\S]*\]/)
  if (!match) return null
  try {
    const parsed = JSON.parse(match[0]) as unknown
    return Array.isArray(parsed) ? parsed : null
  } catch {
    return null
  }
}

function normalizeSemantic(value: unknown, fallback: TrackSemantic): TrackSemantic {
  const raw = value && typeof value === 'object' ? value as Record<string, unknown> : {}
  const genres = Array.isArray(raw.genres) ? raw.genres.map(String).filter((item) => GENRES.includes(item)).slice(0, 3) : []
  const moods = Array.isArray(raw.moods) ? raw.moods.map(String).filter((item) => MOODS.includes(item)).slice(0, 3) : []
  const scenes = Array.isArray(raw.scenes) ? raw.scenes.map(String).filter((item) => SCENES.includes(item)).slice(0, 3) : []
  const tempo = raw.tempo === 'slow' || raw.tempo === 'medium' || raw.tempo === 'fast' ? raw.tempo : fallback.tempo
  const familiarity = raw.familiarity === 'explore' ? 'explore' : 'safe'
  return {
    language: typeof raw.language === 'string' && raw.language.trim() ? raw.language.trim() : fallback.language,
    genres: genres.length ? genres : fallback.genres,
    moods: moods.length ? moods : fallback.moods,
    scenes: scenes.length ? scenes : fallback.scenes,
    energy: clamp(typeof raw.energy === 'number' ? raw.energy : fallback.energy),
    tempo,
    familiarity,
    confidence: clamp(typeof raw.confidence === 'number' ? raw.confidence : 0.7),
  }
}

function assertSemanticsActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('任务已取消', 'AbortError')
}

async function tagBatchWithLlm(tracks: Track[], signal?: AbortSignal): Promise<TrackSemantic[]> {
  assertSemanticsActive(signal)
  const settings = getSettings()
  const fallbacks = tracks.map(inferTrackSemanticFallback)
  try {
    const response = await completeChat(settings, [
      {
        role: 'system',
        content: `你是 Echo 的歌曲语义标注器。只输出 JSON 数组,数组长度必须等于输入歌曲数。
每项字段: language, genres, moods, scenes, energy, tempo, familiarity, confidence。
genres 只能用:${GENRES.join('、')}。
moods 只能用:${MOODS.join('、')}。
scenes 只能用:${SCENES.join('、')}。
energy/confidence 是 0-1 数字。tempo 是 slow/medium/fast。familiarity 对导入歌单统一 safe。`,
      },
      {
        role: 'user',
        content: safePromptJson({
          tracks: tracks.map((track, index) => ({
            index: index + 1,
            title: track.title,
            artist: track.artist,
            album: track.album,
            year: track.year,
          })),
        }),
      },
    ], { temperature: 0.2, signal, maxTokens: Math.min(5000, Math.max(900, tracks.length * 180)) })
    assertSemanticsActive(signal)
    const parsed = parseJsonArray(response)
    if (!parsed || parsed.length !== tracks.length) return fallbacks
    return parsed.map((item, index) => normalizeSemantic(item, fallbacks[index]))
  } catch (error) {
    if (error instanceof LlmError && error.kind === 'config') return fallbacks
    return fallbacks
  }
}

export async function buildSemanticsForTracks(
  tracks: Track[],
  reportProgress?: (payload: Omit<ImportProgressPayload, 'startedAt'>) => void,
  options: { signal?: AbortSignal } = {},
): Promise<{ tagged: number; skipped: number }> {
  assertSemanticsActive(options.signal)
  const valid = tracks.filter((track) => track.title && track.artist)
  const settings = getSettings()
  const hasLlmConfig = Boolean(settings.llm.baseUrl && settings.llm.apiKey && settings.llm.model)
  if (!hasLlmConfig) return { tagged: 0, skipped: valid.length }
  const { missing, skipped } = splitMissingSemantics(valid, { includeLowConfidence: true, confidenceBelow: 0.6 })
  const startedAt = new Date().toISOString()
  const total = missing.length
  let tagged = 0
  const report = (payload: Omit<ImportProgressPayload, 'startedAt'>) => {
    if (reportProgress) {
      reportProgress(payload)
      return
    }
    broadcastImportProgress({ ...payload, startedAt })
  }

  if (total > 0) {
    report({ phase: 'semantics', current: 0, total })
  }

  for (let index = 0; index < total; index += 25) {
    assertSemanticsActive(options.signal)
    const batch = missing.slice(index, index + 25)
    const semantics = await tagBatchWithLlm(batch, options.signal)
    assertSemanticsActive(options.signal)
    batch.forEach((track, itemIndex) => {
      upsertTrackSemantic(track, semantics[itemIndex] ?? inferTrackSemanticFallback(track))
      tagged += 1
    })
    report({ phase: 'semantics', current: tagged, total })
  }
  return { tagged, skipped }
}

export function buildForImportedTracks(): Promise<{ tagged: number; skipped: number }> {
  return runImportTask('semantic-analysis', '已导入歌曲', (report, signal) => buildSemanticsForTracks(getAllImportedTracks(), report, { signal }))
}

export function getSummary(): SemanticSummary {
  return readSemanticSummary()
}
