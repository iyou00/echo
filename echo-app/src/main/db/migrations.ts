import type Database from 'better-sqlite3'

export interface DbMigration {
  version: number
  name: string
  up(database: Database.Database): void
}

const migrations: DbMigration[] = [
  {
    version: 1,
    name: 'baseline_schema',
    up() {
      // Baseline records the schema created by initializeDatabase().
      // Keep CREATE TABLE statements in db/index.ts at this baseline shape.
      // Future schema changes belong here as idempotent migrations.
    },
  },
  {
    version: 2,
    name: 'care_ping_schedule_integrity',
    up(database) {
      database.exec(`
        UPDATE care_ping_schedule
        SET status = 'planned'
        WHERE status IS NULL OR status NOT IN ('planned', 'completed', 'failed', 'skipped');

        CREATE INDEX IF NOT EXISTS idx_care_ping_schedule_status
          ON care_ping_schedule(date, status, planned_at);
      `)
    },
  },
  {
    version: 3,
    name: 'scope_track_uniques_to_user',
    up(database) {
      rebuildUserScopedUniqueTables(database)
    },
  },
  {
    version: 4,
    name: 'remove_user_id_defaults',
    up(database) {
      rebuildTablesWithoutUserDefaults(database)
    },
  },
]

function uniqueIndexColumns(database: Database.Database, table: string): string[][] {
  const indexes = database.pragma(`index_list(${table})`) as Array<{ name: string; unique: number }>
  return indexes
    .filter((index) => index.unique)
    .map((index) => {
      const columns = database.pragma(`index_info(${index.name})`) as Array<{ name: string }>
      return columns.map((column) => column.name)
    })
}

function hasSingleColumnUnique(database: Database.Database, table: string, column: string): boolean {
  return uniqueIndexColumns(database, table).some((columns) => columns.length === 1 && columns[0] === column)
}

function hasUserIdDefaultOne(database: Database.Database, table: string): boolean {
  const columns = database.pragma(`table_info(${table})`) as Array<{ name: string; dflt_value: string | null }>
  const userId = columns.find((column) => column.name === 'user_id')
  return userId?.dflt_value?.replace(/[()'"]/g, '').trim() === '1'
}

function rebuildUserScopedUniqueTables(database: Database.Database): void {
  if (hasSingleColumnUnique(database, 'yinyi', 'date')) {
    database.exec(`
      CREATE TABLE yinyi_scoped (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER,
        date DATE NOT NULL,
        content TEXT NOT NULL,
        style TEXT DEFAULT 'dialogue',
        meta_json TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, date),
        FOREIGN KEY (user_id) REFERENCES users(id)
      );
      INSERT OR IGNORE INTO yinyi_scoped (id, user_id, date, content, style, meta_json, created_at)
      SELECT id, COALESCE(user_id, 1), date, content, style, meta_json, created_at
      FROM yinyi
      ORDER BY id;
      DROP TABLE yinyi;
      ALTER TABLE yinyi_scoped RENAME TO yinyi;
    `)
  }

  if (hasSingleColumnUnique(database, 'favorite_tracks', 'track_key')) {
    database.exec(`
      CREATE TABLE favorite_tracks_scoped (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        track_key TEXT NOT NULL,
        title TEXT NOT NULL,
        artist TEXT NOT NULL,
        album TEXT,
        source TEXT,
        track_json TEXT NOT NULL,
        favorited_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, track_key),
        FOREIGN KEY (user_id) REFERENCES users(id)
      );
      INSERT OR IGNORE INTO favorite_tracks_scoped (id, user_id, track_key, title, artist, album, source, track_json, favorited_at)
      SELECT id, COALESCE(user_id, 1), track_key, title, artist, album, source, track_json, favorited_at
      FROM favorite_tracks
      ORDER BY id;
      DROP TABLE favorite_tracks;
      ALTER TABLE favorite_tracks_scoped RENAME TO favorite_tracks;
      CREATE INDEX IF NOT EXISTS idx_favorite_tracks_recent ON favorite_tracks(user_id, favorited_at DESC);
    `)
  }

  if (hasSingleColumnUnique(database, 'track_semantics', 'track_key')) {
    database.exec(`
      CREATE TABLE track_semantics_scoped (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        track_key TEXT NOT NULL,
        netease_id TEXT,
        title TEXT NOT NULL,
        artist TEXT NOT NULL,
        album TEXT,
        language TEXT NOT NULL,
        genres_json TEXT NOT NULL,
        moods_json TEXT NOT NULL,
        scenes_json TEXT NOT NULL,
        energy REAL NOT NULL,
        tempo TEXT NOT NULL,
        familiarity TEXT NOT NULL,
        confidence REAL NOT NULL,
        source_json TEXT NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, track_key)
      );
      INSERT OR IGNORE INTO track_semantics_scoped (
        id, user_id, track_key, netease_id, title, artist, album, language, genres_json, moods_json,
        scenes_json, energy, tempo, familiarity, confidence, source_json, updated_at
      )
      SELECT
        id, COALESCE(user_id, 1), track_key, netease_id, title, artist, album, language, genres_json, moods_json,
        scenes_json, energy, tempo, familiarity, confidence, source_json, updated_at
      FROM track_semantics
      ORDER BY id;
      DROP TABLE track_semantics;
      ALTER TABLE track_semantics_scoped RENAME TO track_semantics;
      CREATE INDEX IF NOT EXISTS idx_track_semantics_user ON track_semantics(user_id, updated_at DESC);
    `)
  }

  if (hasSingleColumnUnique(database, 'track_feedback', 'track_key')) {
    database.exec(`
      CREATE TABLE track_feedback_scoped (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        track_key TEXT NOT NULL,
        title TEXT NOT NULL,
        artist TEXT NOT NULL,
        album TEXT,
        source TEXT,
        play_count INTEGER NOT NULL DEFAULT 0,
        skip_count INTEGER NOT NULL DEFAULT 0,
        loop_count INTEGER NOT NULL DEFAULT 0,
        favorite_count INTEGER NOT NULL DEFAULT 0,
        last_completion REAL,
        track_json TEXT NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, track_key)
      );
      INSERT OR IGNORE INTO track_feedback_scoped (
        id, user_id, track_key, title, artist, album, source, play_count, skip_count,
        loop_count, favorite_count, last_completion, track_json, updated_at
      )
      SELECT
        id, COALESCE(user_id, 1), track_key, title, artist, album, source, play_count, skip_count,
        loop_count, favorite_count, last_completion, track_json, updated_at
      FROM track_feedback
      ORDER BY id;
      DROP TABLE track_feedback;
      ALTER TABLE track_feedback_scoped RENAME TO track_feedback;
      CREATE INDEX IF NOT EXISTS idx_track_feedback_user ON track_feedback(user_id, updated_at DESC);
    `)
  }
}

function rebuildTablesWithoutUserDefaults(database: Database.Database): void {
  if (hasUserIdDefaultOne(database, 'scene_sessions')) {
    database.exec(`
      CREATE TABLE scene_sessions_no_user_default (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        scene_key TEXT NOT NULL,
        label TEXT NOT NULL,
        started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        ended_at DATETIME,
        expires_at DATETIME NOT NULL,
        status TEXT NOT NULL DEFAULT 'active',
        meta_json TEXT,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO scene_sessions_no_user_default (id, user_id, scene_key, label, started_at, ended_at, expires_at, status, meta_json, created_at)
      SELECT id, COALESCE(user_id, current_user_id()), scene_key, label, started_at, ended_at, expires_at, status, meta_json, created_at
      FROM scene_sessions
      ORDER BY id;
      DROP TABLE scene_sessions;
      ALTER TABLE scene_sessions_no_user_default RENAME TO scene_sessions;
      CREATE INDEX IF NOT EXISTS idx_scene_sessions_active ON scene_sessions(user_id, status, started_at DESC);
      CREATE INDEX IF NOT EXISTS idx_scene_sessions_today ON scene_sessions(user_id, started_at DESC);
    `)
  }

  if (hasUserIdDefaultOne(database, 'queue_history_hidden_dates')) {
    database.exec(`
      CREATE TABLE queue_history_hidden_dates_no_user_default (
        user_id INTEGER NOT NULL,
        date TEXT NOT NULL,
        hidden_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        PRIMARY KEY (user_id, date),
        FOREIGN KEY (user_id) REFERENCES users(id)
      );
      INSERT OR IGNORE INTO queue_history_hidden_dates_no_user_default (user_id, date, hidden_at)
      SELECT COALESCE(user_id, current_user_id()), date, hidden_at
      FROM queue_history_hidden_dates
      ORDER BY hidden_at;
      DROP TABLE queue_history_hidden_dates;
      ALTER TABLE queue_history_hidden_dates_no_user_default RENAME TO queue_history_hidden_dates;
    `)
  }

  if (hasUserIdDefaultOne(database, 'favorite_tracks')) {
    database.exec(`
      CREATE TABLE favorite_tracks_no_user_default (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        track_key TEXT NOT NULL,
        title TEXT NOT NULL,
        artist TEXT NOT NULL,
        album TEXT,
        source TEXT,
        track_json TEXT NOT NULL,
        favorited_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, track_key),
        FOREIGN KEY (user_id) REFERENCES users(id)
      );
      INSERT OR IGNORE INTO favorite_tracks_no_user_default (id, user_id, track_key, title, artist, album, source, track_json, favorited_at)
      SELECT id, COALESCE(user_id, current_user_id()), track_key, title, artist, album, source, track_json, favorited_at
      FROM favorite_tracks
      ORDER BY id;
      DROP TABLE favorite_tracks;
      ALTER TABLE favorite_tracks_no_user_default RENAME TO favorite_tracks;
      CREATE INDEX IF NOT EXISTS idx_favorite_tracks_recent ON favorite_tracks(user_id, favorited_at DESC);
    `)
  }

  if (hasUserIdDefaultOne(database, 'track_semantics')) {
    database.exec(`
      CREATE TABLE track_semantics_no_user_default (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        track_key TEXT NOT NULL,
        netease_id TEXT,
        title TEXT NOT NULL,
        artist TEXT NOT NULL,
        album TEXT,
        language TEXT NOT NULL,
        genres_json TEXT NOT NULL,
        moods_json TEXT NOT NULL,
        scenes_json TEXT NOT NULL,
        energy REAL NOT NULL,
        tempo TEXT NOT NULL,
        familiarity TEXT NOT NULL,
        confidence REAL NOT NULL,
        source_json TEXT NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, track_key)
      );
      INSERT OR IGNORE INTO track_semantics_no_user_default (
        id, user_id, track_key, netease_id, title, artist, album, language, genres_json, moods_json,
        scenes_json, energy, tempo, familiarity, confidence, source_json, updated_at
      )
      SELECT
        id, COALESCE(user_id, current_user_id()), track_key, netease_id, title, artist, album, language, genres_json, moods_json,
        scenes_json, energy, tempo, familiarity, confidence, source_json, updated_at
      FROM track_semantics
      ORDER BY id;
      DROP TABLE track_semantics;
      ALTER TABLE track_semantics_no_user_default RENAME TO track_semantics;
      CREATE INDEX IF NOT EXISTS idx_track_semantics_user ON track_semantics(user_id, updated_at DESC);
    `)
  }

  if (hasUserIdDefaultOne(database, 'track_feedback')) {
    database.exec(`
      CREATE TABLE track_feedback_no_user_default (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        track_key TEXT NOT NULL,
        title TEXT NOT NULL,
        artist TEXT NOT NULL,
        album TEXT,
        source TEXT,
        play_count INTEGER NOT NULL DEFAULT 0,
        skip_count INTEGER NOT NULL DEFAULT 0,
        loop_count INTEGER NOT NULL DEFAULT 0,
        favorite_count INTEGER NOT NULL DEFAULT 0,
        last_completion REAL,
        track_json TEXT NOT NULL,
        updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        UNIQUE(user_id, track_key)
      );
      INSERT OR IGNORE INTO track_feedback_no_user_default (
        id, user_id, track_key, title, artist, album, source, play_count, skip_count,
        loop_count, favorite_count, last_completion, track_json, updated_at
      )
      SELECT
        id, COALESCE(user_id, current_user_id()), track_key, title, artist, album, source, play_count, skip_count,
        loop_count, favorite_count, last_completion, track_json, updated_at
      FROM track_feedback
      ORDER BY id;
      DROP TABLE track_feedback;
      ALTER TABLE track_feedback_no_user_default RENAME TO track_feedback;
      CREATE INDEX IF NOT EXISTS idx_track_feedback_user ON track_feedback(user_id, updated_at DESC);
    `)
  }

  if (hasUserIdDefaultOne(database, 'track_feedback_events')) {
    database.exec(`
      CREATE TABLE track_feedback_events_no_user_default (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        track_key TEXT NOT NULL,
        action TEXT NOT NULL,
        context TEXT,
        title TEXT NOT NULL,
        artist TEXT NOT NULL,
        album TEXT,
        source TEXT,
        track_json TEXT NOT NULL,
        created_at DATETIME DEFAULT CURRENT_TIMESTAMP
      );
      INSERT INTO track_feedback_events_no_user_default (id, user_id, track_key, action, context, title, artist, album, source, track_json, created_at)
      SELECT id, COALESCE(user_id, current_user_id()), track_key, action, context, title, artist, album, source, track_json, created_at
      FROM track_feedback_events
      ORDER BY id;
      DROP TABLE track_feedback_events;
      ALTER TABLE track_feedback_events_no_user_default RENAME TO track_feedback_events;
      CREATE INDEX IF NOT EXISTS idx_track_feedback_events_recent ON track_feedback_events(user_id, created_at DESC);
    `)
  }

  if (hasUserIdDefaultOne(database, 'taste_question_prompts')) {
    database.exec(`
      CREATE TABLE taste_question_prompts_no_user_default (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL,
        question_id INTEGER NOT NULL,
        conversation_id INTEGER,
        asked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
        FOREIGN KEY (question_id) REFERENCES taste_questions(id),
        FOREIGN KEY (conversation_id) REFERENCES conversations(id)
      );
      INSERT INTO taste_question_prompts_no_user_default (id, user_id, question_id, conversation_id, asked_at)
      SELECT id, COALESCE(user_id, current_user_id()), question_id, conversation_id, asked_at
      FROM taste_question_prompts
      ORDER BY id;
      DROP TABLE taste_question_prompts;
      ALTER TABLE taste_question_prompts_no_user_default RENAME TO taste_question_prompts;
      CREATE INDEX IF NOT EXISTS idx_tq_prompts_recent ON taste_question_prompts(user_id, asked_at DESC);
    `)
  }
}

function ensureMigrationTable(database: Database.Database): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS schema_migrations (
      version INTEGER PRIMARY KEY,
      name TEXT NOT NULL,
      applied_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
  `)
}

function getUserVersion(database: Database.Database): number {
  const value = database.pragma('user_version', { simple: true })
  return typeof value === 'number' ? value : Number(value) || 0
}

function hasAppliedMigration(database: Database.Database, version: number): boolean {
  const row = database
    .prepare('SELECT 1 FROM schema_migrations WHERE version = ? LIMIT 1')
    .get(version)
  return Boolean(row)
}

export function runMigrations(database: Database.Database): void {
  ensureMigrationTable(database)
  const ordered = [...migrations].sort((a, b) => a.version - b.version)
  const currentUserVersion = getUserVersion(database)
  const apply = database.transaction(() => {
    for (const migration of ordered) {
      if (hasAppliedMigration(database, migration.version)) continue
      migration.up(database)
      database
        .prepare('INSERT INTO schema_migrations (version, name) VALUES (?, ?)')
        .run(migration.version, migration.name)
      if (migration.version > currentUserVersion) {
        database.pragma(`user_version = ${migration.version}`)
      }
    }
  })
  apply()
}
