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

describe("CLI pairing", () => {
  test("prints a pairing link and a terminal QR code", async () => {
    const daemon = await startTestDaemon()
    daemons.push(daemon)

    const result = await cli(["pair", "--data-dir", daemon.dir])
    expect(result.exitCode).toBe(0)
    expect(result.stderr).toBe("")
    expect(result.stdout).toContain("Pairing link:")
    expect(result.stdout).toContain("Scan the QR code")
    expect(result.stdout).toMatch(/[\u2580\u2584\u2588]/)

    const link = /Pairing link: (\S+)/.exec(result.stdout)?.[1]
    expect(link).toBeDefined()
    expect(link!.startsWith(daemon.state.url)).toBe(true)
    expect(link!).toContain("/pair?token=")
  }, 30_000)
})
