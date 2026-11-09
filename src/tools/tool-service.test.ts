import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Logger } from "../core/log"
import { Database } from "../db/database"
import { JournalService } from "./journal-service"
import { ToolService } from "./tool-service"
import { WorkspaceService } from "./workspace-service"

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
  const workspace = new WorkspaceService(db, logger, dataDir)
  const journal = new JournalService(db, logger)
  const tools = new ToolService(workspace, journal, logger)
  await workspace.add({ path: root, label: "Test", access: "write" })
  return { dataDir, root, db, logger, workspace, journal, tools }
}

describe("workspace and filesystem tools", () => {
  test("lists, reads, searches, writes, and undoes inside a granted workspace", async () => {
    const { root, tools, journal } = await setup()
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
    )) as { path: string; sha256: string }
    expect(written.sha256).toHaveLength(64)
    expect(await readdir(root)).toContain("c.txt")
    const undo = await journal.undoBatch("write-batch")
    expect(undo.undone).toBe(1)
    expect(await readdir(root)).not.toContain("c.txt")
  })

  test("prepares, applies, and undoes a move batch with created directories", async () => {
    const { root, tools, journal } = await setup()
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
    )) as { batchId: string; applied: number }
    expect(applied.batchId).toBe("move-batch")
    expect(applied.applied).toBe(2)
    expect(await readdir(path.join(root, "sorted"))).toEqual(["a.txt", "b.txt"])

    const undo = await journal.undoBatch("move-batch")
    expect(undo.undone).toBeGreaterThanOrEqual(2)
    expect(await readdir(root)).toContain("a.txt")
    expect(await readdir(root)).toContain("b.txt")
    expect(await readdir(path.join(root, "sorted")).catch(() => [])).toEqual([])
  })

  test("blocks traversal, protected paths, and hard delete", async () => {
    const { dataDir, root, tools, workspace } = await setup()
    await expect(
      tools.execute("fs_prepare_moves", { root, moves: [{ from: "a.txt", to: "../escape.txt" }] }, {}),
    ).rejects.toThrow()
    await expect(workspace.add({ path: dataDir, access: "write" })).rejects.toThrow("protected")
    await expect(tools.execute("fs_delete", { path: path.join(root, "a.txt") }, {})).rejects.toThrow(
      "Hard delete is disabled",
    )
  })

  test("runs a bounded shell command", async () => {
    const { root, tools } = await setup()
    const result = (await tools.execute(
      "shell_exec",
      { command: "echo phase4-shell", cwd: root, timeoutMs: 5_000 },
      {},
    )) as { stdout: string; exitCode: number }
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("phase4-shell")
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

  test("resumes a 500-file batch after injected failure and undoes it", async () => {
    const { root, tools, journal } = await setup()
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
    await expect(
      tools.execute("fs_apply_moves", { root, moves }, { toolCallId: "batch-500" }),
    ).rejects.toThrow("Injected journal crash")
    delete process.env.AGENT1_CRASH_AFTER_MOVE
    delete process.env.AGENT1_CRASH_MODE

    const resumed = (await tools.execute(
      "fs_apply_moves",
      { root, moves },
      { toolCallId: "batch-500" },
    )) as { applied: number; skipped: number }
    expect(resumed.skipped).toBe(250)
    expect(resumed.applied).toBe(250)
    expect(await readdir(path.join(root, "sorted"))).toHaveLength(500)

    const undo = await journal.undoBatch("batch-500")
    expect(undo.errors).toEqual([])
    const restored = await readdir(root)
    expect(restored).toHaveLength(500)
    expect(await readdir(path.join(root, "sorted")).catch(() => [])).toEqual([])
  }, 60_000)
})
