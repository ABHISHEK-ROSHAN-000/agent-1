import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Logger } from "../core/log"
import { Database } from "../db/database"
import { MemoryService } from "../memory/memory-service"
import { createTestCheckpointManager } from "../test/checkpoints"
import { ToolService } from "./tool-service"
import { PathPolicy } from "./path-policy"

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function setup(memoryLimit = 2_200) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-1-memory-tool-"))
  const db = await Database.open({
    dbPath: path.join(dir, "agent-1.db"),
    backupDir: path.join(dir, "backups"),
  })
  const logger = new Logger({ level: "error" })
  const memory = new MemoryService(db, { memoryLimit })
  const checkpoints = await createTestCheckpointManager(db, dir, logger)
  const tools = new ToolService(
    new PathPolicy(db, logger, dir),
    checkpoints,
    logger,
    memory,
  )
  cleanups.push(async () => {
    await db.close()
    await rm(dir, { recursive: true, force: true })
  })
  return { db, memory, tools }
}

describe("memory tool", () => {
  test("exposes the memory tool and applies add, patch, and remove", async () => {
    const { memory, tools } = await setup()
    expect(tools.definitions().memory).toBeDefined()
    expect(tools.action("memory")).toBe("memory.write")
    expect(tools.risk("memory")).toBe("write")
    expect(tools.list().find((tool) => tool.name === "memory")?.approvalRequired).toBe(false)

    const added = (await tools.execute(
      "memory",
      {
        target: "memory",
        operations: [{ action: "add", content: "Project uses TypeScript." }],
      },
      { sessionId: "ses-test", turnId: "turn-test" },
    )) as { success: boolean; changed: boolean }
    expect(added.success).toBe(true)
    expect(added.changed).toBe(true)
    expect((await memory.load("memory")).entries).toEqual(["Project uses TypeScript."])

    const patched = (await tools.execute(
      "memory",
      {
        target: "memory",
        operations: [{ action: "patch", oldText: "TypeScript", content: "Bun and TypeScript" }],
      },
      {},
    )) as { success: boolean }
    expect(patched.success).toBe(true)
    expect((await memory.load("memory")).entries).toEqual(["Project uses Bun and TypeScript."])

    const removed = (await tools.execute(
      "memory",
      { target: "memory", operations: [{ action: "remove", oldText: "Project uses" }] },
      {},
    )) as { success: boolean }
    expect(removed.success).toBe(true)
    expect((await memory.load("memory")).entries).toEqual([])
  })

  test("returns actionable memory errors instead of throwing", async () => {
    const { tools } = await setup(12)
    const result = (await tools.execute(
      "memory",
      { target: "memory", operations: [{ action: "add", content: "too long for this store" }] },
      {},
    )) as {
      success: boolean
      code: string
      required_free: number
      current_entries: string[]
    }
    expect(result.success).toBe(false)
    expect(result.code).toBe("over_limit")
    expect(result.required_free).toBeGreaterThan(0)
    expect(result.current_entries).toEqual([])
  })
})
