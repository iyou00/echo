import type { ActiveScene, SceneDefinition, SceneKey, SceneSessionSummary } from '../../types/ipc'
import type { IntentOverride } from './recommendation'
import { getDb } from '../db'
import { loadRecentTracks } from '../db/tracks'
import { sceneOutcomeCounts } from './sceneJourney'

const SCENE_TTL_MS = 2 * 60 * 60 * 1000
const sceneListeners = new Set<(scene: ActiveScene | null) => void>()

export const sceneDefinitions: SceneDefinition[] = [
  {
    key: 'focus',
    label: '静下来',
    shortLabel: '静下来',
    line: '少一点存在感,让节奏稳定铺着。',
    prompt: '想静一会儿,帮我找几首不抢注意力的歌。',
    targetCount: 5,
    moods: ['松弛', '陪伴'],
    scenes: ['独处', '下午工作'],
    energy: 'low',
    tempo: 'slow',
    familiarity: 'safe',
  },
  {
    key: 'sleepy',
    label: '有点困',
    shortLabel: '有点困',
    line: '把精神提一下，节奏别太冲。',
    prompt: '有点犯困,帮我找几首提神但别太炸的歌。',
    targetCount: 5,
    moods: ['清醒', '轻快'],
    scenes: ['下午工作'],
    energy: 'high',
    tempo: 'medium',
    familiarity: 'balanced',
  },
  {
    key: 'relax',
    label: '松口气',
    shortLabel: '松口气',
    line: '工作间隙缓一下,别把情绪拽太深。',
    prompt: '想松口气,帮我找几首轻一点的歌。',
    targetCount: 5,
    moods: ['松弛', '治愈'],
    scenes: ['独处'],
    energy: 'low',
    tempo: 'slow',
    familiarity: 'safe',
  },
  {
    key: 'irritated',
    label: '有点烦',
    shortLabel: '有点烦',
    line: '先降噪,让脑子别继续被推着走。',
    prompt: '有点烦,帮我找几首能让脑子安静下来的歌。',
    targetCount: 5,
    moods: ['松弛', '治愈'],
    scenes: ['独处'],
    energy: 'low',
    tempo: 'slow',
    familiarity: 'safe',
  },
  {
    key: 'random',
    label: '随便吧',
    shortLabel: '随便吧',
    line: '交给 Echo 发散,从你的口味里随手捞。',
    prompt: '随便听点什么,从我的口味里捞几首就好。',
    targetCount: 5,
    moods: ['陪伴'],
    scenes: ['下午工作'],
    energy: 'medium',
    tempo: 'medium',
    familiarity: 'explore',
  },
]

function definitionFor(key: SceneKey): SceneDefinition {
  const definition = sceneDefinitions.find((item) => item.key === key)
  if (!definition) throw new Error('未知场景')
  return definition
}

function knownSceneKeys(): string[] {
  return sceneDefinitions.map((item) => item.key)
}

function cleanupLegacyScenes(): void {
  const keys = knownSceneKeys()
  const placeholders = keys.map(() => '?').join(', ')
  getDb()
    .prepare(`
      UPDATE scene_sessions
      SET status = 'ended',
          ended_at = COALESCE(ended_at, CURRENT_TIMESTAMP)
      WHERE user_id = current_user_id()
        AND status = 'active'
        AND scene_key NOT IN (${placeholders})
    `)
    .run(...keys)
}

function toIso(value?: string): string {
  if (!value) return new Date().toISOString()
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? value : date.toISOString()
}

function rowToScene(row: {
  id: number
  scene_key: SceneKey
  label: string
  started_at: string
  ended_at?: string | null
  expires_at: string
  status: ActiveScene['status']
}): ActiveScene {
  const definition = definitionFor(row.scene_key)
  return {
    ...definition,
    id: row.id,
    label: row.label || definition.label,
    startedAt: toIso(row.started_at),
    endedAt: row.ended_at ? toIso(row.ended_at) : undefined,
    expiresAt: toIso(row.expires_at),
    status: row.status,
  }
}

function emitScene(scene: ActiveScene | null): void {
  for (const listener of Array.from(sceneListeners)) listener(scene)
}

export function onSceneChanged(listener: (scene: ActiveScene | null) => void): () => void {
  sceneListeners.add(listener)
  return () => sceneListeners.delete(listener)
}

function expireOverdueScenes(): void {
  cleanupLegacyScenes()
  getDb()
    .prepare(`
      UPDATE scene_sessions
      SET status = 'expired',
          ended_at = COALESCE(ended_at, expires_at)
      WHERE user_id = current_user_id()
        AND status = 'active'
        AND datetime(expires_at) <= datetime('now')
    `)
    .run()
}

export function listSceneDefinitions(): SceneDefinition[] {
  return sceneDefinitions
}

export function getCurrentScene(): ActiveScene | null {
  expireOverdueScenes()
  const row = getDb()
    .prepare(`
      SELECT id, scene_key, label, started_at, ended_at, expires_at, status
      FROM scene_sessions
      WHERE user_id = current_user_id() AND status = 'active'
      ORDER BY started_at DESC, id DESC
      LIMIT 1
    `)
    .get() as Parameters<typeof rowToScene>[0] | undefined
  return row ? rowToScene(row) : null
}

export function startScene(key: SceneKey): ActiveScene {
  expireOverdueScenes()
  const definition = definitionFor(key)
  const expiresAt = new Date(Date.now() + SCENE_TTL_MS).toISOString()
  const database = getDb()
  database
    .prepare(`
      UPDATE scene_sessions
      SET status = 'ended',
          ended_at = CURRENT_TIMESTAMP
      WHERE user_id = current_user_id() AND status = 'active'
    `)
    .run()
  const result = database
    .prepare(`
      INSERT INTO scene_sessions (user_id, scene_key, label, expires_at, meta_json)
      VALUES (current_user_id(), ?, ?, ?, ?)
    `)
    .run(definition.key, definition.label, expiresAt, JSON.stringify(definition))
  const row = database
    .prepare(`
      SELECT id, scene_key, label, started_at, ended_at, expires_at, status
      FROM scene_sessions
      WHERE id = ?
    `)
    .get(Number(result.lastInsertRowid)) as Parameters<typeof rowToScene>[0]
  const scene = rowToScene(row)
  emitScene(scene)
  return scene
}

export function endCurrentScene(): ActiveScene | null {
  expireOverdueScenes()
  const current = getCurrentScene()
  if (!current) return null
  getDb()
    .prepare(`
      UPDATE scene_sessions
      SET status = 'ended',
          ended_at = CURRENT_TIMESTAMP
      WHERE id = ?
    `)
    .run(current.id)
  const ended = { ...current, status: 'ended' as const, endedAt: new Date().toISOString() }
  emitScene(null)
  return ended
}

export function isSceneSessionCurrent(sceneId: number): boolean {
  return getCurrentScene()?.id === sceneId
}

export function hasNewerSceneSession(scene: ActiveScene): boolean {
  expireOverdueScenes()
  const row = getDb()
    .prepare(`
      SELECT id
      FROM scene_sessions
      WHERE user_id = current_user_id()
        AND id > ?
        AND datetime(started_at) >= datetime(?)
      ORDER BY id DESC
      LIMIT 1
    `)
    .get(scene.id, scene.startedAt) as { id: number } | undefined
  return Boolean(row)
}

function durationMinutes(startedAt: string, endedAt?: string, expiresAt?: string): number {
  const start = new Date(startedAt).getTime()
  const end = new Date(endedAt ?? expiresAt ?? new Date().toISOString()).getTime()
  if (Number.isNaN(start) || Number.isNaN(end)) return 0
  return Math.max(0, Math.round((end - start) / 60000))
}

export function listTodaySceneSessions(): SceneSessionSummary[] {
  expireOverdueScenes()
  const keys = knownSceneKeys()
  const placeholders = keys.map(() => '?').join(', ')
  const rows = getDb()
    .prepare(`
      SELECT id, scene_key, label, started_at, ended_at, expires_at, status
      FROM scene_sessions
      WHERE user_id = current_user_id()
        AND date(started_at, 'localtime') = date('now', 'localtime')
        AND scene_key IN (${placeholders})
      ORDER BY started_at ASC, id ASC
    `)
    .all(...keys) as Array<Parameters<typeof rowToScene>[0]>
  const recentTracks = loadRecentTracks(500)
  return rows.map((row) => {
    const scene = rowToScene(row)
    const outcomes = sceneOutcomeCounts(recentTracks.filter((track) => track.sceneSessionId === scene.id))
    return {
      id: scene.id,
      key: scene.key,
      label: scene.label,
      startedAt: scene.startedAt,
      endedAt: scene.endedAt,
      expiresAt: scene.expiresAt,
      status: scene.status,
      durationMinutes: durationMinutes(scene.startedAt, scene.endedAt, scene.expiresAt),
      playedTrackCount: outcomes.played,
      completedTrackCount: outcomes.completed,
      skippedTrackCount: outcomes.skipped,
    }
  })
}

export function sceneIntentOverride(scene = getCurrentScene()): IntentOverride | undefined {
  if (!scene) return undefined
  return {
    moods: scene.moods,
    scenes: scene.scenes,
    energy: scene.energy,
    tempo: scene.tempo,
    familiarity: scene.familiarity,
    targetCount: scene.targetCount,
    sceneKey: scene.key,
    evidence: [`当前场景:${scene.label}`],
  }
}

export function buildCurrentSceneContext(): string {
  const scene = getCurrentScene()
  if (!scene) return '<current_scene>无</current_scene>'
  return `<current_scene>
- 场景:${scene.label}
- 状态:${scene.status}
- 开始:${new Date(scene.startedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })}
- 倾向:${scene.moods.join(' / ')} · ${scene.scenes.join(' / ')} · ${scene.energy} · ${scene.tempo}
- 语气提示:${scene.line}
</current_scene>`
}

export function buildTodaySceneContext(): string {
  const scenes = listTodaySceneSessions()
  if (scenes.length === 0) return '<today_scene_context>今天没有显式进入场景。</today_scene_context>'
  return `<today_scene_context>
${scenes.map((scene) => {
  const start = new Date(scene.startedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false })
  const end = scene.endedAt ? new Date(scene.endedAt).toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', hour12: false }) : '现在'
  const outcome = scene.playedTrackCount
    ? ` · 播放${scene.playedTrackCount}首 · 听完${scene.completedTrackCount ?? 0}首 · 跳过${scene.skippedTrackCount ?? 0}首`
    : ''
  return `- ${scene.label} ${start}-${end} · ${scene.status} · ${scene.durationMinutes} 分钟${outcome}`
}).join('\n')}
这些是场景使用事实。可以自然带过一起听过的时间,但不能仅凭场景名推断用户整天的情绪,也不要机械复述数字或写成数据总结。
</today_scene_context>`
}
