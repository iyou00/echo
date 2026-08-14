import { describe, expect, it } from 'vitest'
import type { PlaybackState, RuntimeTaskSnapshot } from '../types/ipc'
import { buildCloseReadiness } from './closeReadiness'

const idle: PlaybackState = { current: null, position: 0, duration: 0, status: 'idle', volume: 30, queue: [], history: [] }

describe('close readiness', () => {
  it('does not show a busy warning for an idle app', () => {
    expect(buildCloseReadiness(idle, [])).toEqual({ activities: [], boundary: undefined })
  })

  it('summarizes playback and running tasks without stopping either one', () => {
    const playback: PlaybackState = {
      ...idle,
      status: 'playing',
      current: { title: '偏爱', artist: '张芸京', playbackInstanceId: 'play-1' },
    }
    const task: RuntimeTaskSnapshot = {
      id: 'task-1', kind: 'playlist-import', status: 'running', phase: 'semantics', current: 2, total: 4,
      startedAt: '', updatedAt: '', sourceName: '常听歌单', message: '正在整理歌曲', cancellable: true, visibility: 'user',
    }

    const result = buildCloseReadiness(playback, [task])

    expect(result.boundary?.code).toBe('close_busy')
    expect(result.activities.map((item) => item.kind)).toEqual(['playback', 'task'])
    expect(result.activities[0]?.label).toContain('偏爱')
  })

  it('ignores completed tasks', () => {
    const completed: RuntimeTaskSnapshot = {
      id: 'task-2', kind: 'yinyi', status: 'succeeded', phase: 'done', current: 1, total: 1,
      startedAt: '', updatedAt: '', cancellable: false, visibility: 'user',
    }
    expect(buildCloseReadiness(idle, [completed]).activities).toEqual([])
  })
})
