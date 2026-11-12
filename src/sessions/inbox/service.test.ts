import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Logger } from "../../core/log"
import { newId } from "../../core/ids"
import { Database } from "../../db/database"
import { EventService } from "../../events/service"
import { SessionInboxService, selectPromotable } from "./index"

const dirs: string[] = []
const databases: Database[] = []

afterEach(async () => {
  for (const db of databases.splice(0)) await db.close()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true, maxRetries: 5 })
})

async function setup() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-1-inbox-"))
  dirs.push(dir)
  const db = await Database.open({
    dbPath: path.join(dir, "agent-1.db"),
    backupDir: path.join(dir, "backups"),
  })
  databases.push(db)
  const logger = new Logger({ level: "error" })
  const events = new EventService(db, logger)
  const inbox = new SessionInboxService(db, events, logger)
  const session = await db.createSession("Inbox unit")
  return { dir, db, events, inbox, sessionId: session.session.id }
}

describe("Session inbox service", () => {
  test("keeps deterministic enqueue order and idempotent admission", async () => {
    const { inbox, sessionId } = await setup()
    const first = await inbox.admit({
      id: newId("msg"),
      sessionId,
      text: "first",
      delivery: "queue",
    })
    const second = await inbox.admit({
      id: newId("msg"),
      sessionId,
      text: "second",
      delivery: "steer",
    })
    expect((await inbox.list(sessionId)).map((item) => item.payload.text)).toEqual(["first", "second"])

    const duplicate = await inbox.admit({
      id: first.item.id,
      sessionId,
      text: "different payload",
      delivery: "steer",
    })
    expect(duplicate.item.payload.text).toBe("first")
    expect(duplicate.pending).toBe(true)
    expect(duplicate.event).toBeNull()
    expect(second.pending).toBe(true)
  })

  test("implements steer-first promotion ordering", () => {
    const queue = {
      id: "msg_q",
      sessionId: "ses",
      type: "user" as const,
      delivery: "queue" as const,
      payload: { text: "queued" },
      createdAt: "now",
    }
    const steer = {
      id: "msg_s",
      sessionId: "ses",
      type: "user" as const,
      delivery: "steer" as const,
      payload: { text: "steer" },
      createdAt: "now",
    }
    expect(selectPromotable([queue, steer], "steer").map((item) => item.id)).toEqual([steer.id])
    expect(selectPromotable([queue, steer], "input").map((item) => item.id)).toEqual([steer.id])
    expect(selectPromotable([queue], "input").map((item) => item.id)).toEqual([queue.id])
    expect(selectPromotable([queue], "steer")).toEqual([])
  })

  test("cancels and changes delivery with durable events", async () => {
    const { db, inbox, sessionId } = await setup()
    const queued = await inbox.admit({
      id: newId("msg"),
      sessionId,
      text: "queued",
      delivery: "queue",
    })
    const changed = await inbox.setDelivery(sessionId, queued.item.id, "steer")
    expect(changed.item?.delivery).toBe("steer")
    expect(changed.event?.type).toBe("session.inbox.delivery.changed")
    const delivered = await inbox.cancel(sessionId, queued.item.id)
    expect(delivered.item?.id).toBe(queued.item.id)
    expect(delivered.event?.type).toBe("session.inbox.cancelled")
    expect(await inbox.list(sessionId)).toEqual([])

    const events = await db.eventsAfter(0)
    const types = events.map((event) => event.type)
    expect(types).toContain("session.inbox.enqueued")
    expect(types).toContain("session.inbox.delivery.changed")
    expect(types).toContain("session.inbox.cancelled")
  })

  test("persists pending prompts across database reopen", async () => {
    const { dir, db, inbox, sessionId } = await setup()
    await inbox.admit({
      id: newId("msg"),
      sessionId,
      text: "survive",
      delivery: "queue",
    })
    await db.close()
    databases.splice(0, databases.length)
    const reopened = await Database.open({
      dbPath: path.join(dir, "agent-1.db"),
      backupDir: path.join(dir, "backups"),
    })
    databases.push(reopened)
    const logger = new Logger({ level: "error" })
    const service = new SessionInboxService(reopened, new EventService(reopened, logger), logger)
    expect((await service.list(sessionId)).map((item) => item.payload.text)).toEqual(["survive"])
  })
})
