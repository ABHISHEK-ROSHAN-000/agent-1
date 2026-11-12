import { afterEach, describe, expect, test } from "bun:test"
import { Database as BunDatabase } from "bun:sqlite"
import { ManagedRuntime } from "effect"
import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-bun"
import { mkdir, mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Database } from "./database"
import { backupIfNeeded, schemaVersion } from "./backup"
import { initialMigration } from "./migrations"
import { resetDatabaseFiles } from "./reset"

const tempDirs: string[] = []

afterEach(async () => {
  for (const dir of tempDirs.splice(0)) {
    await rm(dir, { recursive: true, force: true })
  }
})

async function tempDir(): Promise<string> {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-1-db-"))
  tempDirs.push(dir)
  return dir
}

function tableNames(dbPath: string): string[] {
  const raw = new BunDatabase(dbPath, { readonly: true })
  try {
    const rows = raw
      .query("SELECT name FROM sqlite_master WHERE type = 'table' ORDER BY name")
      .all() as Array<{ name: string }>
    return rows.map((row) => row.name)
  } finally {
    raw.close()
  }
}

describe("Database", () => {
  test("initializes the current schema and persists sessions, messages, and FTS5", async () => {
    const dir = await tempDir()
    const dbPath = path.join(dir, "agent-1.db")
    const backupDir = path.join(dir, "backups")

    const db = await Database.open({ dbPath, backupDir })
    try {
      const created = await db.createSession("Inbox")
      expect(created.session.title).toBe("Inbox")
      expect(created.event.seq).toBe(1)
      expect(created.event.type).toBe("session.created")

      const event = await db.appendEvent("test.event", created.session.id, { ok: true })
      expect(event.seq).toBe(2)
      expect(await db.latestEventSeq()).toBe(2)

      const turn = await db.createTurnWithUserMessage(
        created.session.id,
        "provider-test",
        "model-test",
        "hello from the fresh schema",
      )
      expect(turn.userMessage.text).toContain("fresh schema")

      const sessions = await db.listSessions()
      expect(sessions).toHaveLength(1)
      expect(sessions[0]?.id).toBe(created.session.id)

      expect(await db.getSession(created.session.id)).not.toBeNull()
      expect(await db.getSession("missing")).toBeNull()

      const after = await db.eventsAfter(0)
      expect(after.map((entry) => entry.seq)).toEqual([1, 2])
      expect(await db.eventsAfter(1)).toHaveLength(1)
    } finally {
      await db.close()
    }

    expect(schemaVersion(dbPath)).toBe(5)

    const tables = tableNames(dbPath)
    for (const table of [
      "sessions",
      "messages",
      "turns",
      "checkpoints",
      "agent_writes",
      "memory_entries",
      "memory_pending",
      "memory_history",
      "memory_review_runs",
      "session_inbox",
      "schema_migrations",
    ]) {
      expect(tables).toContain(table)
    }
    expect(tables).not.toContain("journal")

    const raw = new BunDatabase(dbPath, { readonly: true })
    try {
      const fts = raw
        .query("SELECT rowid, text FROM messages_fts WHERE messages_fts MATCH 'fresh'")
        .all() as Array<{ rowid: number; text: string }>
      expect(fts).toHaveLength(1)
      expect(fts[0]?.text).toContain("fresh schema")

      const memoryRows = raw.query("SELECT COUNT(*) AS count FROM memory_entries").get() as {
        count: number
      }
      expect(memoryRows.count).toBe(0)
    } finally {
      raw.close()
    }

    const reopened = await Database.open({ dbPath, backupDir })
    try {
      expect(await reopened.latestEventSeq()).toBe(2)
      expect(await reopened.listSessions()).toHaveLength(1)
    } finally {
      await reopened.close()
    }
  })

  test("migrates a fresh v1 baseline to the latest schema with a backup", async () => {
    const dir = await tempDir()
    const dbPath = path.join(dir, "agent-1.db")
    const backupDir = path.join(dir, "backups")
    const runtime = ManagedRuntime.make(SqliteClient.layer({ filename: dbPath }))
    try {
      await runtime.runPromise(
        SqliteMigrator.run({
          loader: SqliteMigrator.fromRecord({ "0001_initial": initialMigration }),
          table: "schema_migrations",
        }),
      )
    } finally {
      await runtime.dispose()
    }
    expect(schemaVersion(dbPath)).toBe(1)
    const raw = new BunDatabase(dbPath)
    try {
      raw.exec(`
        INSERT INTO sessions (id, title, created_at, updated_at)
        VALUES ('ses_v1', 'Legacy session', '2026-01-01T00:00:00.000Z', '2026-01-01T00:00:00.000Z')
      `)
    } finally {
      raw.close()
    }

    const upgraded = await Database.open({ dbPath, backupDir })
    try {
      expect(await upgraded.getSession("ses_v1")).not.toBeNull()
    } finally {
      await upgraded.close()
    }
    expect(schemaVersion(dbPath)).toBe(5)
    expect(tableNames(dbPath)).toContain("session_inbox")
    const backups = await readdir(backupDir)
    expect(backups.some((name) => name.endsWith(".db"))).toBe(true)
  })

  test("backs up a database before a simulated newer migration", async () => {
    const dir = await tempDir()
    const dbPath = path.join(dir, "agent-1.db")
    const backupDir = path.join(dir, "backups")
    const db = await Database.open({ dbPath, backupDir })
    await db.close()

    const backup = backupIfNeeded(dbPath, backupDir, 6)
    expect(backup).toBeDefined()
    const files = await readdir(backupDir)
    expect(files.some((name) => name.endsWith(".db"))).toBe(true)
  })

  test("development reset removes the database and backups, then initializes the current schema", async () => {
    const dir = await tempDir()
    const dbPath = path.join(dir, "agent-1.db")
    const backupDir = path.join(dir, "backups")
    const checkpointsDir = path.join(dir, "checkpoints")
    const db = await Database.open({ dbPath, backupDir })
    await db.createSession("Reset me")
    await db.close()
    await mkdir(checkpointsDir, { recursive: true })
    await writeFile(path.join(checkpointsDir, "sentinel"), "remove me\n")

    expect(backupIfNeeded(dbPath, backupDir, 6)).toBeDefined()

    const removed = resetDatabaseFiles({ dbPath, backupDir, checkpointsDir })
    expect(removed).toContain(dbPath)
    expect(removed).toContain(backupDir)
    expect(removed).toContain(checkpointsDir)
    expect(schemaVersion(dbPath)).toBe(0)
    expect(await readdir(backupDir).catch(() => [])).toEqual([])

    const fresh = await Database.open({ dbPath, backupDir })
    try {
      expect(await fresh.listSessions()).toEqual([])
    } finally {
      await fresh.close()
    }
    expect(schemaVersion(dbPath)).toBe(5)
  })
})
