import type { SemanticSummary, TasteProfile, Track, TrackSemantic } from '../../types/ipc'
import { trackIdentity, type TrackIdentityInput } from '../../shared/trackIdentity'
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

export function semanticTrackKey(track: TrackIdentityInput): string {
  return trackIdentity(track)
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
    .prepare('SELECT * FROM track_semantics WHERE user_id = current_user_id() AND track_key = ?')
    .get(semanticTrackKey(track)) as SemanticRow | undefined
  return row ? rowToSemantic(row) : null
}

export function listSemantics(): Array<Track & { semantic: TrackSemantic }> {
  const rows = getDb()
    .prepare('SELECT * FROM track_semantics WHERE user_id = current_user_id() ORDER BY updated_at DESC')
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
      VALUES (current_user_id(), ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, CURRENT_TIMESTAMP)
      ON CONFLICT(user_id, track_key) DO UPDATE SET
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
  const rows = getDb().prepare('SELECT track_key FROM track_semantics WHERE user_id = current_user_id()').all() as Array<{ track_key: string }>
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
  const db = getDb()

  const { total } = db
    .prepare('SELECT COUNT(*) as total FROM track_semantics WHERE user_id = current_user_id()')
    .get() as { total: number }

  if (total === 0) return { moods: [], total: 0 }

  const rows = db
    .prepare(`
      SELECT
        je.value AS mood,
        s.artist,
        COUNT(*) AS cnt
      FROM track_semantics s
      CROSS JOIN json_each(s.moods_json) je
      WHERE s.user_id = current_user_id()
        AND je.value IS NOT NULL
        AND je.value != ''
      GROUP BY je.value, s.artist
      ORDER BY je.value, cnt DESC
    `)
    .all() as Array<{ mood: string; artist: string; cnt: number }>

  const moodTotals = new Map<string, number>()
  const moodArtists = new Map<string, Array<{ artist: string; cnt: number }>>()
  for (const row of rows) {
    moodTotals.set(row.mood, (moodTotals.get(row.mood) ?? 0) + row.cnt)
    if (row.artist) {
      const list = moodArtists.get(row.mood) ?? []
      if (list.length < 3) list.push({ artist: row.artist, cnt: row.cnt })
      moodArtists.set(row.mood, list)
    }
  }

  const sorted = Array.from(moodTotals.entries())
    .sort((a, b) => b[1] - a[1])
    .slice(0, 8)

  if (sorted.length === 0) return { moods: [], total }

  const max = sorted[0][1]
  const moods: TasteProfile['moods'] = sorted.map(([tag, count]) => ({
    tag,
    frequency: Number((count / max).toFixed(2)),
    signature_artists: (moodArtists.get(tag) ?? []).map((a) => a.artist),
  }))

  return { moods, total }
}
