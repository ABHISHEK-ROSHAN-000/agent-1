import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export const sessionContracts = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const now = new Date().toISOString()

  yield* sql`
    CREATE TABLE IF NOT EXISTS session_inbox (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      content TEXT NOT NULL,
      mode TEXT NOT NULL CHECK (mode IN ('queue', 'steer')),
      status TEXT NOT NULL CHECK (status IN ('pending', 'promoted', 'cancelled')),
      created_at TEXT NOT NULL,
      promoted_turn_id TEXT
    )
  `
  yield* sql`CREATE INDEX IF NOT EXISTS session_inbox_session_idx ON session_inbox (session_id, status, created_at)`
  yield* sql`CREATE INDEX IF NOT EXISTS session_inbox_status_idx ON session_inbox (status, created_at)`
  // Older daemons allowed overlapping turns. Keep the newest active turn per
  // session and mark older ones interrupted before enforcing the invariant.
  yield* sql`
    UPDATE turns
    SET status = 'interrupted', updated_at = ${now}
    WHERE status IN ('queued', 'running', 'waiting_approval', 'resuming')
      AND id NOT IN (
        SELECT id FROM turns AS newest
        WHERE newest.session_id = turns.session_id
          AND newest.status IN ('queued', 'running', 'waiting_approval', 'resuming')
        ORDER BY newest.started_at DESC, newest.id DESC
        LIMIT 1
      )
  `
  yield* sql`
    CREATE UNIQUE INDEX IF NOT EXISTS turns_one_active_session_idx
    ON turns (session_id)
    WHERE status IN ('queued', 'running', 'waiting_approval', 'resuming')
  `

  const settings: Array<[string, string]> = [
    ["checkpoints.max_per_root", "20"],
    ["checkpoints.max_store_bytes", "524288000"],
    ["checkpoints.max_file_bytes", "10485760"],
    ["checkpoints.max_files", "50000"],
    ["checkpoints.retention_policy", "keep-until-pruned"],
    ["tui.theme", "system"],
    ["tui.keymap", "default"],
    ["tui.show_tool_details", "true"],
  ]
  for (const [key, value] of settings) {
    yield* sql`
      INSERT OR IGNORE INTO settings (key, value, updated_at)
      VALUES (${key}, ${value}, ${now})
    `
  }
})
