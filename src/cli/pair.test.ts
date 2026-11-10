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
    stdin: "ignore",
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
  test("matches OpenCode local pairing: links, no loopback QR, SSH hint", async () => {
    const daemon = await startTestDaemon()
    daemons.push(daemon)

    const result = await cli(["pair", "--data-dir", daemon.dir])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("Open a link to connect. Links work once and expire in 5 minutes.")
    expect(result.stdout).toContain(`${daemon.state.url}/auth/connect/`)
    expect(result.stdout).not.toMatch(/[\u2580\u2584\u2588]/)
    expect(result.stderr).toContain("Over SSH? Forward the port")
    expect(result.stderr).toContain("agent-1 pair --remote")
  }, 30_000)

  test("uses an external --url and emits a QR for non-loopback addresses", async () => {
    const daemon = await startTestDaemon()
    daemons.push(daemon)

    const result = await cli(["pair", "--url", "https://agent1.example.test", "--data-dir", daemon.dir])
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("https://agent1.example.test/auth/connect/")
    expect(result.stdout).toMatch(/[\u2580\u2584\u2588]/)
    expect(result.stderr).toBe("")
  }, 30_000)

  test("rejects --remote with --url and invalid external URLs", async () => {
    const daemon = await startTestDaemon()
    daemons.push(daemon)

    const conflict = await cli(["pair", "--remote", "--url", "https://agent1.example.test", "--data-dir", daemon.dir])
    expect(conflict.exitCode).toBe(1)
    expect(conflict.stderr).toContain("--remote cannot be combined with --url")

    const invalid = await cli(["pair", "--url", "ftp://agent1.example.test", "--data-dir", daemon.dir])
    expect(invalid.exitCode).toBe(1)
    expect(invalid.stderr).toContain("Invalid pairing URL")
  }, 30_000)

  test("requires --yes or a terminal before enabling remote access", async () => {
    const daemon = await startTestDaemon()
    daemons.push(daemon)

    const result = await cli(["pair", "--remote", "--data-dir", daemon.dir])
    expect(result.exitCode).toBe(1)
    expect(result.stdout).toBe("")
    expect(result.stderr).toContain("This will expose your Agent-1 server to the internet.")
    expect(result.stderr).toContain("Run interactively or pass --yes to continue.")
  }, 30_000)

  test("reports remote status and can disable it", async () => {
    const daemon = await startTestDaemon()
    daemons.push(daemon)

    const status = await cli(["remote", "status", "--json", "--data-dir", daemon.dir])
    expect(status.exitCode).toBe(0)
    expect(JSON.parse(status.stdout).state).toBe("off")

    const off = await cli(["remote", "off", "--data-dir", daemon.dir])
    expect(off.exitCode).toBe(0)
    expect(off.stdout).toContain("Remote access disabled.")
  }, 30_000)

  test("documents --yes for remote pairing", async () => {
    const help = await cli(["pair", "--help"])
    expect(help.exitCode).toBe(0)
    expect(help.stdout).toContain("--remote")
    expect(help.stdout).toContain("--yes")
  })

  test("requires consent for remote on", async () => {
    const daemon = await startTestDaemon()
    daemons.push(daemon)

    const result = await cli(["remote", "on", "--data-dir", daemon.dir])
    expect(result.exitCode).toBe(1)
    expect(result.stderr).toContain("This will expose your Agent-1 server to the internet.")
    expect(result.stderr).toContain("Run interactively or pass --yes to continue.")
  }, 30_000)
})
