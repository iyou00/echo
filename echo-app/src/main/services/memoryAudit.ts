import type { MemoryAuditItem, MemoryAuditSummary, Track } from '../../types/ipc'
import { loadRecentEvents } from '../db/events'
import { listExplicitTrackFeedback, listTrackFeedback } from '../db/feedback'

function toTime(value?: string): number {
  if (!value) return 0
  const time = new Date(value).getTime()
  return Number.isNaN(time) ? 0 : time
}

function compact(value: string, limit = 48): string {
  const clean = value.replace(/\s+/g, ' ').trim()
  return clean.length > limit ? `${clean.slice(0, limit)}...` : clean
}

function trackTitle(track: Track): string {
  return `《${track.title}》`
}

function trackDetail(track: Track): string {
  return [track.artist, track.album].filter(Boolean).join(' · ')
}

export function getMemoryAudit(limit = 8): MemoryAuditSummary {
  const corrections = loadRecentEvents('correction', 20)
  const feedback = listTrackFeedback(120)
  const explicit = listExplicitTrackFeedback(80)
  const items: MemoryAuditItem[] = []
  const seen = new Set<string>()

  function push(item: MemoryAuditItem): void {
    if (seen.has(item.id)) return
    seen.add(item.id)
    items.push(item)
  }

  for (const event of corrections.slice(0, 6)) {
    push({
      id: `correction:${event.createdAt ?? event.startedAt ?? event.content}`,
      kind: 'correction',
      label: '纠正',
      title: compact(event.content, 56),
      createdAt: event.createdAt ?? event.startedAt,
      weight: event.weight,
    })
  }

  for (const item of explicit.slice(0, 20)) {
    if (item.action === 'more_like_this') {
      push({
        id: `explicit_like:${item.trackKey}:${item.createdAt ?? ''}`,
        kind: 'explicit_like',
        label: '想多听',
        title: trackTitle(item.track),
        detail: item.context ? compact(item.context, 42) : trackDetail(item.track),
        createdAt: item.createdAt,
        track: item.track,
      })
    }
    if (item.action === 'not_right') {
      push({
        id: `explicit_miss:${item.trackKey}:${item.createdAt ?? ''}`,
        kind: 'explicit_miss',
        label: '不合适',
        title: trackTitle(item.track),
        detail: item.context ? compact(item.context, 42) : trackDetail(item.track),
        createdAt: item.createdAt,
        track: item.track,
      })
    }
  }

  for (const item of feedback) {
    if (item.favoriteCount > 0) {
      push({
        id: `favorite:${item.trackKey}`,
        kind: 'favorite',
        label: '收藏',
        title: trackTitle(item.track),
        detail: trackDetail(item.track),
        createdAt: item.updatedAt,
        track: item.track,
      })
    }
    if (item.loopCount > 0) {
      push({
        id: `loop:${item.trackKey}`,
        kind: 'loop',
        label: '循环',
        title: trackTitle(item.track),
        detail: `${item.loopCount} 次 · ${trackDetail(item.track)}`,
        createdAt: item.updatedAt,
        track: item.track,
      })
    }
    if (item.playCount >= 3) {
      push({
        id: `played:${item.trackKey}`,
        kind: 'played',
        label: '常听',
        title: trackTitle(item.track),
        detail: `${item.playCount} 次完整播放`,
        createdAt: item.updatedAt,
        track: item.track,
      })
    }
    if (item.skipCount >= 2) {
      push({
        id: `skip:${item.trackKey}`,
        kind: 'skip',
        label: '跳过',
        title: trackTitle(item.track),
        detail: `${item.skipCount} 次跳过`,
        createdAt: item.updatedAt,
        track: item.track,
      })
    }
  }

  const sorted = items
    .sort((a, b) => toTime(b.createdAt) - toTime(a.createdAt))
    .slice(0, Math.max(1, Math.min(20, limit)))

  return {
    updatedAt: new Date().toISOString(),
    counts: {
      corrections: corrections.length,
      favorites: feedback.filter((item) => item.favoriteCount > 0).length,
      explicitLikes: explicit.filter((item) => item.action === 'more_like_this').length,
      explicitMisses: explicit.filter((item) => item.action === 'not_right').length,
      loops: feedback.filter((item) => item.loopCount > 0).length,
      repeatedSkips: feedback.filter((item) => item.skipCount >= 2).length,
    },
    items: sorted,
  }
}
