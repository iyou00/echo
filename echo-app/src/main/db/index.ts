import Database from 'better-sqlite3'
import { getDbPath } from '../utils/paths'

let db: Database.Database | null = null

export function getDb(): Database.Database {
  if (!db) {
    db = new Database(getDbPath())
    db.pragma('journal_mode = WAL')
    initializeDatabase(db)
  }
  return db
}

export function closeDb(): void {
  db?.close()
  db = null
}

export function initializeDatabase(database = getDb()): void {
  database.exec(`
    CREATE TABLE IF NOT EXISTS users (
      id INTEGER PRIMARY KEY,
      name TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS taste_profile (
      user_id INTEGER PRIMARY KEY,
      profile_json TEXT NOT NULL,
      summary TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      kind TEXT NOT NULL,
      content TEXT NOT NULL,
      confidence REAL,
      weight REAL DEFAULT 1.0,
      started_at DATETIME,
      expected_end_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_events_active ON events(user_id, expected_end_at);

    CREATE TABLE IF NOT EXISTS conversations (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      role TEXT NOT NULL,
      content TEXT NOT NULL,
      meta_json TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_conv_recent ON conversations(user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS conversation_summaries (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      period_start DATETIME,
      period_end DATETIME,
      summary TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS yinyi (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      date DATE NOT NULL UNIQUE,
      content TEXT NOT NULL,
      style TEXT DEFAULT 'dialogue',
      meta_json TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS care_pings (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      title TEXT NOT NULL,
      body TEXT NOT NULL,
      payload_json TEXT,
      triggered_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      clicked_at DATETIME,
      dismissed_at DATETIME
    );
    CREATE INDEX IF NOT EXISTS idx_care_pings_recent ON care_pings(triggered_at DESC);

    CREATE TABLE IF NOT EXISTS care_pings_mute (
      date TEXT PRIMARY KEY
    );

    CREATE TABLE IF NOT EXISTS care_ping_schedule (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      date TEXT NOT NULL,
      window_key TEXT NOT NULL,
      label TEXT NOT NULL,
      planned_at TEXT NOT NULL,
      status TEXT NOT NULL DEFAULT 'planned',
      ran_at TEXT,
      message TEXT,
      error TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      UNIQUE(date, window_key)
    );
    CREATE INDEX IF NOT EXISTS idx_care_ping_schedule_lookup ON care_ping_schedule(date, planned_at ASC);

    CREATE TABLE IF NOT EXISTS scene_sessions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL DEFAULT 1,
      scene_key TEXT NOT NULL,
      label TEXT NOT NULL,
      started_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      ended_at DATETIME,
      expires_at DATETIME NOT NULL,
      status TEXT NOT NULL DEFAULT 'active',
      meta_json TEXT,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_scene_sessions_active ON scene_sessions(user_id, status, started_at DESC);
    CREATE INDEX IF NOT EXISTS idx_scene_sessions_today ON scene_sessions(user_id, started_at DESC);

    CREATE TABLE IF NOT EXISTS scheduled_jobs (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      job_name TEXT NOT NULL,
      scheduled_for TEXT NOT NULL,
      status TEXT NOT NULL,
      message TEXT,
      error TEXT,
      ran_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_scheduled_jobs_lookup ON scheduled_jobs(job_name, scheduled_for DESC);

    CREATE TABLE IF NOT EXISTS service_health (
      service TEXT PRIMARY KEY,
      status TEXT NOT NULL,
      message TEXT NOT NULL,
      technical TEXT,
      checked_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS tracks_listened (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      title TEXT NOT NULL,
      artist TEXT NOT NULL,
      album TEXT,
      source TEXT,
      listened_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      completed BOOLEAN DEFAULT 1,
      meta_json TEXT,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_tracks_recent ON tracks_listened(user_id, listened_at DESC);

    CREATE TABLE IF NOT EXISTS queue_history_hidden_dates (
      user_id INTEGER NOT NULL DEFAULT 1,
      date TEXT NOT NULL,
      hidden_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (user_id, date),
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS favorite_tracks (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL DEFAULT 1,
      track_key TEXT NOT NULL UNIQUE,
      title TEXT NOT NULL,
      artist TEXT NOT NULL,
      album TEXT,
      source TEXT,
      track_json TEXT NOT NULL,
      favorited_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_favorite_tracks_recent ON favorite_tracks(user_id, favorited_at DESC);

    CREATE TABLE IF NOT EXISTS track_semantics (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL DEFAULT 1,
      track_key TEXT NOT NULL UNIQUE,
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
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_track_semantics_user ON track_semantics(user_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS recommendation_cache (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      cache_key TEXT NOT NULL UNIQUE,
      intent_json TEXT NOT NULL,
      tracks_json TEXT NOT NULL,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      expires_at DATETIME NOT NULL
    );
    CREATE INDEX IF NOT EXISTS idx_recommendation_cache_expires ON recommendation_cache(expires_at);

    CREATE TABLE IF NOT EXISTS track_feedback (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL DEFAULT 1,
      track_key TEXT NOT NULL UNIQUE,
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
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );
    CREATE INDEX IF NOT EXISTS idx_track_feedback_user ON track_feedback(user_id, updated_at DESC);

    CREATE TABLE IF NOT EXISTS track_feedback_events (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL DEFAULT 1,
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
    CREATE INDEX IF NOT EXISTS idx_track_feedback_events_recent ON track_feedback_events(user_id, created_at DESC);

    CREATE TABLE IF NOT EXISTS playlists_imported (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      source TEXT,
      name TEXT,
      raw_json TEXT,
      imported_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );

    CREATE TABLE IF NOT EXISTS taste_questions (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER,
      kind TEXT NOT NULL,
      content TEXT NOT NULL,
      context_json TEXT,
      status TEXT DEFAULT 'pending',
      answered_content TEXT,
      answered_at DATETIME,
      expires_at DATETIME,
      created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (user_id) REFERENCES users(id)
    );
    CREATE INDEX IF NOT EXISTS idx_tq_pending ON taste_questions(user_id, status, created_at DESC);

    CREATE TABLE IF NOT EXISTS taste_question_prompts (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      user_id INTEGER NOT NULL DEFAULT 1,
      question_id INTEGER NOT NULL,
      conversation_id INTEGER,
      asked_at DATETIME DEFAULT CURRENT_TIMESTAMP,
      FOREIGN KEY (question_id) REFERENCES taste_questions(id),
      FOREIGN KEY (conversation_id) REFERENCES conversations(id)
    );
    CREATE INDEX IF NOT EXISTS idx_tq_prompts_recent ON taste_question_prompts(user_id, asked_at DESC);

    CREATE TABLE IF NOT EXISTS settings (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      data_json TEXT NOT NULL,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    CREATE TABLE IF NOT EXISTS netease_auth (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      cookie_encrypted TEXT,
      profile_json TEXT,
      updated_at DATETIME DEFAULT CURRENT_TIMESTAMP
    );

    INSERT OR IGNORE INTO users (id, name) VALUES (1, '你');
    INSERT OR IGNORE INTO settings (id, data_json) VALUES (1, '{}');
    INSERT OR IGNORE INTO netease_auth (id, cookie_encrypted, profile_json) VALUES (1, '', '{}');
  `)
}

export function resetDatabase(): void {
  const database = getDb()
  database.exec(`
    DELETE FROM taste_questions;
    DELETE FROM taste_question_prompts;
    DELETE FROM playlists_imported;
    DELETE FROM recommendation_cache;
    DELETE FROM track_semantics;
    DELETE FROM track_feedback_events;
    DELETE FROM track_feedback;
    DELETE FROM queue_history_hidden_dates;
    DELETE FROM tracks_listened;
    DELETE FROM favorite_tracks;
    DELETE FROM yinyi;
    DELETE FROM scheduled_jobs;
    DELETE FROM service_health;
    DELETE FROM care_pings_mute;
    DELETE FROM care_pings;
    DELETE FROM care_ping_schedule;
    DELETE FROM scene_sessions;
    DELETE FROM conversation_summaries;
    DELETE FROM conversations;
    DELETE FROM events;
    DELETE FROM taste_profile;
    UPDATE netease_auth SET cookie_encrypted = '', profile_json = '{}', updated_at = CURRENT_TIMESTAMP WHERE id = 1;
    UPDATE settings SET data_json = '{}', updated_at = CURRENT_TIMESTAMP WHERE id = 1;
  `)
}
