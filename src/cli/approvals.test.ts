import { afterEach, describe, expect, test } from "bun:test"
import path from "node:path"
import { startFakeOpenAI, type FakeOpenAI } from "../test/fake-openai"
import { configureTestProvider, startTestDaemon, waitFor, type TestDaemon } from "../test/helpers"

const daemons: TestDaemon[] = []
const servers: FakeOpenAI[] = []

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.cleanup()
  for (const server of servers.splice(0)) server.close()
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

describe("CLI approvals and rules", () => {
  test("lists and approves a pending action, and shows the audit log", async () => {
    const fake = startFakeOpenAI()
    servers.push(fake)
    const daemon = await startTestDaemon()
    daemons.push(daemon)
    await configureTestProvider(daemon.client, fake.url, {
      name: "CLI approval model",
      apiKey: "sk-cli-approval",
    })
    const session = await daemon.client.createSession("CLI approval")
    const started = await daemon.client.startMessage(
      String(session.session.id),
      "please confirm",
    )
    await waitFor(async () => {
      const turn = await daemon.client.getTurn(started.turn.id)
      return turn.turn.status === "waiting_approval" ? turn : undefined
    }, 10_000)

    const listed = await cli(["approvals", "list", "--status", "pending", "--data-dir", daemon.dir, "--json"])
    expect(listed.exitCode).toBe(0)
    const parsed = JSON.parse(listed.stdout) as { approvals: Array<{ id: string }> }
    const approvalId = parsed.approvals[0]?.id
    expect(approvalId).toBeDefined()

    const approved = await cli(["approvals", "approve", approvalId!, "--data-dir", daemon.dir, "--json"])
    expect(approved.exitCode).toBe(0)
    expect(JSON.parse(approved.stdout).approval.status).toBe("approved")

    await waitFor(async () => {
      const turn = await daemon.client.getTurn(started.turn.id)
      return turn.turn.status === "completed" ? turn : undefined
    }, 10_000)

    const rules = await cli(["rules", "list", "--data-dir", daemon.dir])
    expect(rules.exitCode).toBe(0)
    expect(rules.stdout).toContain("tool.test_echo")

    const audit = await cli(["audit", "--data-dir", daemon.dir, "--limit", "20"])
    expect(audit.exitCode).toBe(0)
    expect(audit.stdout).toContain("approval.approved")
  }, 45_000)
})
