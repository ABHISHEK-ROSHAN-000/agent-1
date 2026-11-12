import { afterEach, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdir, mkdtemp, readFile, readdir, rm, stat, utimes, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Logger } from "../core/log"
import { Database } from "../db/database"
import { CheckpointManager } from "./manager"
import { createTestCheckpointManager } from "../test/checkpoints"

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  delete process.env.AGENT1_CHECKPOINT_FAULT
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function setup() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "agent-1-checkpoints-data-"))
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-1-checkpoints-root-"))
  const db = await Database.open({
    dbPath: path.join(dataDir, "agent-1.db"),
    backupDir: path.join(dataDir, "backups"),
  })
  const logger = new Logger({ level: "error" })
  const checkpoints = await createTestCheckpointManager(db, dataDir, logger)
  cleanups.push(async () => {
    await db.close()
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5 })
    await rm(root, { recursive: true, force: true, maxRetries: 5 })
  })
  return { dataDir, root, checkpoints, db }
}

async function checkpoint(
  checkpoints: Awaited<ReturnType<typeof createTestCheckpointManager>>,
  rootPath: string,
  turnId: string,
  reason = "test checkpoint",
) {
  const result = await checkpoints.ensureCheckpointForPath({ rootPath, turnId, reason })
  if (!result) throw new Error("checkpoint was not created")
  return result
}

describe("shadow-Git checkpoints", () => {
  test("takes one checkpoint per turn and skips a no-op turn", async () => {
    const { root, checkpoints } = await setup()
    await writeFile(path.join(root, "a.txt"), "alpha\n")

    const first = await checkpoint(checkpoints, root, "turn-1")
    const duplicate = await checkpoints.ensureCheckpointForPath({ rootPath: root, turnId: "turn-1", reason: "again" })
    expect(duplicate?.id).toBe(first.id)

    const noOp = await checkpoints.ensureCheckpointForPath({ rootPath: root, turnId: "turn-2", reason: "no changes" })
    expect(noOp).toBeNull()
  })

  test("safe restore preserves a user hand-edit", async () => {
    const { root, checkpoints } = await setup()
    const target = path.join(root, "agent.txt")
    await writeFile(path.join(root, "base.txt"), "base\n")
    const cp = await checkpoint(checkpoints, root, "turn-1")
    await writeFile(target, "agent content\n")
    await checkpoints.recordAgentWrite(root, target)
    await writeFile(target, "user changed this\n")

    const result = await checkpoints.restore(cp.id, { safe: true })
    expect(result.skippedUserEdits).toContain("agent.txt")
    expect(await readFile(target, "utf8")).toBe("user changed this\n")
  })

  test("restores agent-written files and takes a pre-rollback snapshot", async () => {
    const { root, checkpoints } = await setup()
    const target = path.join(root, "agent.txt")
    await writeFile(path.join(root, "base.txt"), "base\n")
    const cp = await checkpoint(checkpoints, root, "turn-1")
    await writeFile(target, "agent content\n")
    await checkpoints.recordAgentWrite(root, target)

    const result = await checkpoints.restore(cp.id, { safe: true })
    expect(result.deletedFiles).toContain("agent.txt")
    await expect(readFile(target, "utf8")).rejects.toThrow()

    const list = await checkpoints.list(10)
    expect(list.some((item) => item.reason.startsWith("pre-rollback snapshot"))).toBe(true)
  })

  test("reports diffs and restores Unicode paths", async () => {
    const { root, checkpoints } = await setup()
    const target = path.join(root, "café.txt")
    await writeFile(target, "original\n")
    const cp = await checkpoint(checkpoints, root, "turn-1")
    await writeFile(target, "changed\n")
    await checkpoints.recordAgentWrite(root, target)

    const diff = await checkpoints.diff(cp.id)
    expect(diff.files.some((file) => file.path === "café.txt")).toBe(true)

    const result = await checkpoints.restore(cp.id, { safe: true })
    expect(result.restoredFiles).toContain("café.txt")
    expect(await readFile(target, "utf8")).toBe("original\n")
  })

  test("does not touch a project .git directory", async () => {
    const { root, checkpoints } = await setup()
    const sentinel = path.join(root, ".git", "sentinel")
    await writeFile(path.join(root, "a.txt"), "alpha\n")
    await mkdir(path.join(root, ".git"), { recursive: true })
    await writeFile(sentinel, "keep me\n")

    await checkpoint(checkpoints, root, "turn-1")
    expect(await readFile(sentinel, "utf8")).toBe("keep me\n")
    expect((await stat(path.join(root, ".git"))).isDirectory()).toBe(true)
  })

  test("refuses a full restore when the checkpoint captured a nested Git repo", async () => {
    const { root, checkpoints } = await setup()
    const nested = path.join(root, "nested")
    await mkdir(nested, { recursive: true })
    const init = spawnSync("git", ["init"], { cwd: nested, windowsHide: true })
    expect(init.status).toBe(0)
    await writeFile(path.join(nested, "inside.txt"), "nested\n")
    expect(spawnSync("git", ["add", "."], { cwd: nested, windowsHide: true }).status).toBe(0)
    expect(
      spawnSync(
        "git",
        ["-c", "user.name=Test", "-c", "user.email=test@example.com", "commit", "-m", "nested"],
        { cwd: nested, windowsHide: true },
      ).status,
    ).toBe(0)
    await writeFile(path.join(root, "a.txt"), "alpha\n")
    const cp = await checkpoint(checkpoints, root, "turn-1")

    await expect(checkpoints.restore(cp.id, { safe: true })).rejects.toThrow("nested Git repositories")
  })

  test("skips a root over the file-count guard", async () => {
    const { dataDir, root, db } = await setup()
    const limited = new CheckpointManager(
      db,
      new Logger({ level: "error" }),
      path.join(dataDir, "limited"),
      undefined,
      20,
      500 * 1024 * 1024,
      2,
      1024,
    )
    await limited.initialize()
    await db.setSetting("checkpoints.max_files", "2")
    await writeFile(path.join(root, "a.txt"), "a\n")
    await writeFile(path.join(root, "b.txt"), "b\n")
    await writeFile(path.join(root, "c.txt"), "c\n")
    await expect(
      limited.ensureCheckpointForPath({ rootPath: root, turnId: "turn-limit", reason: "too many" }),
    ).rejects.toThrow("file guard")
  })

  test("excludes oversized files from the checkpoint tree", async () => {
    const { dataDir, root, db } = await setup()
    const limited = new CheckpointManager(
      db,
      new Logger({ level: "error" }),
      path.join(dataDir, "oversize"),
      undefined,
      20,
      500 * 1024 * 1024,
      50_000,
      4,
    )
    await limited.initialize()
    await db.setSetting("checkpoints.max_file_bytes", "4")
    await writeFile(path.join(root, "small.txt"), "ok\n")
    await writeFile(path.join(root, "large.txt"), "this is larger than four bytes\n")
    const cp = await limited.ensureCheckpointForPath({ rootPath: root, turnId: "turn-oversize", reason: "oversize" })
    expect(cp).not.toBeNull()
    const tree = spawnSync(
      "git",
      ["--git-dir", path.join(dataDir, "oversize", "store"), "ls-tree", "-r", "--name-only", cp!.commit],
      { windowsHide: true, encoding: "utf8" },
    )
    expect(tree.status).toBe(0)
    expect(tree.stdout).toContain("small.txt")
    expect(tree.stdout).not.toContain("large.txt")
  })

  test("clears an abandoned index lock before checkpointing", async () => {
    const { dataDir, root, checkpoints } = await setup()
    await writeFile(path.join(root, "a.txt"), "alpha\n")
    const first = await checkpoint(checkpoints, root, "turn-1")
    const lock = path.join(dataDir, "checkpoints", "indexes", `${first.rootHash}.lock`)
    await writeFile(lock, "stale\n")
    const old = new Date(Date.now() - 11 * 60 * 1000)
    await utimes(lock, old, old)

    await writeFile(path.join(root, "b.txt"), "beta\n")
    const second = await checkpoints.ensureCheckpointForPath({ rootPath: root, turnId: "turn-2", reason: "after stale lock" })
    expect(second).not.toBeNull()
    await expect(stat(lock)).rejects.toThrow()
  })

  test("fails closed when Git is unavailable", async () => {
    const { dataDir, root, db } = await setup()
    const missing = new CheckpointManager(
      db,
      new Logger({ level: "error" }),
      path.join(dataDir, "missing-git"),
      undefined,
      20,
      500 * 1024 * 1024,
      50_000,
      10 * 1024 * 1024,
      "agent1-git-does-not-exist",
    )
    await missing.initialize()
    await writeFile(path.join(root, "a.txt"), "alpha\n")
    await expect(
      missing.ensureCheckpointForPath({ rootPath: root, turnId: "turn-1", reason: "no git" }),
    ).rejects.toThrow("Git for Windows")
  })

  test("does not follow a junction outside the root", async () => {
    const { root, checkpoints } = await setup()
    const outside = await mkdtemp(path.join(os.tmpdir(), "agent-1-checkpoints-outside-"))
    try {
      await writeFile(path.join(outside, "outside.txt"), "outside\n")
      await writeFile(path.join(root, "inside.txt"), "inside\n")
      const junction = path.join(root, "linked-outside")
      const created = spawnSync("cmd", ["/c", "mklink", "/J", junction, outside], {
        windowsHide: true,
        encoding: "utf8",
      })
      expect(created.status).toBe(0)
      const cp = await checkpoint(checkpoints, root, "turn-1")
      const tree = spawnSync(
        "git",
        ["--git-dir", path.join(checkpoints.storePath), "ls-tree", "-r", "--name-only", cp.commit],
        { windowsHide: true, encoding: "utf8" },
      )
      expect(tree.status).toBe(0)
      expect(tree.stdout).toContain("inside.txt")
      expect(tree.stdout).not.toContain("outside.txt")
    } finally {
      await rm(outside, { recursive: true, force: true, maxRetries: 5 })
    }
  })

  test("restores a long Windows path", async () => {
    const { root, checkpoints } = await setup()
    let directory = root
    for (let index = 0; index < 9; index++) directory = path.join(directory, `segment-${index}-${"x".repeat(20)}`)
    await mkdir(directory, { recursive: true })
    const target = path.join(directory, "long.txt")
    await writeFile(target, "long original\n")
    const cp = await checkpoint(checkpoints, root, "turn-1")
    await writeFile(target, "long changed\n")
    await checkpoints.recordAgentWrite(root, target)
    const result = await checkpoints.restore(cp.id, { safe: true })
    expect(result.restoredFiles.some((file) => file.endsWith("long.txt"))).toBe(true)
    expect(await readFile(target, "utf8")).toBe("long original\n")
  })

  test("skips no-change snapshots and keeps the checkpoint root metadata", async () => {
    const { root, checkpoints } = await setup()
    await writeFile(path.join(root, "a.txt"), "alpha\n")
    const cp = await checkpoint(checkpoints, root, "turn-1")
    expect(cp.rootPath).toBe(root)
    expect(cp.rootHash).toHaveLength(16)
    expect(cp.commit).toHaveLength(40)
    expect((await readdir(path.join(root))).sort()).toEqual(["a.txt"])
  })

  test("prunes database rows, refs, and unreachable objects", async () => {
    const { dataDir, root, checkpoints, db } = await setup()
    await db.setSetting("checkpoints.max_per_root", "100")
    for (let index = 0; index < 4; index++) {
      await writeFile(path.join(root, `f${index}.txt`), `${index}\n`)
      await checkpoint(checkpoints, root, `turn-${index}`)
    }
    const all = await checkpoints.list(20)
    expect(all).toHaveLength(4)
    await db.setSetting("checkpoints.max_per_root", "2")
    await checkpoints.pruneNow(all[0]!.rootHash)
    const kept = await checkpoints.list(20)
    expect(kept).toHaveLength(2)
    const refs = spawnSync(
      "git",
      ["--git-dir", path.join(dataDir, "checkpoints", "store"), "for-each-ref", "--format=%(refname)", "refs/agent1"],
      { windowsHide: true, encoding: "utf8" },
    )
    expect(refs.status).toBe(0)
    expect(refs.stdout.trim().split(/\r?\n/).filter(Boolean)).toHaveLength(1)
  })

  test("recovers after a restore is interrupted following the pre-rollback snapshot", async () => {
    const { root, checkpoints } = await setup()
    const target = path.join(root, "restore-fault.txt")
    await writeFile(target, "original\n")
    const cp = await checkpoint(checkpoints, root, "turn-restore-fault")
    await writeFile(target, "changed\n")
    await checkpoints.recordAgentWrite(root, target)
    process.env.AGENT1_CHECKPOINT_FAULT = "after-pre-rollback"
    await expect(checkpoints.restore(cp.id, { safe: true })).rejects.toThrow("Injected checkpoint fault")
    delete process.env.AGENT1_CHECKPOINT_FAULT
    const result = await checkpoints.restore(cp.id, { safe: true })
    expect(result.restoredFiles).toContain("restore-fault.txt")
    expect(await readFile(target, "utf8")).toBe("original\n")
  })

  test("fails closed when the checkpoint store cannot be initialized", async () => {
    const { dataDir, root, db } = await setup()
    const blocked = path.join(dataDir, "blocked-checkpoints")
    await writeFile(blocked, "not a directory\n")
    const manager = new CheckpointManager(db, new Logger({ level: "error" }), blocked)
    await expect(manager.initialize()).rejects.toThrow()
    await expect(
      manager.ensureCheckpointForPath({ rootPath: root, turnId: "turn-blocked", reason: "blocked" }),
    ).rejects.toThrow()
  })

  test("keeps the default 50,000-file guard configurable", async () => {
    const { checkpoints } = await setup()
    expect((await checkpoints.policy()).maxFiles).toBe(50_000)
  })

  test("exposes a fault hook at every checkpoint creation boundary", async () => {
    for (const point of [
      "before-stage",
      "after-stage",
      "after-tree",
      "after-commit",
      "after-ref",
      "after-db",
      "after-event",
      "before-prune",
    ]) {
      const { root, checkpoints } = await setup()
      await writeFile(path.join(root, "fault.txt"), `${point}\n`)
      process.env.AGENT1_CHECKPOINT_FAULT = point
      await expect(
        checkpoints.ensureCheckpointForPath({ rootPath: root, turnId: `turn-${point}`, reason: point }),
      ).rejects.toThrow("Injected checkpoint fault")
      delete process.env.AGENT1_CHECKPOINT_FAULT
    }
  }, 30_000)

  test("fails closed when a checkpoint transition is interrupted and recovers", async () => {
    const { root, checkpoints, db } = await setup()
    await writeFile(path.join(root, "a.txt"), "one\n")
    process.env.AGENT1_CHECKPOINT_FAULT = "after-ref"
    await expect(
      checkpoints.ensureCheckpointForPath({ rootPath: root, turnId: "turn-fault", reason: "fault" }),
    ).rejects.toThrow("Injected checkpoint fault")
    delete process.env.AGENT1_CHECKPOINT_FAULT
    expect(await checkpoints.list(20)).toHaveLength(0)
    await writeFile(path.join(root, "a.txt"), "two\n")
    const recovered = await checkpoint(checkpoints, root, "turn-recovered")
    expect(recovered).toBeTruthy()
    expect((await db.listCheckpoints(20)).length).toBe(1)
  })
})
