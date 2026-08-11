import { describe, expect, it, vi } from 'vitest'
import {
  refreshProfileAfterSemanticUpdateAction,
  semanticBackfillResultStatus,
  shouldRefreshProfileAfterSemanticBackfill,
  shouldRefreshProfileForSemanticTask,
} from './settingsSemanticRefresh'

describe('settings semantic profile refresh', () => {
  it('ignores completed semantic tasks from an earlier settings mount', () => {
    expect(shouldRefreshProfileForSemanticTask({
      kind: 'semantic-analysis',
      status: 'succeeded',
      updatedAt: '2026-06-23T01:00:00.000Z',
    }, new Date('2026-06-23T01:00:01.000Z').getTime())).toBe(false)
  })

  it('accepts semantic tasks that complete after settings is mounted', () => {
    expect(shouldRefreshProfileForSemanticTask({
      kind: 'semantic-analysis',
      status: 'succeeded',
      updatedAt: '2026-06-23T01:00:02.000Z',
    }, new Date('2026-06-23T01:00:01.000Z').getTime())).toBe(true)
  })

  it('ignores running semantic tasks until they finish', () => {
    expect(shouldRefreshProfileForSemanticTask({
      kind: 'semantic-analysis',
      status: 'running',
      updatedAt: '2026-06-23T01:00:02.000Z',
    }, new Date('2026-06-23T01:00:01.000Z').getTime())).toBe(false)
  })

  it('refreshes profile only when semantic backfill actually tagged tracks', () => {
    expect(shouldRefreshProfileAfterSemanticBackfill({ tagged: 3, skipped: 0 })).toBe(true)
    expect(shouldRefreshProfileAfterSemanticBackfill({ tagged: 0, skipped: 12 })).toBe(false)
    expect(shouldRefreshProfileAfterSemanticBackfill({ tagged: 0, skipped: 0 })).toBe(false)
  })

  it('keeps empty semantic backfill status explicit without starting portrait work', () => {
    expect(semanticBackfillResultStatus({ tagged: 0, skipped: 0 })).toBe('还没有导入歌曲，先导入歌单后再整理语义。')
    expect(semanticBackfillResultStatus({ tagged: 0, skipped: 8 })).toBe('')
    expect(semanticBackfillResultStatus({ tagged: 2, skipped: 8 })).toBe('')
  })

  it('rebuilds portrait after semantic backfill before reloading profile', async () => {
    const calls: string[] = []
    const setProfileState = vi.fn()
    const setProfileStatus = vi.fn()

    const ok = await refreshProfileAfterSemanticUpdateAction({
      refreshStructuredProfile: vi.fn(async () => {
        calls.push('structured')
      }),
      regeneratePortrait: vi.fn(async () => {
        calls.push('portrait')
      }),
      refreshProfile: vi.fn(async () => {
        calls.push('refresh')
      }),
      setProfileState,
      setProfileStatus,
      friendlyError: () => 'friendly',
    })

    expect(ok).toBe(true)
    expect(calls).toEqual(['structured', 'portrait', 'refresh'])
    expect(setProfileState).toHaveBeenNthCalledWith(1, 'importing')
    expect(setProfileState).toHaveBeenLastCalledWith('ok')
    expect(setProfileStatus).toHaveBeenLastCalledWith('画像已跟随语义更新')
  })

  it('keeps structured profile updates when portrait writing fails', async () => {
    const setProfileState = vi.fn()
    const setProfileStatus = vi.fn()
    const refreshProfile = vi.fn()

    const ok = await refreshProfileAfterSemanticUpdateAction({
      refreshStructuredProfile: vi.fn(async () => undefined),
      regeneratePortrait: vi.fn(async () => {
        throw new Error('model failed')
      }),
      refreshProfile,
      setProfileState,
      setProfileStatus,
      friendlyError: (_error, fallback) => fallback,
    })

    expect(ok).toBe(true)
    expect(refreshProfile).toHaveBeenCalledOnce()
    expect(setProfileState).toHaveBeenLastCalledWith('ok')
    expect(setProfileStatus).toHaveBeenLastCalledWith('语义已更新，画像文案稍后再写。')
  })

  it('stops before portrait writing when structured profile refresh fails', async () => {
    const setProfileState = vi.fn()
    const setProfileStatus = vi.fn()
    const regeneratePortrait = vi.fn()
    const refreshProfile = vi.fn()

    const ok = await refreshProfileAfterSemanticUpdateAction({
      refreshStructuredProfile: vi.fn(async () => {
        throw new Error('db failed')
      }),
      regeneratePortrait,
      refreshProfile,
      setProfileState,
      setProfileStatus,
      friendlyError: (_error, fallback) => fallback,
    })

    expect(ok).toBe(false)
    expect(regeneratePortrait).not.toHaveBeenCalled()
    expect(refreshProfile).not.toHaveBeenCalled()
    expect(setProfileState).toHaveBeenLastCalledWith('fail')
    expect(setProfileStatus).toHaveBeenLastCalledWith('语义已更新，结构画像这次没有整理好。')
  })
})
