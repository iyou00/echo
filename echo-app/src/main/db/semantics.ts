import type { SemanticSummary, TasteProfile, Track, TrackSemantic } from '../../types/ipc'
import { getDb } from './index'

interface SemanticRow {
  track_key: string
  netease_id?: string
  title: string
  artist: string
  album?: string
  language: string
  genres_json: string
  moods_json: string
  scenes_json: string
  energy: number
  tempo: TrackSemantic['tempo']
  familiarity: TrackSemantic['familiarity']
  confidence: number
  source_json: string
}

export function semanticTrackKey(track: Pick<Track, 'id' | 'neteaseId' | 'title' | 'artist'>): string {
  if (track.neteaseId) return `netease:${track.neteaseId}`
  if (track.id) return `id:${track.id}`
  return `name:${track.title.trim().toLowerCase()}::${track.artist.trim().toLowerCase()}`
}

function parseList(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed) ? parsed.map(String).filter(Boolean) : []
  } catch {
    return []
  }
}

function rowToSemantic(row: SemanticRow): TrackSemantic {
  return {
    language: row.language,
    genres: parseList(row.genres_json),
    moods: parseList(row.moods_json),
    scenes: parseList(row.scenes_json),
    energy: Number(row.energy),
    tempo: row.tempo,
    familiarity: row.familiarity,
    confidence: Number(row.confidence),
  }
}

export function getTrackSemantic(track: Pick<Track, 'id' | 'neteaseId' | 'title' | 'artist'>): TrackSemantic | null {
  const row = getDb()
    .prepare('SELECT * FROM track_semantics WHERE user_id = 1 AND track_key = ?')
    .get(semanticTrackKey(track)) as SemanticRow | undefined
  return row ? rowToSemantic(row) : null
}

export function listSemantics(): Array<Track & { semantic: TrackSemantic }> {
  const rows = getDb()
    .prepare('SELECT * FROM track_semantics WHERE user_id = 1 ORDER BY updated_at DESC')
    .all() as SemanticRow[]
  return rows.map((row) => ({
    id: row.netease_id || undefined,
    neteaseId: row.netease_id || undefined,
    title: row.title,
    artist: row.artist,
    album: row.album || undefined,
    source: 'imported',
    semantic: rowToSemantic(row),
  }))
}

export function upsertTrackSemantic(track: Track, semantic: TrackSemantic): void {
  getDb()
    .prepare(`
      INSERT INTO track_semantics (
        user_id, track_key, netease_id, title, artist, album,
        language, genres_json, moods_json, scenes_json, energy, tempo, familiarity, confidence, source_json, updated_at
      )
      VALUES (1, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(track_key) DO UPDATE SET
        netease_id = excluded.netease_id,
        title = excluded.title,
        artist = excluded.artist,
        album = excluded.album,
        language = excluded.language,
        genres_json = excluded.genres_json,
        moods_json = excluded.moods_json,
        scenes_json = excluded.scenes_json,
        energy = excluded.energy,
        tempo = excluded.tempo,
        familiarity = excluded.familiarity,
        confidence = excluded.confidence,
        source_json = excluded.source_json,
        updated_at = CURRENT_TIMESTAMP
    `)
    .run(
      semanticTrackKey(track),
      track.neteaseId ?? track.id ?? '',
      track.title,
      track.artist,
      track.album ?? '',
      semantic.language,
      JSON.stringify(semantic.genres),
      JSON.stringify(semantic.moods),
      JSON.stringify(semantic.scenes),
      semantic.energy,
      semantic.tempo,
      semantic.familiarity,
      semantic.confidence,
      JSON.stringify(track),
    )
}

export function splitMissingSemantics(tracks: Track[]): { missing: Track[]; skipped: number } {
  const seen = new Set<string>()
  const rows = getDb().prepare('SELECT track_key FROM track_semantics WHERE user_id = 1').all() as Array<{ track_key: string }>
  const existing = new Set(rows.map((row) => row.track_key))
  const missing: Track[] = []
  let skipped = 0
  for (const track of tracks) {
    const key = semanticTrackKey(track)
    if (seen.has(key)) {
      skipped += 1
      continue
    }
    seen.add(key)
    if (existing.has(key)) skipped += 1
    else missing.push(track)
  }
  return { missing, skipped }
}

export function getSemanticSummary(): SemanticSummary {
  const tracks = listSemantics()
  const moodCounts = new Map<string, { count: number; artists: Map<string, number> }>()
  for (const track of tracks) {
    for (const mood of track.semantic.moods) {
      const item = moodCounts.get(mood) ?? { count: 0, artists: new Map<string, number>() }
      item.count += 1
      item.artists.set(track.artist, (item.artists.get(track.artist) ?? 0) + 1)
      moodCounts.set(mood, item)
    }
  }
  const max = Math.max(1, ...Array.from(moodCounts.values()).map((item) => item.count))
  const moods: TasteProfile['moods'] = Array.from(moodCounts.entries())
    .sort((a, b) => b[1].count - a[1].count)
    .slice(0, 8)
    .map(([tag, item]) => ({
      tag,
      frequency: Number((item.count / max).toFixed(2)),
      signature_artists: Array.from(item.artists.entries()).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([artist]) => artist),
    }))
  return { moods, total: tracks.length }
}
