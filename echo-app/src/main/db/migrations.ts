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
  {
    version: 5,
    name: 'separate_explicit_feedback_from_playback_counts',
    up(database) {
      separateExplicitFeedbackFromPlaybackCounts(database)
    },
  },
  {
    version: 6,
    name: 'backfill_settings_first_used_at',
    up(database) {
      backfillSettingsFirstUsedAt(database)
    },
  },
  {
    version: 7,
    name: 'companion_relationship_profile',
    up(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS companion_profiles (
          user_id INTEGER PRIMARY KEY,
          profile_json TEXT NOT NULL,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users(id)
        );

        CREATE TABLE IF NOT EXISTS companion_signal_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          dimension TEXT NOT NULL,
          direction TEXT NOT NULL,
          confidence REAL NOT NULL,
          explicit INTEGER NOT NULL DEFAULT 0,
          evidence TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users(id)
        );
        CREATE INDEX IF NOT EXISTS idx_companion_signals_recent
          ON companion_signal_events(user_id, created_at DESC);
      `)
    },
  },
  {
    version: 8,
    name: 'continuous_listening_sessions',
    up(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS listening_sessions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          status TEXT NOT NULL DEFAULT 'active',
          started_at DATETIME NOT NULL,
          last_active_at DATETIME NOT NULL,
          ended_at DATETIME,
          segment_count INTEGER NOT NULL DEFAULT 0,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users(id)
        );
        CREATE INDEX IF NOT EXISTS idx_listening_sessions_active
          ON listening_sessions(user_id, status, last_active_at DESC);

        CREATE TABLE IF NOT EXISTS listening_segments (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          session_id INTEGER NOT NULL,
          track_key TEXT NOT NULL DEFAULT '',
          track_json TEXT,
          text TEXT NOT NULL DEFAULT '',
          delivery TEXT NOT NULL,
          density TEXT NOT NULL,
          move TEXT NOT NULL,
          sentence_form TEXT NOT NULL,
          topic_source TEXT NOT NULL,
          signature TEXT NOT NULL DEFAULT '',
          generated_at DATETIME NOT NULL,
          FOREIGN KEY (user_id) REFERENCES users(id),
          FOREIGN KEY (session_id) REFERENCES listening_sessions(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_listening_segments_recent
          ON listening_segments(user_id, session_id, generated_at DESC);
      `)
    },
  },
  {
    version: 9,
    name: 'continuous_listening_context',
    up(database) {
      database.exec(`
        ALTER TABLE listening_sessions ADD COLUMN companion_mode TEXT;
        ALTER TABLE listening_sessions ADD COLUMN consumed_event_keys_json TEXT NOT NULL DEFAULT '[]';
      `)
    },
  },
  {
    version: 10,
    name: 'agent_phase_one_context_and_actions',
    up(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS stage_contexts (
          id TEXT PRIMARY KEY,
          user_id INTEGER NOT NULL,
          kind TEXT NOT NULL,
          status TEXT NOT NULL,
          summary TEXT NOT NULL,
          state_json TEXT NOT NULL,
          goal TEXT NOT NULL,
          confidence REAL NOT NULL,
          revision INTEGER NOT NULL DEFAULT 1,
          started_at DATETIME NOT NULL,
          last_active_at DATETIME NOT NULL,
          expires_at DATETIME NOT NULL,
          ended_at DATETIME,
          end_reason TEXT,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users(id)
        );
        CREATE UNIQUE INDEX IF NOT EXISTS idx_stage_context_one_active
          ON stage_contexts(user_id) WHERE status = 'active';
        CREATE INDEX IF NOT EXISTS idx_stage_context_recent
          ON stage_contexts(user_id, last_active_at DESC);

        CREATE TABLE IF NOT EXISTS stage_context_evidence (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          context_id TEXT NOT NULL,
          source_type TEXT NOT NULL,
          source_id TEXT NOT NULL,
          strength TEXT NOT NULL,
          fact TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          retracted_at DATETIME,
          UNIQUE(context_id, source_type, source_id, fact),
          FOREIGN KEY (context_id) REFERENCES stage_contexts(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS agent_actions (
          id TEXT PRIMARY KEY,
          user_id INTEGER NOT NULL,
          stage_context_id TEXT,
          stage_context_revision INTEGER,
          runtime_task_id TEXT,
          origin TEXT NOT NULL,
          action_type TEXT NOT NULL,
          reason_code TEXT NOT NULL,
          goal_code TEXT NOT NULL,
          status TEXT NOT NULL,
          failure_kind TEXT,
          recovers_action_id TEXT,
          decision_json TEXT NOT NULL DEFAULT '{}',
          planned_at DATETIME NOT NULL,
          started_at DATETIME,
          finished_at DATETIME,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          FOREIGN KEY (user_id) REFERENCES users(id),
          FOREIGN KEY (stage_context_id) REFERENCES stage_contexts(id) ON DELETE SET NULL,
          FOREIGN KEY (recovers_action_id) REFERENCES agent_actions(id) ON DELETE SET NULL
        );
        CREATE INDEX IF NOT EXISTS idx_agent_actions_recent
          ON agent_actions(user_id, planned_at DESC);
        CREATE INDEX IF NOT EXISTS idx_agent_actions_context
          ON agent_actions(stage_context_id, planned_at DESC);

        CREATE TABLE IF NOT EXISTS agent_action_items (
          id TEXT PRIMARY KEY,
          action_id TEXT NOT NULL,
          item_type TEXT NOT NULL,
          ordinal INTEGER NOT NULL,
          entity_key TEXT,
          payload_json TEXT NOT NULL DEFAULT '{}',
          status TEXT NOT NULL,
          started_at DATETIME,
          finished_at DATETIME,
          UNIQUE(action_id, item_type, ordinal),
          FOREIGN KEY (action_id) REFERENCES agent_actions(id) ON DELETE CASCADE
        );

        CREATE TABLE IF NOT EXISTS agent_action_outcomes (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL,
          action_id TEXT NOT NULL,
          action_item_id TEXT,
          source_event_key TEXT NOT NULL,
          outcome_type TEXT NOT NULL,
          polarity TEXT NOT NULL,
          strength TEXT NOT NULL,
          occurred_at DATETIME NOT NULL,
          metadata_json TEXT NOT NULL DEFAULT '{}',
          UNIQUE(user_id, source_event_key),
          FOREIGN KEY (user_id) REFERENCES users(id),
          FOREIGN KEY (action_id) REFERENCES agent_actions(id) ON DELETE CASCADE,
          FOREIGN KEY (action_item_id) REFERENCES agent_action_items(id) ON DELETE CASCADE
        );
        CREATE INDEX IF NOT EXISTS idx_agent_outcomes_action
          ON agent_action_outcomes(action_id, occurred_at DESC);

        ALTER TABLE scene_sessions ADD COLUMN stage_context_id TEXT REFERENCES stage_contexts(id) ON DELETE SET NULL;
        ALTER TABLE listening_sessions ADD COLUMN stage_context_id TEXT REFERENCES stage_contexts(id) ON DELETE SET NULL;
        ALTER TABLE track_feedback_events ADD COLUMN agent_action_id TEXT REFERENCES agent_actions(id) ON DELETE SET NULL;
        ALTER TABLE track_feedback_events ADD COLUMN agent_action_item_id TEXT REFERENCES agent_action_items(id) ON DELETE SET NULL;
      `)
    },
  },
  {
    version: 11,
    name: 'proactive_budget_schedule_defer',
    up(database) {
      database.exec(`
        ALTER TABLE care_ping_schedule ADD COLUMN eligible_after TEXT;
        ALTER TABLE care_ping_schedule ADD COLUMN defer_count INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE care_ping_schedule ADD COLUMN decision_code TEXT;
      `)
    },
  },
  {
    version: 12,
    name: 'care_ping_observation_window',
    up(database) {
      database.exec(`
        ALTER TABLE care_pings ADD COLUMN shown_at TEXT;
        ALTER TABLE care_pings ADD COLUMN observation_due_at TEXT;
      `)
    },
  },
  {
    version: 13,
    name: 'learned_cases',
    up(database) {
      database.exec(`
        CREATE TABLE IF NOT EXISTS learned_cases (
          id TEXT PRIMARY KEY,
          user_id INTEGER NOT NULL,
          kind TEXT NOT NULL,
          trigger_text TEXT NOT NULL,
          learned_json TEXT NOT NULL,
          evidence_json TEXT NOT NULL,
          confidence REAL NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending',
          corroborations INTEGER NOT NULL DEFAULT 0,
          source_date TEXT NOT NULL,
          created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
          updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
        );
        CREATE INDEX IF NOT EXISTS idx_learned_cases_status
          ON learned_cases(user_id, status);
      `)
    },
  },
  {
    version: 14,
    name: 'learned_cases_hit_count',
    up: (db) => {
      db.exec('ALTER TABLE learned_cases ADD COLUMN hit_count INTEGER NOT NULL DEFAULT 0')
    },
  },
]

function backfillSettingsFirstUsedAt(database: Database.Database): void {
  const row = database.prepare('SELECT data_json FROM settings WHERE id = 1').get() as { data_json: string } | undefined
  let value: Record<string, unknown> = {}
  try {
    value = row?.data_json ? JSON.parse(row.data_json) as Record<string, unknown> : {}
  } catch {
    value = {}
  }
  const meta = value.meta && typeof value.meta === 'object' && !Array.isArray(value.meta)
    ? value.meta as Record<string, unknown>
    : {}
  const firstUsedAt = typeof meta.firstUsedAt === 'string' && meta.firstUsedAt.trim()
    ? meta.firstUsedAt
    : new Date().toISOString()
  const next = {
    ...value,
    meta: {
      schemaVersion: 1,
      lastViewedYinyiAt: '',
      onboardingStep: 'api',
      lastPrunedAt: '',
      ...meta,
      firstUsedAt,
    },
  }
  database
    .prepare('UPDATE settings SET data_json = ?, updated_at = CURRENT_TIMESTAMP WHERE id = 1')
    .run(JSON.stringify(next))
}

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

function countExplicitFeedbackSubquery(action: 'more_like_this' | 'not_right'): string {
  return `
    SELECT COUNT(*)
    FROM track_feedback_events tfe
    WHERE tfe.user_id = track_feedback.user_id
      AND tfe.track_key = track_feedback.track_key
      AND tfe.action = '${action}'
  `
}

function separateExplicitFeedbackFromPlaybackCounts(database: Database.Database): void {
  const explicitLikes = countExplicitFeedbackSubquery('more_like_this')
  const explicitMisses = countExplicitFeedbackSubquery('not_right')
  database.exec(`
    UPDATE track_feedback
    SET
      play_count = CASE
        WHEN play_count > (${explicitLikes}) THEN play_count - (${explicitLikes})
        ELSE 0
      END,
      skip_count = CASE
        WHEN skip_count > (${explicitMisses}) THEN skip_count - (${explicitMisses})
        ELSE 0
      END,
      last_completion = CASE
        WHEN play_count <= (${explicitLikes}) AND last_completion = 1 THEN NULL
        ELSE last_completion
      END,
      updated_at = CURRENT_TIMESTAMP
    WHERE EXISTS (
      SELECT 1
      FROM track_feedback_events tfe
      WHERE tfe.user_id = track_feedback.user_id
        AND tfe.track_key = track_feedback.track_key
    );
  `)
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
