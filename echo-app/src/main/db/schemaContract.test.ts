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
    expect(migrationsSource).toContain("name: 'separate_explicit_feedback_from_playback_counts'")
    expect(migrationsSource).toContain("name: 'backfill_settings_first_used_at'")
    expect(migrationsSource).toContain("name: 'continuous_listening_sessions'")
    expect(migrationsSource).toContain("name: 'continuous_listening_context'")
    expect(migrationsSource).toContain('CREATE TABLE IF NOT EXISTS listening_sessions')
    expect(migrationsSource).toContain('CREATE TABLE IF NOT EXISTS listening_segments')
    expect(migrationsSource).toContain('consumed_event_keys_json')

    for (const table of [
      'scene_sessions',
      'queue_history_hidden_dates',
      'favorite_tracks',
      'track_semantics',
      'track_feedback',
      'track_feedback_events',
      'taste_question_prompts',
      'learned_cases',
    ]) {
      expect(migrationsSource, table).toContain(table)
    }
  })

  it('persists first use time for new and reset local databases', () => {
    const indexSource = readDbFile('index.ts')
    const migrationsSource = readDbFile('migrations.ts')
    const settingsSource = readDbFile('settings.ts')

    expect(indexSource).toContain('function initialSettingsJson')
    expect(indexSource).toContain('INSERT OR IGNORE INTO settings (id, data_json) VALUES (1, ?)')
    expect(indexSource).toContain('UPDATE settings SET data_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1')
    expect(migrationsSource).toContain('function backfillSettingsFirstUsedAt')
    expect(migrationsSource).toContain('firstUsedAt')
    expect(settingsSource).toContain('const firstUsedAt =')
    expect(settingsSource).toContain('new Date().toISOString()')
  })

  it('keeps accepted portrait versions for rollback and review', () => {
    const indexSource = readDbFile('index.ts')
    const tasteSource = readDbFile('taste.ts')

    expect(indexSource).toContain('CREATE TABLE IF NOT EXISTS taste_profile_versions')
    expect(indexSource).toContain('CREATE TABLE IF NOT EXISTS taste_profile_insight_feedback')
    expect(indexSource).toContain('DELETE FROM taste_profile_versions')
    expect(tasteSource).toContain('INSERT INTO taste_profile_versions')
    expect(tasteSource).toContain('LIMIT 24')
    expect(tasteSource).toContain('export function publishTasteProfile')
    expect(tasteSource).toContain('database.transaction')
    expect(tasteSource).toContain('export function listTasteProfileVersions')
    expect(tasteSource).toContain('export function restoreTasteProfileVersion')
  })

  it('keeps semantic backfill on the import runtime adapter', () => {
    const recommendationIpcSource = readDbFile('../ipc/recommendation.ts')
    const semanticsSource = readDbFile('../services/semantics.ts')
    const importTasksSource = readDbFile('../services/importTasks.ts')

    expect(recommendationIpcSource).toContain("ipcMain.handle('semantics:buildForImportedTracks', () => buildForImportedTracks())")
    expect(semanticsSource).toContain("runImportTask('semantic-analysis'")
    expect(semanticsSource).toContain('buildSemanticsForTracks(getAllImportedTracks(), report, { signal })')
    expect(importTasksSource).toContain('type ImportTaskRunner<T> = (report: ImportTaskReporter, signal: AbortSignal) => Promise<T>')
  })

})
