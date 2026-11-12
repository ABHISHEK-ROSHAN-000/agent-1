import { Effect } from "effect"
import { SqlClient } from "effect/sql"

/**
 * Replace the Phase 8C placeholder inbox with the pending-only queue used by
 * Phase 8E. The placeholder never admitted work, so there is no queue data to
 * preserve; the table is rebuilt with the OpenCode-compatible shape.
 */
export const sessionInboxQueue = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`DROP INDEX IF EXISTS session_inbox_session_idx`
  yield* sql`DROP INDEX IF EXISTS session_inbox_status_idx`
  yield* sql`DROP TABLE IF EXISTS session_inbox`

  yield* sql`
    CREATE TABLE session_inbox (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      type TEXT NOT NULL,
      payload_json TEXT NOT NULL,
      delivery TEXT NOT NULL CHECK (delivery IN ('steer', 'queue')),
      enqueued_seq INTEGER NOT NULL,
      created_at TEXT NOT NULL
    )
  `
  yield* sql`
    CREATE UNIQUE INDEX session_inbox_session_enqueued_seq_idx
    ON session_inbox (session_id, enqueued_seq)
  `
  yield* sql`
    CREATE INDEX session_inbox_session_delivery_seq_idx
    ON session_inbox (session_id, delivery, enqueued_seq)
  `
})
