import { randomUUID } from 'node:crypto'
import type { ActiveScene, SceneKey, Track } from '../../types/ipc'

export type SceneJourneyRole = 'transition' | 'lift' | 'hold' | 'settle' | 'explore' | 'reset'

export interface SceneJourneyStep {
  role: SceneJourneyRole
  energy: 'low' | 'medium' | 'high'
  tempo: 'slow' | 'medium' | 'fast'
  familiarity: 'safe' | 'balanced' | 'explore'
  query: string
}

const JOURNEYS: Record<SceneKey, SceneJourneyStep[]> = {
  focus: [
    { role: 'transition', energy: 'low', tempo: 'slow', familiarity: 'safe', query: '安静 低存在感 平滑过渡' },
    { role: 'hold', energy: 'low', tempo: 'slow', familiarity: 'balanced', query: '稳定 专注 背景音乐' },
    { role: 'hold', energy: 'low', tempo: 'medium', familiarity: 'balanced', query: '克制 节奏稳定 工作' },
  ],
  sleepy: [
    { role: 'transition', energy: 'medium', tempo: 'medium', familiarity: 'safe', query: '温和提神 熟悉 轻快' },
    { role: 'lift', energy: 'high', tempo: 'medium', familiarity: 'balanced', query: '明亮 清醒 有节奏' },
    { role: 'hold', energy: 'medium', tempo: 'medium', familiarity: 'balanced', query: '清醒 稳定 不吵' },
  ],
  relax: [
    { role: 'transition', energy: 'low', tempo: 'slow', familiarity: 'safe', query: '卸力 轻柔 熟悉' },
    { role: 'settle', energy: 'low', tempo: 'slow', familiarity: 'balanced', query: '舒展 放松 温和' },
    { role: 'hold', energy: 'medium', tempo: 'medium', familiarity: 'balanced', query: '轻盈 松弛 清新' },
  ],
  irritated: [
    { role: 'transition', energy: 'low', tempo: 'slow', familiarity: 'safe', query: '低刺激 安静 熟悉' },
    { role: 'settle', energy: 'low', tempo: 'slow', familiarity: 'balanced', query: '平静 舒缓 克制' },
    { role: 'hold', energy: 'medium', tempo: 'slow', familiarity: 'balanced', query: '慢慢打开 温和 有力量' },
  ],
  random: [
    { role: 'transition', energy: 'medium', tempo: 'medium', familiarity: 'safe', query: '口味内 熟悉 好进入' },
    { role: 'explore', energy: 'medium', tempo: 'medium', familiarity: 'explore', query: '新鲜 探索 不冒进' },
    { role: 'hold', energy: 'medium', tempo: 'medium', familiarity: 'balanced', query: '舒服 耐听 有一点意外' },
  ],
}

function isNegative(track: Track): boolean {
  return track.queueStatus === 'skipped'
    && (!track.queueStatusReason || track.queueStatusReason === 'playback_skipped' || track.queueStatusReason === 'explicit_feedback')
}

export function shouldResetSceneDirection(recentTracks: Track[]): boolean {
  return recentTracks.slice(0, 3).filter(isNegative).length >= 2
}

export function sceneJourneyStep(key: SceneKey, deliveredCount: number, recentTracks: Track[] = [], hour = new Date().getHours()): SceneJourneyStep {
  if (shouldResetSceneDirection(recentTracks)) {
    return { role: 'reset', energy: 'low', tempo: 'slow', familiarity: 'safe', query: '换个方向 熟悉 温和 好进入' }
  }
  const steps = JOURNEYS[key]
  const index = Math.min(Math.max(0, deliveredCount), steps.length - 1)
  const step = steps[index]
  if (key === 'sleepy' && (hour >= 23 || hour < 6)) {
    return { ...step, energy: 'low', tempo: 'slow', familiarity: 'safe', query: '深夜 温和 清醒 不刺激' }
  }
  return step
}

export function sceneJourneyQuery(label: string, step: SceneJourneyStep): string {
  return `${label} ${step.query} 歌曲`
}

function journeyFitScore(track: Track, step: SceneJourneyStep): number {
  const semantic = track.semantic
  if (!semantic) return 0
  const energy = { low: 0.2, medium: 0.55, high: 0.85 }[step.energy]
  const tempoScore = semantic.tempo === step.tempo ? 1 : 0
  const familiarityScore = step.familiarity === 'balanced' || semantic.familiarity === step.familiarity ? 1 : 0
  return (1 - Math.abs(semantic.energy - energy)) * 2 + tempoScore + familiarityScore
}

export function arrangeSceneJourneyTracks(
  key: SceneKey,
  deliveredCount: number,
  candidates: Track[],
  targetCount: number,
  recentTracks: Track[] = [],
  hour = new Date().getHours(),
): Track[] {
  const remaining = [...candidates]
  const arranged: Track[] = []
  for (let offset = 0; offset < targetCount && remaining.length > 0; offset += 1) {
    const step = sceneJourneyStep(key, deliveredCount + offset, recentTracks, hour)
    let bestIndex = 0
    let bestScore = Number.NEGATIVE_INFINITY
    remaining.forEach((track, index) => {
      const score = journeyFitScore(track, step)
      if (score > bestScore) {
        bestScore = score
        bestIndex = index
      }
    })
    const [track] = remaining.splice(bestIndex, 1)
    arranged.push({ ...track, sceneJourneyRole: step.role, sceneJourneyIndex: deliveredCount + offset })
  }
  return arranged
}

export function scenePreferenceTerms(tracks: Track[], key: SceneKey, minimumEvidence = 6): string[] {
  const positive = tracks.filter((track) => (
    track.sceneKey === key
    && (track.queueStatus === 'completed' || track.favorited)
    && track.queueStatusReason !== 'explicit_feedback'
  ))
  if (positive.length < minimumEvidence) return []
  const counts = new Map<string, number>()
  for (const track of positive) {
    for (const term of [...(track.semantic?.moods ?? []), ...(track.semantic?.genres ?? [])]) {
      const clean = term.trim()
      if (clean) counts.set(clean, (counts.get(clean) ?? 0) + 1)
    }
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0], 'zh-CN'))
    .slice(0, 2)
    .map(([term]) => term)
}

export function sceneOutcomeCounts(tracks: Track[]): { played: number; completed: number; skipped: number } {
  const played = tracks.filter((track) => (
    track.queueStatus === 'playing'
    || track.queueStatus === 'completed'
    || isNegative(track)
  ))
  return {
    played: played.length,
    completed: played.filter((track) => track.queueStatus === 'completed').length,
    skipped: played.filter(isNegative).length,
  }
}

export function attachSceneAdjustmentTracks(scene: ActiveScene, tracks: Track[]): Track[] {
  if (tracks.length === 0) return tracks
  const adjustmentBatchId = `${scene.id}:${randomUUID()}`
  return tracks.map((track) => ({
    ...track,
    sourceContext: 'scene',
    sceneKey: scene.key,
    sceneLabel: scene.label,
    sceneLine: scene.line,
    sceneSessionId: scene.id,
    sceneJourneyRole: 'reset',
    sceneAdjustmentBatchId: adjustmentBatchId,
    reason: track.reason ?? scene.line,
    echoNote: track.echoNote ?? track.reason ?? scene.line,
  }))
}

export function sceneQueueAfterAdjustment(queue: Track[], next: Track): { kept: Track[]; replaced: Track[] } {
  if (next.sceneJourneyRole !== 'reset' || !next.sceneSessionId) return { kept: queue, replaced: [] }
  const belongsToReplacedBuffer = (track: Track) => (
    track.sceneSessionId === next.sceneSessionId
    && (!next.sceneAdjustmentBatchId || track.sceneAdjustmentBatchId !== next.sceneAdjustmentBatchId)
  )
  const replaced = queue.filter(belongsToReplacedBuffer)
  return {
    kept: queue.filter((track) => !belongsToReplacedBuffer(track)),
    replaced,
  }
}
