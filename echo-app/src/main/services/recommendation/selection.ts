import type { Track } from '../../../types/ipc'
import { getSettings } from '../../db/settings'
import { completeChat } from '../../llm/client'
import { safePromptJson } from '../../llm/promptData'
import type { RecommendationIntent } from './intent'
import { parseJsonObject, uniqueTracks } from './text'

function assertSelectionActive(signal?: AbortSignal): void {
  if (signal?.aborted) throw new DOMException('任务已取消', 'AbortError')
}

export function fallbackReason(track: Track, index: number, intent: RecommendationIntent): string {
  const reasons = intent.energy === 'low' || intent.tempo === 'slow'
    ? ['第一首先把节奏放慢,入口轻一点。', '第二首继续松弛一点,让耳朵歇一会。', '第三首留在后面,把这段情绪慢慢收住。']
    : intent.energy === 'high'
      ? ['第一首先提气,让注意力醒过来。', '第二首续住速度,适合继续做事。', '第三首把能量放稳,听完不会散。']
      : ['第一首先试温度,比较容易进去。', '第二首换一点颜色,让这组歌有变化。', '第三首放在后面,听完还有余味。']
  if (intent.targetCount === 1) {
    if (intent.energy === 'low' || intent.tempo === 'slow') return '这首入口轻,适合先把节奏放慢。'
    if (intent.energy === 'high') return '这首能把注意力提起来,现在听比较顺。'
    return '这首温度刚好,先听它。'
  }
  return reasons[index] ?? `第 ${index + 1} 首换一点颜色,让这组歌更完整。`
}

export async function selectFinalTracks(text: string, candidates: Track[], intent: RecommendationIntent, signal?: AbortSignal): Promise<Track[]> {
  const targetCount = intent.targetCount
  if (candidates.length <= targetCount) return candidates.map((track, index) => ({ ...track, reason: track.reason ?? fallbackReason(track, index, intent) }))
  assertSelectionActive(signal)
  const selected = uniqueTracks(candidates).slice(0, targetCount)
  const settings = getSettings()
  const promptData = {
    userText: text,
    intent,
    candidates: selected.map((track, index) => ({
      index: index + 1,
      title: track.title,
      artist: track.artist,
      album: track.album,
      source: track.recommendSource ?? 'search',
    })),
  }
  try {
    const content = await completeChat(settings, [
      {
        role: 'system',
        content: `你是 Echo 的推荐理由编辑器。歌曲顺序已经固定,不能增删、换歌或改顺序。
输出严格 JSON: {"notes":["每首一句中文理由"]}。
notes 数量必须是 ${selected.length}。理由要具体,每首理由要有差异。`,
      },
      {
        role: 'user',
        content: safePromptJson(promptData),
      },
    ], { temperature: 0, signal, maxTokens: 200 })
    assertSelectionActive(signal)
    const parsed = parseJsonObject(content)
    const notes = Array.isArray(parsed?.notes) ? parsed.notes.map(String) : []
    return selected.map((track, index) => ({ ...track, reason: notes[index] || track.reason || fallbackReason(track, index, intent) }))
  } catch {
    return selected.map((track, index) => ({ ...track, reason: track.reason ?? fallbackReason(track, index, intent) }))
  }
}
