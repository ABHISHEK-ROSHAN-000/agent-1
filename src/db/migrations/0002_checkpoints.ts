import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export const checkpointsMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    CREATE TABLE IF NOT EXISTS checkpoints (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      turn_id TEXT,
      root_path TEXT NOT NULL,
      root_hash TEXT NOT NULL,
      commit_sha TEXT NOT NULL,
      reason TEXT NOT NULL,
      files_changed INTEGER NOT NULL DEFAULT 0,
      insertions INTEGER NOT NULL DEFAULT 0,
      deletions INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL
    )
  `
  yield* sql`CREATE INDEX IF NOT EXISTS checkpoints_session_idx ON checkpoints (session_id, created_at)`
  yield* sql`CREATE INDEX IF NOT EXISTS checkpoints_root_idx ON checkpoints (root_hash, created_at)`
  yield* sql`CREATE INDEX IF NOT EXISTS checkpoints_created_idx ON checkpoints (created_at)`

  yield* sql`
    CREATE TABLE IF NOT EXISTS agent_writes (
      root_hash TEXT NOT NULL,
      path TEXT NOT NULL,
      sha256 TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      PRIMARY KEY (root_hash, path)
    )
  `
  yield* sql`CREATE INDEX IF NOT EXISTS agent_writes_updated_idx ON agent_writes (updated_at)`

  yield* sql`
    CREATE TABLE IF NOT EXISTS approval_grants (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      scope TEXT NOT NULL CHECK (scope IN ('session', 'always')),
      action TEXT NOT NULL,
      resource TEXT NOT NULL,
      pattern_key TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT
    )
  `
  yield* sql`CREATE INDEX IF NOT EXISTS approval_grants_lookup_idx ON approval_grants (action, pattern_key, session_id)`

  yield* sql`DELETE FROM permission_rules WHERE id = 'rule_ask_fs_undo'`
  yield* sql`DROP TABLE IF EXISTS workspaces`
  yield* sql`DROP TABLE IF EXISTS journal`
})
