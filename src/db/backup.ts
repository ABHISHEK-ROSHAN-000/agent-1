import { Database as BunDatabase } from "bun:sqlite"
import { copyFileSync, existsSync, mkdirSync, readdirSync, statSync, unlinkSync } from "node:fs"
import path from "node:path"

const BACKUP_KEEP = 5

export function schemaVersion(dbPath: string): number {
  if (!existsSync(dbPath)) return 0
  let db: BunDatabase | undefined
  try {
    db = new BunDatabase(dbPath, { readonly: true })
    const table = db
      .query("SELECT name FROM sqlite_master WHERE type = 'table' AND name = 'schema_migrations'")
      .get() as { name?: string } | null
    if (!table?.name) return 0
    const row = db.query("SELECT MAX(migration_id) AS version FROM schema_migrations").get() as {
      version?: number | null
    } | null
    return Number(row?.version ?? 0)
  } catch {
    return 0
  } finally {
    db?.close()
  }
}

export function backupIfNeeded(
  dbPath: string,
  backupDir: string,
  targetVersion: number,
): string | undefined {
  if (!existsSync(dbPath)) return undefined
  try {
    if (statSync(dbPath).size === 0) return undefined
  } catch {
    return undefined
  }
  const current = schemaVersion(dbPath)
  if (current >= targetVersion) return undefined

  mkdirSync(backupDir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  const destination = path.join(backupDir, `agent-1-${stamp}-v${current}.db`)

  let source: BunDatabase | undefined
  try {
    source = new BunDatabase(dbPath)
    source.exec("PRAGMA wal_checkpoint(TRUNCATE)")
  } catch {
    // If the database cannot be opened cleanly, copy the file as a best effort.
  } finally {
    source?.close()
  }

  copyFileSync(dbPath, destination)
  pruneBackups(backupDir)
  return destination
}

function pruneBackups(backupDir: string): void {
  try {
    const files = readdirSync(backupDir)
      .filter((name) => name.endsWith(".db"))
      .map((name) => path.join(backupDir, name))
      .sort()
    for (const file of files.slice(0, Math.max(0, files.length - BACKUP_KEEP))) {
      unlinkSync(file)
    }
  } catch {
    // Retention is best effort.
  }
}
