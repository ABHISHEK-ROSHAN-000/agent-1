import { resolveConfig } from "../src/core/config"
import { isProcessAlive } from "../src/daemon/lock"
import { readState } from "../src/daemon/state"
import { schemaVersion } from "../src/db/backup"
import { Database } from "../src/db/database"
import { resetDatabaseFiles } from "../src/db/reset"

const confirmed = process.argv.includes("--yes")
const config = resolveConfig()

console.log(`Database: ${config.dbPath}`)
console.log(`Backups:  ${config.backupDir}`)
console.log(`Version:  v${schemaVersion(config.dbPath)}`)

if (!confirmed) {
  console.error("Refusing to delete the development database without --yes.")
  console.error("Stop the daemon, then run: bun run db:reset -- --yes")
  process.exit(1)
}

const state = readState(config.statePath)
if (state && isProcessAlive(state.pid)) {
  console.error(`Agent-1 is running (PID ${state.pid}). Run 'bun run src/cli/main.ts service stop' first.`)
  process.exit(1)
}

try {
  const removed = resetDatabaseFiles(config)
  if (removed.length === 0) {
    console.log("No development database files existed.")
  } else {
    for (const path of removed) console.log(`Removed ${path}`)
  }

  const db = await Database.open({ dbPath: config.dbPath, backupDir: config.backupDir })
  await db.close()
  console.log(`Initialized fresh schema v${schemaVersion(config.dbPath)}.`)
  console.log("Reconnect providers/models and recreate sessions as needed.")
} catch (error) {
  console.error(`Reset failed: ${error instanceof Error ? error.message : String(error)}`)
  process.exit(1)
}
