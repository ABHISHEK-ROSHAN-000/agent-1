import { afterEach, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Logger } from "../core/log"
import { Database } from "../db/database"
import { PathPolicy } from "./path-policy"

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function setup() {
  const dataDir = await mkdtemp(path.join(os.tmpdir(), "agent-1-path-data-"))
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-1-path-root-"))
  const db = await Database.open({
    dbPath: path.join(dataDir, "agent-1.db"),
    backupDir: path.join(dataDir, "backups"),
  })
  const policy = new PathPolicy(db, new Logger({ level: "error" }), dataDir)
  cleanups.push(async () => {
    await db.close()
    await rm(dataDir, { recursive: true, force: true, maxRetries: 5 })
    await rm(root, { recursive: true, force: true, maxRetries: 5 })
  })
  return { dataDir, root, db, policy }
}

describe("PathPolicy", () => {
  test("protects the data directory and credential env files", async () => {
    const { dataDir, root, policy } = await setup()
    expect(policy.isProtected(dataDir)).toBe(true)
    expect(policy.isReadDenied(path.join(dataDir, "agent-1.db"))).toBe(true)
    expect(policy.isReadDenied(path.join(root, ".env"))).toBe(true)
    expect(policy.isReadDenied(path.join(root, ".env.local"))).toBe(true)
    await expect(policy.requireWritable(path.join(dataDir, "x.txt"))).rejects.toThrow("protected")
  })

  test("applies an optional write-safe root and flags instruction files", async () => {
    const { root, db, policy } = await setup()
    await writeFile(path.join(root, "AGENTS.md"), "rules\n")
    expect(policy.isProtectedInstruction(path.join(root, "AGENTS.md"))).toBe(true)
    expect(policy.isProtectedInstruction(path.join(root, "src", "index.ts"))).toBe(false)
    await expect(policy.requireWritable(path.join(root, "a.txt"))).resolves.toBe(path.join(root, "a.txt"))

    await db.setSetting("approval.write_safe_root", root)
    expect(await policy.writeSafeRoot()).toBe(path.resolve(root))
    await expect(policy.requireWritable(path.join(root, "a.txt"))).resolves.toBe(path.join(root, "a.txt"))
    await expect(policy.requireWritable(path.join(os.tmpdir(), "outside.txt"))).rejects.toThrow(
      "outside the write-safe root",
    )
  })

  test("resolves junctions before checking protected paths and safe roots", async () => {
    const { dataDir, root, db, policy } = await setup()
    const junction = path.join(root, "escape")
    const linked = spawnSync("cmd", ["/c", "mklink", "/J", junction, dataDir], {
      encoding: "utf8",
      windowsHide: true,
    })
    expect(linked.status).toBe(0)
    expect(policy.isProtected(junction)).toBe(true)
    await expect(policy.requireWritable(path.join(junction, "x.txt"))).rejects.toThrow("protected")

    const outside = await mkdtemp(path.join(os.tmpdir(), "agent-1-path-outside-"))
    cleanups.push(async () => rm(outside, { recursive: true, force: true, maxRetries: 5 }))
    const escape = path.join(root, "escape-outside")
    const linkedOutside = spawnSync("cmd", ["/c", "mklink", "/J", escape, outside], {
      encoding: "utf8",
      windowsHide: true,
    })
    expect(linkedOutside.status).toBe(0)
    await db.setSetting("approval.write_safe_root", root)
    await expect(policy.requireWritable(path.join(escape, "x.txt"))).rejects.toThrow(
      "outside the write-safe root",
    )
  })

  test("rejects Windows alternate data streams and trailing-name tricks", async () => {
    const { root, policy } = await setup()
    await expect(policy.requireWritable(path.join(root, "file.txt:payload"))).rejects.toThrow(
      "alternate data stream",
    )
    await expect(policy.requireWritable(path.join(root, "file.txt."))).rejects.toThrow(
      "Unsafe Windows path",
    )
    expect(policy.isReadDenied(path.join(root, "file.txt:payload"))).toBe(true)
  })

  test("finds a project root using marker files", async () => {
    const { root, policy } = await setup()
    const project = path.join(root, "project")
    const nested = path.join(project, "src", "feature")
    await mkdir(nested, { recursive: true })
    await writeFile(path.join(project, "package.json"), "{}\n")
    expect(policy.rootForPath(path.join(nested, "file.ts"))).toBe(path.resolve(project))
  })
})
