import { Effect } from "effect"
import { SqlClient } from "effect/sql"

/**
 * Content-addressed attachment storage. Message and inbox payloads carry
 * media:<sha256> refs; bytes live here and are released when no row references
 * them.
 */
export const attachmentsMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    CREATE TABLE IF NOT EXISTS blobs (
      hash TEXT PRIMARY KEY,
      mime TEXT NOT NULL,
      bytes INTEGER NOT NULL,
      width INTEGER,
      height INTEGER,
      data BLOB NOT NULL
    )
  `
  yield* sql`
    CREATE TABLE IF NOT EXISTS blob_refs (
      session_id TEXT NOT NULL,
      message_id TEXT NOT NULL,
      hash TEXT NOT NULL,
      seq INTEGER NOT NULL,
      PRIMARY KEY (session_id, message_id, hash)
    )
  `
  yield* sql`CREATE INDEX IF NOT EXISTS blob_refs_hash_idx ON blob_refs (hash)`
  yield* sql`CREATE INDEX IF NOT EXISTS blob_refs_session_idx ON blob_refs (session_id, seq)`
  yield* sql`ALTER TABLE messages ADD COLUMN files_json TEXT`
})
