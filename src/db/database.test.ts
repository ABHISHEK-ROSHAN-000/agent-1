import { afterEach, describe, expect, test } from "bun:test"
import { Database as BunDatabase } from "bun:sqlite"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Database } from "./database"
import { backupIfNeeded, schemaVersion } from "./backup"
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
  test("initializes the fresh v1 schema and persists sessions, messages, and FTS5", async () => {
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

    expect(schemaVersion(dbPath)).toBe(1)

    const tables = tableNames(dbPath)
    for (const table of [
      "sessions",
      "messages",
      "turns",
      "memory_entries",
      "memory_pending",
      "memory_history",
      "memory_review_runs",
      "schema_migrations",
    ]) {
      expect(tables).toContain(table)
    }

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

  test("backs up a database before a simulated newer migration", async () => {
    const dir = await tempDir()
    const dbPath = path.join(dir, "agent-1.db")
    const backupDir = path.join(dir, "backups")
    const db = await Database.open({ dbPath, backupDir })
    await db.close()

    const backup = backupIfNeeded(dbPath, backupDir, 2)
    expect(backup).toBeDefined()
    const files = await readdir(backupDir)
    expect(files.some((name) => name.endsWith(".db"))).toBe(true)
  })

  test("development reset removes the database and backups, then initializes v1", async () => {
    const dir = await tempDir()
    const dbPath = path.join(dir, "agent-1.db")
    const backupDir = path.join(dir, "backups")
    const db = await Database.open({ dbPath, backupDir })
    await db.createSession("Reset me")
    await db.close()

    expect(backupIfNeeded(dbPath, backupDir, 2)).toBeDefined()

    const removed = resetDatabaseFiles({ dbPath, backupDir })
    expect(removed).toContain(dbPath)
    expect(removed).toContain(backupDir)
    expect(schemaVersion(dbPath)).toBe(0)
    expect(await readdir(backupDir).catch(() => [])).toEqual([])

    const fresh = await Database.open({ dbPath, backupDir })
    try {
      expect(await fresh.listSessions()).toEqual([])
    } finally {
      await fresh.close()
    }
    expect(schemaVersion(dbPath)).toBe(1)
  })
})
