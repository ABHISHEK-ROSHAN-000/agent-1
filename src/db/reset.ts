import { existsSync, rmSync } from "node:fs"

export interface ResetDatabaseOptions {
  readonly dbPath: string
  readonly backupDir: string
}

/**
 * Delete the development database and its backups.
 *
 * This is intentionally explicit: normal daemon startup never wipes data.
 */
export function resetDatabaseFiles(options: ResetDatabaseOptions): string[] {
  const targets = [
    options.dbPath,
    `${options.dbPath}-wal`,
    `${options.dbPath}-shm`,
    `${options.dbPath}-journal`,
    options.backupDir,
  ]
  const removed: string[] = []
  for (const target of targets) {
    if (!existsSync(target)) continue
    rmSync(target, { recursive: true, force: true })
    removed.push(target)
  }
  return removed
}
