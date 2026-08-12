import { describe, expect, it } from 'vitest'
import type { ProfileTrackEvent } from '../db/tracks'
import type { Track, TrackSemantic } from '../../types/ipc'
import { profileInsightConfirmationSignal } from '../../shared/profileInsight'
import { buildRecentProfileInsights, filterAcknowledgedProfileInsights } from './profileInsights'

function event(day: string, genre: string, sourceContext?: Track['sourceContext']): ProfileTrackEvent {
  return {
    track: {
      title: `${genre}-${day}`,
      artist: genre,
      sourceContext,
      semantic: {
        language: '华语', genres: [genre], moods: [genre], scenes: ['夜晚'],
        energy: genre === '摇滚' ? 0.8 : 0.3, tempo: genre === '摇滚' ? 'fast' : 'slow',
        familiarity: 'safe', confidence: 0.8,
      },
    },
    source: sourceContext ? 'recommended_by_echo' : 'external_player',
    listenedAt: `${day}T20:00:00+08:00`,
    queueStatus: 'completed',
  }
}

const semanticFor = (track: Track): TrackSemantic => track.semantic as TrackSemantic

describe('profile recent insights', () => {
  it('maps confirmation by insight kind and direction', () => {
    expect(profileInsightConfirmationSignal({ kind: 'genre', subject: '摇滚', direction: 'up' }).kind).toBe('like_genre')
    expect(profileInsightConfirmationSignal({ kind: 'genre', subject: '民谣', direction: 'down' }).kind).toBe('soften_genre')
    expect(profileInsightConfirmationSignal({ kind: 'mood', subject: '松弛', direction: 'up' }).kind).toBe('reinforce_vibe')
    expect(profileInsightConfirmationSignal({ kind: 'mood', subject: '伤感', direction: 'down' }).kind).toBe('soften_vibe')
    expect(profileInsightConfirmationSignal({ kind: 'energy', subject: '音乐能量', direction: 'up' }).kind).toBe('raise_energy')
    expect(profileInsightConfirmationSignal({ kind: 'scene', subject: '通勤', direction: 'down' }).kind).toBe('soften_scene')
  })

  it('hides an acknowledged insight while leaving unrelated changes visible', () => {
    const insights = [
      { id: 'genre:摇滚:up', kind: 'genre' as const, subject: '摇滚', statement: '摇滚这阵子更常出现了', direction: 'up' as const, confidence: 'medium' as const, evidenceLabel: '跨天变化' },
      { id: 'mood:松弛:up', kind: 'mood' as const, subject: '松弛', statement: '松弛这阵子更常出现了', direction: 'up' as const, confidence: 'medium' as const, evidenceLabel: '跨天变化' },
    ]

    expect(filterAcknowledgedProfileInsights(insights, ['genre:摇滚:up'])).toEqual([insights[1]])
  })

  it('does not turn passive Echo continuation into a recent change', () => {
    const recent = Array.from({ length: 30 }, (_, index) => event(index % 2 ? '2026-08-10' : '2026-08-09', '摇滚', 'voice'))
    const baseline = Array.from({ length: 6 }, (_, index) => event(index % 2 ? '2026-08-03' : '2026-08-02', '民谣'))

    expect(buildRecentProfileInsights(recent, baseline, semanticFor).recentChanges).toEqual([])
  })

  it('reports a cross-day change only when active evidence clears the threshold', () => {
    const recent = Array.from({ length: 6 }, (_, index) => event(index % 2 ? '2026-08-10' : '2026-08-09', '摇滚'))
    const baseline = Array.from({ length: 6 }, (_, index) => event(index % 2 ? '2026-08-03' : '2026-08-02', '民谣'))
    const result = buildRecentProfileInsights(recent, baseline, semanticFor)

    expect(result.activeDays).toBe(2)
    expect(result.recentChanges.some((item) => item.kind === 'genre' && item.subject === '摇滚' && item.direction === 'up')).toBe(true)
    expect(result.recentChanges.every((item) => !item.statement.includes('%'))).toBe(true)
  })
})
