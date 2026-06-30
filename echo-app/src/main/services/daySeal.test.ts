import { describe, expect, it } from 'vitest'
import { daySealTestHelpers } from './daySeal'

describe('day seal prompt boundaries', () => {
  it('removes archive metadata before seal content enters prompts', () => {
    const content = daySealTestHelpers.sealPromptContent(`---
date: 2026-06-24
weekday: 周三
sealed_at: 2026-06-24T12:00:00.000Z
conversations_count: 6
tracks_played: 3
echo_recommendations: 3
schema_version: 1
---

# 2026-06-24 · 日封

## 摘要(200 字以内)

今天 Ta 说有点困，后来完整听完了一首歌。
`)

    expect(content).toContain('今天 Ta 说有点困')
    expect(content).not.toContain('conversations_count')
    expect(content).not.toContain('tracks_played')
    expect(content).not.toContain('echo_recommendations')
    expect(content).not.toContain('2026-06-24 · 日封')
  })

  it('keeps fallback seal wording away from recommendation-report phrasing', () => {
    const entry = daySealTestHelpers.fallbackSeal([], [
      { title: '一首歌', artist: '某歌手', listened_at: '2026-06-24 20:00:00' },
    ])

    expect(entry).toContain('今天真正停留过的歌')
    expect(entry).not.toContain('Echo 今日推荐')
  })

  it('keeps dismissed tracks out of played counts and separates them in fallback seal', () => {
    const tracks = [
      {
        title: '停留的歌',
        artist: '某歌手',
        listened_at: '2026-06-24 20:00:00',
        source: 'recommended_by_echo',
        queueStatus: 'completed' as const,
      },
      {
        title: '放下的歌',
        artist: '另一位',
        listened_at: '2026-06-24 20:05:00',
        source: 'recommended_by_echo',
        queueStatus: 'skipped' as const,
        queueStatusReason: 'explicit_feedback' as const,
      },
    ]

    const meta = daySealTestHelpers.frontMatter('2026-06-24', [], tracks)
    const entry = daySealTestHelpers.fallbackSeal([], tracks)

    expect(meta).toContain('tracks_played: 1')
    expect(meta).toContain('echo_recommendations: 1')
    expect(meta).toContain('dismissed_tracks: 1')
    expect(entry).toContain('今天真正停留过的歌:停留的歌 - 某歌手')
    expect(entry).toContain('今天放下的歌:放下的歌 - 另一位')
  })
})
