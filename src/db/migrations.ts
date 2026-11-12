import { SqliteMigrator } from "@effect/sql-sqlite-bun"
import { initialMigration } from "./migrations/0001_initial"
import { checkpointsMigration } from "./migrations/0002_checkpoints"
import { sessionContracts } from "./migrations/0003_session_contracts"
import { sessionInboxQueue } from "./migrations/0004_session_inbox_queue"
import { attachmentsMigration } from "./migrations/0005_attachments"

export { initialMigration } from "./migrations/0001_initial"

/**
 * Canonical schema baseline plus ordered migrations.
 *
 * The database uses `schema_migrations`, backs up before upgrades, and never
 * resets itself during normal startup. Development resets stay explicit in the
 * CLI.
 */
export const LATEST_SCHEMA_VERSION = 5

export const migrationLoader = SqliteMigrator.fromRecord({
  "0001_initial": initialMigration,
  "0002_checkpoints": checkpointsMigration,
  "0003_session_contracts": sessionContracts,
  "0004_session_inbox_queue": sessionInboxQueue,
  "0005_attachments": attachmentsMigration,
})

export const migrationNames = [
  "0001_initial",
  "0002_checkpoints",
  "0003_session_contracts",
  "0004_session_inbox_queue",
  "0005_attachments",
] as const