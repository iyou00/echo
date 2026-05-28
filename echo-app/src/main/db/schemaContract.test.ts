import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const dbDir = path.dirname(fileURLToPath(import.meta.url))

function readDbFile(name: string): string {
  return fs.readFileSync(path.join(dbDir, name), 'utf8')
}

describe('database schema contract', () => {
  it('keeps single-user ownership explicit instead of using user_id DEFAULT 1', () => {
    const indexSource = readDbFile('index.ts')
    const migrationsSource = readDbFile('migrations.ts')

    expect(indexSource).not.toContain('user_id INTEGER NOT NULL DEFAULT 1')
    expect(migrationsSource).not.toContain('user_id INTEGER NOT NULL DEFAULT 1')
    expect(migrationsSource).toContain("name: 'remove_user_id_defaults'")

    for (const table of [
      'scene_sessions',
      'queue_history_hidden_dates',
      'favorite_tracks',
      'track_semantics',
      'track_feedback',
      'track_feedback_events',
      'taste_question_prompts',
    ]) {
      expect(migrationsSource, table).toContain(table)
    }
  })
})
