import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Logger } from "../core/log"
import { Database } from "../db/database"
import { SessionSearchService } from "../memory/session-search-service"
import { createTestCheckpointManager } from "../test/checkpoints"
import { ToolService } from "./tool-service"
import { PathPolicy } from "./path-policy"

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function setup() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-1-session-tool-"))
  const db = await Database.open({
    dbPath: path.join(dir, "agent-1.db"),
    backupDir: path.join(dir, "backups"),
  })
  const logger = new Logger({ level: "error" })
  const search = new SessionSearchService(db)
  const checkpoints = await createTestCheckpointManager(db, dir, logger)
  const tools = new ToolService(
    new PathPolicy(db, logger, dir),
    checkpoints,
    logger,
    undefined,
    search,
  )
  cleanups.push(async () => {
    await db.close()
    await rm(dir, { recursive: true, force: true })
  })
  return { db, tools }
}

describe("session_search tool", () => {
  test("exposes a read-only search tool and returns actual messages", async () => {
    const { db, tools } = await setup()
    const session = (await db.createSession("Searchable session")).session
    const created = await db.createTurnWithUserMessage(
      session.id,
      "test-provider",
      "test-model",
      "Find the release checklist",
    )
    await db.saveTurnStep(created.turn.id, {
      step: 1,
      sessionId: session.id,
      messages: [
        {
          role: "assistant",
          text: "Use the Orion release checklist.",
          content: { role: "assistant", content: "Use the Orion release checklist." },
        },
      ],
      checkpoint: {},
      status: "completed",
    })

    expect(tools.definitions().session_search).toBeDefined()
    const info = tools.list().find((tool) => tool.name === "session_search")
    expect(info?.readOnly).toBe(true)
    expect(info?.action).toBe("session.search")

    const result = (await tools.execute(
      "session_search",
      { query: "Orion checklist" },
      { sessionId: "other-session" },
    )) as {
      ok: boolean
      mode: string
      results: Array<{ title: string; matches: Array<{ text: string }> }>
    }
    expect(result.ok).toBe(true)
    expect(result.mode).toBe("discover")
    expect(result.results[0]?.title).toBe("Searchable session")
    expect(result.results[0]?.matches[0]?.text).toContain("Orion release checklist")
  })
})
