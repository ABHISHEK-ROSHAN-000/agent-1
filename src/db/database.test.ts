import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Database } from "./database"
import { backupIfNeeded, schemaVersion } from "./backup"

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

describe("Database", () => {
  test("migrates, persists sessions and event sequence", async () => {
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

    expect(schemaVersion(dbPath)).toBe(4)

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

    const backup = backupIfNeeded(dbPath, backupDir, 5)
    expect(backup).toBeDefined()
    const files = await readdir(backupDir)
    expect(files.some((name) => name.endsWith(".db"))).toBe(true)
  })
})
