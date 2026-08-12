import { describe, expect, it } from 'vitest'
import type { ActiveScene, Track } from '../../types/ipc'
import { arrangeSceneJourneyTracks, attachSceneAdjustmentTracks, sceneOutcomeCounts, scenePreferenceTerms, sceneJourneyStep, sceneQueueAfterAdjustment, shouldResetSceneDirection } from './sceneJourney'

describe('scene journey', () => {
  it('gives every scene a deliberate progression', () => {
    expect(sceneJourneyStep('focus', 0, [], 14).role).toBe('transition')
    expect(sceneJourneyStep('sleepy', 1, [], 14).role).toBe('lift')
    expect(sceneJourneyStep('relax', 2, [], 14).role).toBe('hold')
    expect(sceneJourneyStep('irritated', 1, [], 14).role).toBe('settle')
    expect(sceneJourneyStep('random', 1, [], 14).role).toBe('explore')
  })

  it('keeps late-night sleepy playback gentle instead of forcing high energy', () => {
    expect(sceneJourneyStep('sleepy', 1, [], 1)).toMatchObject({ energy: 'low', tempo: 'slow', familiarity: 'safe' })
  })

  it('changes direction only after repeated negative outcomes', () => {
    const skipped = (id: string): Track => ({ id, title: id, artist: 'Echo', queueStatus: 'skipped' })
    expect(shouldResetSceneDirection([skipped('1')])).toBe(false)
    expect(shouldResetSceneDirection([skipped('1'), { id: '2', title: '2', artist: 'Echo', queueStatus: 'completed' }, skipped('3')])).toBe(true)
    expect(shouldResetSceneDirection([
      { ...skipped('1'), queueStatusReason: 'scene_replaced' },
      { ...skipped('2'), queueStatusReason: 'queue_removed' },
    ])).toBe(false)
    expect(sceneJourneyStep('sleepy', 2, [skipped('1'), skipped('2')], 14).role).toBe('reset')
  })

  it('arranges one recalled pool into different journey roles', () => {
    const tracks: Track[] = [
      { id: 'bright', title: '明亮', artist: '甲', semantic: { language: '华语', genres: [], moods: [], scenes: [], energy: 0.85, tempo: 'medium', familiarity: 'explore', confidence: 1 } },
      { id: 'gentle', title: '温和', artist: '乙', semantic: { language: '华语', genres: [], moods: [], scenes: [], energy: 0.3, tempo: 'medium', familiarity: 'safe', confidence: 1 } },
      { id: 'steady', title: '稳定', artist: '丙', semantic: { language: '华语', genres: [], moods: [], scenes: [], energy: 0.55, tempo: 'medium', familiarity: 'safe', confidence: 1 } },
    ]
    const arranged = arrangeSceneJourneyTracks('sleepy', 0, tracks, 3, [], 14)

    expect(arranged.map((track) => track.id)).toEqual(['steady', 'bright', 'gentle'])
    expect(arranged.map((track) => track.sceneJourneyRole)).toEqual(['transition', 'lift', 'hold'])
  })

  it('learns scene-specific terms only after enough positive evidence', () => {
    const tracks: Track[] = Array.from({ length: 6 }, (_, index) => ({
      id: String(index), title: String(index), artist: 'Echo', sceneKey: 'focus', queueStatus: 'completed',
      semantic: { language: '华语', genres: ['民谣'], moods: ['安静'], scenes: [], energy: 0.2, tempo: 'slow', familiarity: 'safe', confidence: 1 },
    }))
    expect(scenePreferenceTerms(tracks.slice(0, 5), 'focus')).toEqual([])
    expect(scenePreferenceTerms(tracks, 'focus')).toEqual(['安静', '民谣'])
    expect(sceneOutcomeCounts([
      ...tracks,
      { title: '跳过', artist: 'Echo', queueStatus: 'skipped' },
      { title: '待播', artist: 'Echo', queueStatus: 'pending' },
      { title: '被替换', artist: 'Echo', queueStatus: 'skipped', queueStatusReason: 'scene_replaced' },
    ])).toEqual({ played: 7, completed: 6, skipped: 1 })
  })

  it('drops the old scene buffer after an explicit direction change', () => {
    const old: Track = { id: 'old', title: '旧方向', artist: '甲', sceneSessionId: 7 }
    const ordinary: Track = { id: 'ordinary', title: '普通队列', artist: '乙' }
    const reset: Track = { id: 'new', title: '新方向', artist: '丙', sceneSessionId: 7, sceneJourneyRole: 'reset' }

    expect(sceneQueueAfterAdjustment([old, ordinary], reset)).toEqual({ kept: [ordinary], replaced: [old] })
  })

  it('keeps sibling recommendations from the same scene adjustment batch', () => {
    const old: Track = { id: 'old', title: '旧方向', artist: '甲', sceneSessionId: 7 }
    const sibling: Track = {
      id: 'sibling', title: '同轮推荐', artist: '乙', sceneSessionId: 7,
      sceneJourneyRole: 'reset', sceneAdjustmentBatchId: 'batch-1',
    }
    const selected: Track = {
      id: 'selected', title: '当前选择', artist: '丙', sceneSessionId: 7,
      sceneJourneyRole: 'reset', sceneAdjustmentBatchId: 'batch-1',
    }

    expect(sceneQueueAfterAdjustment([old, sibling], selected)).toEqual({ kept: [sibling], replaced: [old] })
  })

  it('marks every recommendation in one user adjustment as the same reset batch', () => {
    const scene: ActiveScene = {
      id: 7, key: 'focus', label: '专注', shortLabel: '专注', line: '安静一点', prompt: '专注音乐', targetCount: 3,
      moods: ['安静'], scenes: ['工作'], energy: 'low', tempo: 'slow', familiarity: 'balanced',
      startedAt: '2026-08-11T08:00:00.000Z', expiresAt: '2026-08-11T10:00:00.000Z', status: 'active',
    }
    const attached = attachSceneAdjustmentTracks(scene, [
      { id: '1', title: '一', artist: '甲' },
      { id: '2', title: '二', artist: '乙' },
    ])

    expect(attached).toHaveLength(2)
    expect(attached[0].sceneAdjustmentBatchId).toBeTruthy()
    expect(attached[1].sceneAdjustmentBatchId).toBe(attached[0].sceneAdjustmentBatchId)
    expect(attached.every((track) => track.sceneJourneyRole === 'reset' && track.sceneSessionId === scene.id)).toBe(true)
  })
})
