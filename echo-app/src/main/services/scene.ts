import type { ActiveScene, SceneDefinition, SceneKey, SceneSessionSummary } from '../../types/ipc'
import type { IntentOverride } from './recommendation'
import { getDb } from '../db'

const SCENE_TTL_MS = 2 * 60 * 60 * 1000

export const sceneDefinitions: SceneDefinition[] = [
  {
    key: 'work',
    label: '工作',
    shortLabel: '工 作',
    line: '让节奏慢慢提起来,先别太炸。',
    prompt: '我想进入工作状态,帮我接 5 首。',
    moods: ['清醒', '陪伴'],
    scenes: ['下午工作'],
    energy: 'medium',
    tempo: 'medium',
    familiarity: 'balanced',
  },
  {
    key: 'focus',
    label: '专注',
    shortLabel: '专 注',
    line: '少一点存在感,让节奏稳定铺着。',
    prompt: '我想专注一会儿,帮我接 5 首不抢注意力的。',
    moods: ['陪伴', '清醒'],
    scenes: ['下午工作'],
    energy: 'medium',
    tempo: 'medium',
    familiarity: 'safe',
  },
  {
    key: 'sleepy',
    label: '犯困',
    shortLabel: '犯 困',
    line: '把精神提一下,别一下子太猛。',
    prompt: '我有点犯困,帮我接 5 首提神但别太炸的。',
    moods: ['清醒', '轻快'],
    scenes: ['下午工作'],
    energy: 'high',
    tempo: 'medium',
    familiarity: 'balanced',
  },
  {
    key: 'relax',
    label: '放松',
    shortLabel: '放 松',
    line: '工作间隙缓一下,别把情绪拽太深。',
    prompt: '我想放松一下,帮我接 5 首轻一点的。',
    moods: ['松弛', '治愈'],
    scenes: ['独处'],
    energy: 'low',
    tempo: 'slow',
    familiarity: 'safe',
  },
  {
    key: 'rain',
    label: '雨天',
    shortLabel: '雨 天',
    line: '窗外慢一点,歌也慢一点。',
    prompt: '雨天这个气氛,帮我接 5 首。',
    moods: ['怀旧', '发呆'],
    scenes: ['雨天'],
    energy: 'low',
    tempo: 'slow',
    familiarity: 'balanced',
  },
  {
    key: 'irritated',
    label: '烦躁',
    shortLabel: '烦 躁',
    line: '先降噪,让脑子别继续被推着走。',
    prompt: '我有点烦躁,帮我接 5 首别太吵的。',
    moods: ['松弛', '治愈'],
    scenes: ['独处'],
    energy: 'low',
    tempo: 'slow',
    familiarity: 'safe',
  },
  {
    key: 'random',
    label: '随便听',
    shortLabel: '随 便',
    line: '交给 Echo 发散,从你的口味里随手捞。',
    prompt: '随便听点什么吗?不改的话,就给你自动连播 5 首哦。',
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
      WHERE user_id = 1
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

function expireOverdueScenes(): void {
  cleanupLegacyScenes()
  getDb()
    .prepare(`
      UPDATE scene_sessions
      SET status = 'expired',
          ended_at = COALESCE(ended_at, expires_at)
      WHERE user_id = 1
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
      WHERE user_id = 1 AND status = 'active'
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
      WHERE user_id = 1 AND status = 'active'
    `)
    .run()
  const result = database
    .prepare(`
      INSERT INTO scene_sessions (user_id, scene_key, label, expires_at, meta_json)
      VALUES (1, ?, ?, ?, ?)
    `)
    .run(definition.key, definition.label, expiresAt, JSON.stringify(definition))
  const row = database
    .prepare(`
      SELECT id, scene_key, label, started_at, ended_at, expires_at, status
      FROM scene_sessions
      WHERE id = ?
    `)
    .get(Number(result.lastInsertRowid)) as Parameters<typeof rowToScene>[0]
  return rowToScene(row)
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
  return { ...current, status: 'ended', endedAt: new Date().toISOString() }
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
      WHERE user_id = 1
        AND date(started_at, 'localtime') = date('now', 'localtime')
        AND scene_key IN (${placeholders})
      ORDER BY started_at ASC, id ASC
    `)
    .all(...keys) as Array<Parameters<typeof rowToScene>[0]>
  return rows.map((row) => {
    const scene = rowToScene(row)
    return {
      id: scene.id,
      key: scene.key,
      label: scene.label,
      startedAt: scene.startedAt,
      endedAt: scene.endedAt,
      expiresAt: scene.expiresAt,
      status: scene.status,
      durationMinutes: durationMinutes(scene.startedAt, scene.endedAt, scene.expiresAt),
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
  return `- ${scene.label} ${start}-${end} · ${scene.status} · ${scene.durationMinutes} 分钟`
}).join('\n')}
写风信时可以自然带过这些状态,像朋友回想今天一起听过的时间。不要机械复述场景名,不要写成数据总结。
</today_scene_context>`
}
