import type { Track } from '../../types/ipc'
import { getDb } from './index'

interface RecommendationCacheRow {
  intent_json: string
  tracks_json: string
  expires_at: string
}

export function getRecommendationCache(cacheKey: string): { intent: Record<string, unknown>; tracks: Track[] } | null {
  const row = getDb()
    .prepare('SELECT intent_json, tracks_json, expires_at FROM recommendation_cache WHERE cache_key = ?')
    .get(cacheKey) as RecommendationCacheRow | undefined
  if (!row) return null
  if (new Date(row.expires_at).getTime() <= Date.now()) {
    getDb().prepare('DELETE FROM recommendation_cache WHERE cache_key = ?').run(cacheKey)
    return null
  }
  try {
    return {
      intent: JSON.parse(row.intent_json) as Record<string, unknown>,
      tracks: JSON.parse(row.tracks_json) as Track[],
    }
  } catch {
    getDb().prepare('DELETE FROM recommendation_cache WHERE cache_key = ?').run(cacheKey)
    return null
  }
}

export function setRecommendationCache(cacheKey: string, intent: Record<string, unknown>, tracks: Track[], ttlMs = 6 * 60 * 60 * 1000): void {
  getDb()
    .prepare(`
      INSERT INTO recommendation_cache (cache_key, intent_json, tracks_json, expires_at)
      VALUES (?, ?, ?, ?)
      ON CONFLICT(cache_key) DO UPDATE SET
        intent_json = excluded.intent_json,
        tracks_json = excluded.tracks_json,
        created_at = CURRENT_TIMESTAMP,
        expires_at = excluded.expires_at
    `)
    .run(cacheKey, JSON.stringify(intent), JSON.stringify(tracks), new Date(Date.now() + ttlMs).toISOString())
}

export function clearRecommendationCache(): void {
  getDb().prepare('DELETE FROM recommendation_cache').run()
}
