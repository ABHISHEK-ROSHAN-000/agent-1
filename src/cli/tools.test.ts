import { afterEach, describe, expect, test } from "bun:test"
import path from "node:path"
import { startTestDaemon, type TestDaemon } from "../test/helpers"

const daemons: TestDaemon[] = []

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.cleanup()
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

describe("CLI tools and checkpoints", () => {
  test("lists tools and checkpoints without workspace commands", async () => {
    const daemon = await startTestDaemon()
    daemons.push(daemon)

    const tools = await cli(["tools", "list", "--data-dir", daemon.dir])
    expect(tools.exitCode).toBe(0)
    expect(tools.stdout).toContain("fs_apply_moves")
    expect(tools.stdout).toContain("shell_exec")

    const checkpoints = await cli(["checkpoints", "list", "--data-dir", daemon.dir, "--json"])
    expect(checkpoints.exitCode).toBe(0)
    expect(JSON.parse(checkpoints.stdout).checkpoints).toEqual([])

    const removed = await cli(["workspace", "list", "--data-dir", daemon.dir])
    expect(removed.exitCode).not.toBe(0)
  }, 30_000)
})
