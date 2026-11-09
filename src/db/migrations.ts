import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { SqliteMigrator } from "@effect/sql-sqlite-bun"

export const LATEST_SCHEMA_VERSION = 1

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

export const migrationLoader = SqliteMigrator.fromRecord({
  "0001_initial": initial,
})
