import type { Track } from '../../../types/ipc'
import { getSettings } from '../../db/settings'
import { completeChat } from '../../llm/client'
import type { RecommendationIntent } from './intent'
import { parseJsonObject, trackKey, uniqueTracks } from './text'

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
    if (intent.energy === 'high') return '这首能把注意力提起来,现在接上比较顺。'
    return '这首温度刚好,先听它。'
  }
  return reasons[index] ?? `第 ${index + 1} 首换一点颜色,让这组歌更完整。`
}

export async function selectFinalTracks(text: string, candidates: Track[], intent: RecommendationIntent, signal?: AbortSignal): Promise<Track[]> {
  const targetCount = intent.targetCount
  if (candidates.length <= targetCount) return candidates.map((track, index) => ({ ...track, reason: track.reason ?? fallbackReason(track, index, intent) }))
  assertSelectionActive(signal)
  const settings = getSettings()
  const list = candidates
    .slice(0, Math.max(20, targetCount * 8))
    .map((track, index) => `${index + 1}. ${track.title} - ${track.artist}${track.album ? ` / ${track.album}` : ''} / ${track.recommendSource ?? 'search'}`)
    .join('\n')
  try {
    const content = await completeChat(settings, [
      {
        role: 'system',
        content: `你是 Echo 的最终推荐排序器。只能从候选中选 ${targetCount} 首。
输出严格 JSON: {"indexes":[数字],"notes":["每首一句中文理由"]}。
indexes 数量必须是 ${targetCount}。理由要具体,每首理由要有差异。`,
      },
      {
        role: 'user',
        content: `用户说:${text}
解析意图:${JSON.stringify(intent)}
候选:
${list}`,
      },
    ], { temperature: 0.45, signal })
    assertSelectionActive(signal)
    const parsed = parseJsonObject(content)
    const indexes = Array.isArray(parsed?.indexes) ? parsed.indexes.map(Number).filter((item) => Number.isInteger(item)) : []
    const notes = Array.isArray(parsed?.notes) ? parsed.notes.map(String) : []
    const selected = indexes
      .map((index) => candidates[index - 1])
      .filter((track): track is Track => Boolean(track))
      .slice(0, targetCount)
      .map((track, index) => ({ ...track, reason: notes[index] || fallbackReason(track, index, intent) }))
    const filled = uniqueTracks([
      ...selected,
      ...candidates.filter((track) => !selected.some((item) => trackKey(item) === trackKey(track))),
    ]).slice(0, targetCount)
    return filled.length ? filled.map((track, index) => ({ ...track, reason: track.reason ?? fallbackReason(track, index, intent) })) : candidates.slice(0, targetCount).map((track, index) => ({ ...track, reason: fallbackReason(track, index, intent) }))
  } catch {
    return candidates.slice(0, targetCount).map((track, index) => ({ ...track, reason: fallbackReason(track, index, intent) }))
  }
}
