import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { startTestDaemon, type TestDaemon } from "../test/helpers"

const daemons: TestDaemon[] = []
const dirs: string[] = []

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.cleanup()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true, maxRetries: 5 })
})

async function cli(args: string[]) {
  const child = Bun.spawn([process.execPath, "src/cli/main.ts", ...args], {
    cwd: path.resolve(import.meta.dir, "..", ".."),
    stdout: "pipe",
    stderr: "pipe",
    env: { ...process.env, AGENT1_LOG_LEVEL: "error" },
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { exitCode, stdout, stderr }
}

describe("CLI workspaces and tools", () => {
  test("adds, lists, and removes a workspace; lists tools and journal", async () => {
    const daemon = await startTestDaemon()
    daemons.push(daemon)
    const root = await mkdtemp(path.join(os.tmpdir(), "agent-1-cli-workspace-"))
    dirs.push(root)

    const added = await cli([
      "workspace",
      "add",
      root,
      "--label",
      "CLI fixture",
      "--access",
      "write",
      "--data-dir",
      daemon.dir,
      "--json",
    ])
    expect(added.exitCode).toBe(0)
    const workspace = JSON.parse(added.stdout) as { workspace: { id: string; path: string } }
    expect(workspace.workspace.path).toBe(root)

    const listed = await cli(["workspace", "list", "--data-dir", daemon.dir])
    expect(listed.exitCode).toBe(0)
    expect(listed.stdout).toContain("CLI fixture")

    const tools = await cli(["tools", "list", "--data-dir", daemon.dir])
    expect(tools.exitCode).toBe(0)
    expect(tools.stdout).toContain("fs_apply_moves")
    expect(tools.stdout).toContain("shell_exec")

    const journal = await cli(["journal", "list", "--data-dir", daemon.dir, "--json"])
    expect(journal.exitCode).toBe(0)
    expect(JSON.parse(journal.stdout).entries).toEqual([])

    const removed = await cli([
      "workspace",
      "remove",
      workspace.workspace.id,
      "--data-dir",
      daemon.dir,
    ])
    expect(removed.exitCode).toBe(0)
  }, 30_000)
})
