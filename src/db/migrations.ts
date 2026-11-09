import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { SqliteMigrator } from "@effect/sql-sqlite-bun"

export const LATEST_SCHEMA_VERSION = 2

const initial = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `
  yield* sql`
    CREATE TABLE IF NOT EXISTS events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      session_id TEXT,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `
  yield* sql`CREATE INDEX IF NOT EXISTS events_created_at_idx ON events (created_at)`
  yield* sql`CREATE INDEX IF NOT EXISTS events_session_id_idx ON events (session_id)`

  yield* sql`
    CREATE TABLE IF NOT EXISTS auth_sessions (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    )
  `
  yield* sql`CREATE INDEX IF NOT EXISTS auth_sessions_token_idx ON auth_sessions (token_hash)`
  yield* sql`CREATE INDEX IF NOT EXISTS auth_sessions_expiry_idx ON auth_sessions (expires_at)`

  yield* sql`
    CREATE TABLE IF NOT EXISTS pairing_tokens (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT
    )
  `
  yield* sql`CREATE INDEX IF NOT EXISTS pairing_tokens_token_idx ON pairing_tokens (token_hash)`

  yield* sql`
    CREATE TABLE IF NOT EXISTS idempotency_keys (
      key TEXT PRIMARY KEY,
      method TEXT NOT NULL,
      path TEXT NOT NULL,
      status INTEGER NOT NULL,
      response TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    )
  `
  yield* sql`CREATE INDEX IF NOT EXISTS idempotency_expiry_idx ON idempotency_keys (expires_at)`

  yield* sql`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `

  yield* Effect.void
})

const agentRuntime = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`ALTER TABLE sessions ADD COLUMN model_profile_id TEXT`
  yield* sql`ALTER TABLE sessions ADD COLUMN summary TEXT`
  yield* sql`ALTER TABLE sessions ADD COLUMN summary_through_seq INTEGER`

  yield* sql`
    CREATE TABLE IF NOT EXISTS model_profiles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('cloud', 'local')),
      base_url TEXT NOT NULL,
      model_id TEXT NOT NULL,
      context_window INTEGER NOT NULL,
      max_output_tokens INTEGER NOT NULL,
      cost_input_per_million REAL NOT NULL DEFAULT 0,
      cost_output_per_million REAL NOT NULL DEFAULT 0,
      supports_tools INTEGER NOT NULL DEFAULT 0,
      supports_streaming INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `
  yield* sql`CREATE INDEX IF NOT EXISTS model_profiles_name_idx ON model_profiles (name)`

  yield* sql`
    CREATE TABLE IF NOT EXISTS messages (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      session_id TEXT NOT NULL,
      turn_id TEXT,
      role TEXT NOT NULL,
      text TEXT NOT NULL DEFAULT '',
      content_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `
  yield* sql`CREATE INDEX IF NOT EXISTS messages_session_seq_idx ON messages (session_id, seq)`
  yield* sql`CREATE INDEX IF NOT EXISTS messages_turn_idx ON messages (turn_id)`

  yield* sql`
    CREATE TABLE IF NOT EXISTS turns (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      status TEXT NOT NULL,
      model_profile_id TEXT NOT NULL,
      user_message_id TEXT NOT NULL,
      step_count INTEGER NOT NULL DEFAULT 0,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      error TEXT,
      checkpoint_json TEXT,
      started_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    )
  `
  yield* sql`CREATE INDEX IF NOT EXISTS turns_session_idx ON turns (session_id, started_at)`
  yield* sql`CREATE INDEX IF NOT EXISTS turns_status_idx ON turns (status)`

  yield* sql`
    CREATE TABLE IF NOT EXISTS turn_checkpoints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      turn_id TEXT NOT NULL,
      step INTEGER NOT NULL,
      state_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `
  yield* sql`CREATE INDEX IF NOT EXISTS turn_checkpoints_turn_idx ON turn_checkpoints (turn_id, id)`

  yield* Effect.void
})

export const migrationLoader = SqliteMigrator.fromRecord({
  "0001_initial": initial,
  "0002_agent_runtime": agentRuntime,
})
