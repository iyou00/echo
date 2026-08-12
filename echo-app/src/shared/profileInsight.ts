import type { ProfileInsight } from '../types/ipc'

export function profileInsightConfirmationSignal(insight: Pick<ProfileInsight, 'kind' | 'subject' | 'direction'>): {
  kind: string
  payload: Record<string, unknown>
} {
  const decreasing = insight.direction === 'down'
  if (insight.kind === 'genre') {
    return { kind: decreasing ? 'soften_genre' : 'like_genre', payload: { target: insight.subject, strength: 0.08 } }
  }
  if (insight.kind === 'mood') {
    return { kind: decreasing ? 'soften_vibe' : 'reinforce_vibe', payload: { target: insight.subject, strength: 0.08 } }
  }
  if (insight.kind === 'energy') {
    return { kind: decreasing ? 'lower_energy' : 'raise_energy', payload: { target: insight.subject, strength: 0.06 } }
  }
  return { kind: decreasing ? 'soften_scene' : 'reinforce_scene', payload: { target: insight.subject, strength: 0.08 } }
}
