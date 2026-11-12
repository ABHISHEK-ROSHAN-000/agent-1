import { afterEach, describe, expect, test } from "bun:test"
import { copyFileSync } from "node:fs"
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Logger } from "../core/log"
import { Database } from "../db/database"
import { CheckpointManager } from "../checkpoints/manager"
import { createTestCheckpointManager } from "../test/checkpoints"
import { PathPolicy } from "./path-policy"
import { ToolContentResult, ToolService } from "./tool-service"

const dirs: string[] = []
const dbs: Database[] = []

afterEach(async () => {
  delete process.env.AGENT1_CRASH_AFTER_MOVE
  delete process.env.AGENT1_CRASH_MODE
  for (const db of dbs.splice(0)) await db.close()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true, maxRetries: 5 })
})

async function setup() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "agent-1-tools-data-"))
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-1-tools-root-"))
  dirs.push(dataDir, root)
  const db = await Database.open({
    dbPath: path.join(dataDir, "agent-1.db"),
    backupDir: path.join(dataDir, "backups"),
  })
  dbs.push(db)
  const logger = new Logger({ level: "error" })
  const pathPolicy = new PathPolicy(db, logger, dataDir)
  const checkpoints = await createTestCheckpointManager(db, dataDir, logger)
  const tools = new ToolService(pathPolicy, checkpoints, logger)
  return { dataDir, root, db, logger, pathPolicy, checkpoints, tools }
}

describe("filesystem tools", () => {
  test("lists, reads, searches, writes, and restores without a workspace grant", async () => {
    const { root, tools, checkpoints } = await setup()
    await writeFile(path.join(root, "a.txt"), "alpha\n")
    await writeFile(path.join(root, "b.txt"), "beta\n")

    const listed = (await tools.execute("fs_list", { path: root }, {})) as {
      entries: Array<{ name: string }>
    }
    expect(listed.entries.map((entry) => entry.name).sort()).toEqual(["a.txt", "b.txt"])
    const read = (await tools.execute("fs_read", { path: path.join(root, "a.txt") }, {})) as {
      content: string
    }
    expect(read.content).toBe("alpha\n")
    const search = (await tools.execute("fs_search", { root, pattern: "a" }, {})) as {
      matches: string[]
    }
    expect(search.matches).toContain(path.join(root, "a.txt"))

    const written = (await tools.execute(
      "fs_write",
      { path: path.join(root, "c.txt"), content: "gamma\n" },
      { toolCallId: "write-batch" },
    )) as { path: string; sha256: string; checkpointId: string }
    expect(written.sha256).toHaveLength(64)
    expect(written.checkpointId).toBeTruthy()
    expect(await readdir(root)).toContain("c.txt")

    const restored = await checkpoints.restore(written.checkpointId, { safe: true })
    expect(restored.restoredFiles).toEqual([])
    expect(restored.deletedFiles).toContain("c.txt")
    expect(await readdir(root)).not.toContain("c.txt")
  })

  test("returns image and PDF bytes as structured media for the model", async () => {
    const { root, tools } = await setup()
    copyFileSync(
      path.join(import.meta.dir, "..", "..", "web", "public", "icon-192.png"),
      path.join(root, "icon.png"),
    )
    const result = await tools.execute("fs_read", { path: path.join(root, "icon.png") }, {})
    expect(result).toBeInstanceOf(ToolContentResult)
    if (!(result instanceof ToolContentResult)) throw new Error("expected media result")
    expect(result.content.some((item) => item.type === "text" && item.text.includes("Image read"))).toBe(true)
    const file = result.content.find((item) => item.type === "file")
    expect(file?.mime).toBe("image/png")
    expect(file?.uri.startsWith("data:image/png;base64,")).toBe(true)
  })

  test("does not mutate when checkpoint capture fails", async () => {
    const { root, tools } = await setup()
    const target = path.join(root, "must-not-exist.txt")
    process.env.AGENT1_CHECKPOINT_FAULT = "after-stage"
    try {
      await expect(
        tools.execute("fs_write", { path: target, content: "no\n" }, { toolCallId: "fault-write" }),
      ).rejects.toThrow("Injected checkpoint fault")
      expect(await Bun.file(target).exists()).toBe(false)
    } finally {
      delete process.env.AGENT1_CHECKPOINT_FAULT
    }
  })

  test("prepares, applies, and restores a move batch with created directories", async () => {
    const { root, tools, checkpoints } = await setup()
    await writeFile(path.join(root, "a.txt"), "A\n")
    await writeFile(path.join(root, "b.txt"), "B\n")
    const prepared = (await tools.execute(
      "fs_prepare_moves",
      {
        root,
        moves: [
          { from: "a.txt", to: "sorted/a.txt" },
          { from: "b.txt", to: "sorted/b.txt" },
        ],
      },
      {},
    )) as { planHash: string; moves: Array<{ sha256: string }> }
    expect(prepared.planHash).toHaveLength(64)

    const applied = (await tools.execute(
      "fs_apply_moves",
      {
        root,
        moves: prepared.moves.map((move, index) => ({
          from: index === 0 ? "a.txt" : "b.txt",
          to: index === 0 ? "sorted/a.txt" : "sorted/b.txt",
          sha256: move.sha256,
        })),
      },
      { toolCallId: "move-batch" },
    )) as { batchId: string; applied: number; checkpointId: string }
    expect(applied.batchId).toBe("move-batch")
    expect(applied.applied).toBe(2)
    expect(applied.checkpointId).toBeTruthy()
    expect(await readdir(path.join(root, "sorted"))).toEqual(["a.txt", "b.txt"])

    const restored = await checkpoints.restore(applied.checkpointId, { safe: true })
    expect(restored.restoredFiles).toContain("a.txt")
    expect(restored.restoredFiles).toContain("b.txt")
    expect(restored.deletedFiles).toContain("sorted/a.txt")
    expect(restored.deletedFiles).toContain("sorted/b.txt")
    expect(await readdir(root)).toContain("a.txt")
    expect(await readdir(root)).toContain("b.txt")
    expect(await readdir(path.join(root, "sorted")).catch(() => [])).toEqual([])
  })

  test("hides mutating tools when checkpoints are unavailable", async () => {
    const { dataDir, db, logger, pathPolicy } = await setup()
    const missing = new CheckpointManager(
      db,
      logger,
      path.join(dataDir, "no-git"),
      undefined,
      20,
      500 * 1024 * 1024,
      50_000,
      10 * 1024 * 1024,
      "agent1-missing-git-for-tools",
    )
    await missing.initialize()
    const tools = new ToolService(pathPolicy, missing, logger)
    const names = tools.list().map((entry) => entry.name)
    expect(names).not.toContain("fs_write")
    expect(names).not.toContain("fs_mkdir")
    expect(names).not.toContain("fs_apply_moves")
    expect(names).toContain("fs_list")
  })

  test("blocks traversal, protected paths, and hard delete", async () => {
    const { dataDir, root, tools } = await setup()
    await expect(
      tools.execute("fs_prepare_moves", { root, moves: [{ from: "a.txt", to: "../escape.txt" }] }, {}),
    ).rejects.toThrow()
    await expect(
      tools.execute("fs_write", { path: path.join(dataDir, "secret.txt"), content: "no" }, {}),
    ).rejects.toThrow("protected")
    await expect(
      tools.execute("fs_read", { path: path.join(root, ".env") }, {}),
    ).rejects.toThrow("protected")
    await expect(tools.execute("fs_delete", { path: path.join(root, "a.txt") }, {})).rejects.toThrow(
      "Hard delete is disabled",
    )
  })

  test("runs a bounded shell command with a checkpoint", async () => {
    const { root, tools, checkpoints } = await setup()
    const result = (await tools.execute(
      "shell_exec",
      { command: "echo phase4-shell", cwd: root, timeoutMs: 5_000 },
      { turnId: "shell-turn" },
    )) as { stdout: string; exitCode: number }
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("phase4-shell")
    expect((await checkpoints.list(10)).some((item) => item.reason === "before shell_exec")).toBe(true)
  })

  test("blocks private and metadata URLs", async () => {
    const { tools } = await setup()
    await expect(tools.execute("web_fetch", { url: "http://127.0.0.1:1" }, {})).rejects.toThrow(
      "Private",
    )
    await expect(tools.execute("web_fetch", { url: "http://169.254.169.254/latest/meta-data" }, {})).rejects.toThrow(
      "Private",
    )
    await expect(tools.execute("web_fetch", { url: "file:///C:/Windows/win.ini" }, {})).rejects.toThrow(
      "http",
    )
  })

  test("resumes a 500-file batch after injected failure and restores it", async () => {
    const { root, tools, checkpoints } = await setup()
    const moves: Array<{ from: string; to: string; sha256: string }> = []
    for (let index = 0; index < 500; index++) {
      const name = `file-${index.toString().padStart(3, "0")}.txt`
      await writeFile(path.join(root, name), `content-${index}\n`)
    }
    for (let index = 0; index < 500; index++) {
      const name = `file-${index.toString().padStart(3, "0")}.txt`
      const prepared = (await tools.execute("fs_prepare_moves", { root, moves: [{ from: name, to: `sorted/${name}` }] }, {})) as {
        moves: Array<{ sha256: string }>
      }
      moves.push({ from: name, to: `sorted/${name}`, sha256: prepared.moves[0]!.sha256 })
    }

    process.env.AGENT1_CRASH_AFTER_MOVE = "250"
    process.env.AGENT1_CRASH_MODE = "throw"
    let checkpointId: string | undefined
    await expect(
      tools.execute("fs_apply_moves", { root, moves }, { toolCallId: "batch-500" }),
    ).rejects.toThrow("Injected checkpoint move crash")
    delete process.env.AGENT1_CRASH_AFTER_MOVE
    delete process.env.AGENT1_CRASH_MODE

    const resumed = (await tools.execute(
      "fs_apply_moves",
      { root, moves },
      { toolCallId: "batch-500" },
    )) as { applied: number; skipped: number; checkpointId: string }
    expect(resumed.skipped).toBe(250)
    expect(resumed.applied).toBe(250)
    expect(await readdir(path.join(root, "sorted"))).toHaveLength(500)
    checkpointId = resumed.checkpointId

    const restored = await checkpoints.restore(checkpointId, { safe: true })
    expect(restored.failedDeletes).toEqual([])
    const restoredRoot = await readdir(root)
    expect(restoredRoot.filter((name) => name !== "sorted")).toHaveLength(500)
    expect(await readdir(path.join(root, "sorted")).catch(() => [])).toEqual([])
  }, 120_000)
})
