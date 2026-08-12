import type { ProfileInsight, Track, TrackSemantic } from '../../types/ipc'
import type { ProfileTrackEvent } from '../db/tracks'

export function profileTrackAgencyFactor(track: Pick<Track, 'source' | 'sourceContext'>, eventSource?: string): number {
  if (track.sourceContext === 'favorite' || track.sourceContext === 'history') return 1
  if (track.sourceContext === 'voice' || track.sourceContext === 'care' || track.sourceContext === 'queue') return 0.15
  if (track.sourceContext === 'scene') return 0.35
  if (track.sourceContext === 'chat') return 0.6
  if (eventSource === 'recommended_by_echo') return 0.4
  return 1
}

export function profileEventAgencyFactor(event: Pick<ProfileTrackEvent, 'track' | 'source'>): number {
  return profileTrackAgencyFactor(event.track, event.source)
}

function eventWeight(event: ProfileTrackEvent): number {
  if (event.queueStatus === 'skipped' || event.queueStatus === 'pending') return 0
  const completion = event.queueStatus === 'completed' ? 1 : 0.7
  return profileEventAgencyFactor(event) * completion
}

function eventDay(value: string): string {
  const date = new Date(value.includes('T') ? value : `${value.replace(' ', 'T')}Z`)
  return Number.isNaN(date.getTime()) ? value.slice(0, 10) : date.toLocaleDateString('sv-SE')
}

interface WindowSummary {
  weight: number
  days: number
  genres: Map<string, number>
  moods: Map<string, number>
  scenes: Map<string, number>
  energy: number
}

function add(map: Map<string, number>, values: string[], weight: number): void {
  for (const raw of values) {
    const value = raw.trim()
    if (value) map.set(value, (map.get(value) ?? 0) + weight)
  }
}

function summarize(events: ProfileTrackEvent[], semanticFor: (track: Track) => TrackSemantic): WindowSummary {
  const genres = new Map<string, number>()
  const moods = new Map<string, number>()
  const scenes = new Map<string, number>()
  const days = new Set<string>()
  let weight = 0
  let energy = 0
  for (const event of events) {
    const value = eventWeight(event)
    if (value <= 0) continue
    const semantic = semanticFor(event.track)
    weight += value
    energy += semantic.energy * value
    days.add(eventDay(event.listenedAt))
    add(genres, semantic.genres, value)
    add(moods, semantic.moods, value)
    add(scenes, event.track.profileEvidence?.scenes?.length ? event.track.profileEvidence.scenes : semantic.scenes, value)
  }
  return { weight, days: days.size, genres, moods, scenes, energy: weight > 0 ? energy / weight : 0 }
}

function deltas(current: Map<string, number>, baseline: Map<string, number>, currentTotal: number, baselineTotal: number) {
  return Array.from(new Set([...current.keys(), ...baseline.keys()])).map((subject) => ({
    subject,
    delta: (current.get(subject) ?? 0) / Math.max(1, currentTotal) - (baseline.get(subject) ?? 0) / Math.max(1, baselineTotal),
  }))
}

function insight(kind: ProfileInsight['kind'], subject: string, delta: number): ProfileInsight {
  const direction = delta > 0 ? 'up' : 'down'
  const phrase = direction === 'up' ? '更常出现了' : '少了一些'
  const kindLabel = kind === 'genre' ? '流派' : kind === 'mood' ? '氛围' : '场景'
  return {
    id: `${kind}:${subject}:${direction}`,
    kind,
    subject,
    statement: `${subject}这阵子${phrase}`,
    direction,
    confidence: Math.abs(delta) >= 0.24 ? 'strong' : 'medium',
    evidenceLabel: `来自跨天播放的${kindLabel}变化`,
  }
}

export function buildRecentProfileInsights(
  recentEvents: ProfileTrackEvent[],
  baselineEvents: ProfileTrackEvent[],
  semanticFor: (track: Track) => TrackSemantic,
): { recentChanges: ProfileInsight[]; eligibleEventCount: number; activeDays: number } {
  const recent = summarize(recentEvents, semanticFor)
  const baseline = summarize(baselineEvents, semanticFor)
  if (recent.weight < 5 || recent.days < 2 || baseline.weight < 3 || baseline.days < 2) {
    return { recentChanges: [], eligibleEventCount: Math.round(recent.weight), activeDays: recent.days }
  }

  const candidates = [
    ...deltas(recent.genres, baseline.genres, recent.weight, baseline.weight).map((item) => ({ ...item, kind: 'genre' as const })),
    ...deltas(recent.moods, baseline.moods, recent.weight, baseline.weight).map((item) => ({ ...item, kind: 'mood' as const })),
    ...deltas(recent.scenes, baseline.scenes, recent.weight, baseline.weight).map((item) => ({ ...item, kind: 'scene' as const })),
  ]
    .filter((item) => Math.abs(item.delta) >= 0.12)
    .sort((a, b) => Math.abs(b.delta) - Math.abs(a.delta))

  const usedKinds = new Set<ProfileInsight['kind']>()
  const recentChanges: ProfileInsight[] = []
  for (const candidate of candidates) {
    if (usedKinds.has(candidate.kind)) continue
    usedKinds.add(candidate.kind)
    recentChanges.push(insight(candidate.kind, candidate.subject, candidate.delta))
    if (recentChanges.length >= 3) break
  }
  if (Math.abs(recent.energy - baseline.energy) >= 0.14 && recentChanges.length < 3) {
    const up = recent.energy > baseline.energy
    recentChanges.push({
      id: `energy:${up ? 'up' : 'down'}`,
      kind: 'energy',
      subject: '音乐能量',
      statement: up ? '你这阵子留下的歌更有精神了' : '你这阵子留下的歌安静了一些',
      direction: up ? 'up' : 'down',
      confidence: Math.abs(recent.energy - baseline.energy) >= 0.24 ? 'strong' : 'medium',
      evidenceLabel: '来自跨天完整播放的能量变化',
    })
  }
  return { recentChanges, eligibleEventCount: Math.round(recent.weight), activeDays: recent.days }
}

export function filterAcknowledgedProfileInsights(insights: ProfileInsight[], acknowledgedIds: Iterable<string>): ProfileInsight[] {
  const hidden = new Set(acknowledgedIds)
  return insights.filter((item) => !hidden.has(item.id))
}
