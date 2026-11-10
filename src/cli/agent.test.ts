import { afterEach, describe, expect, test } from "bun:test"
import path from "node:path"
import { startFakeOpenAI, type FakeOpenAI } from "../test/fake-openai"
import { configureTestProvider, startTestDaemon, type TestDaemon } from "../test/helpers"

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

describe("CLI provider, model, and run flow", () => {
  test("lists provider models and streams a run turn", async () => {
    const fake = startFakeOpenAI()
    servers.push(fake)
    const daemon = await startTestDaemon()
    daemons.push(daemon)
    await configureTestProvider(daemon.client, fake.url, {
      name: "CLI provider",
      apiKey: "sk-cli-secret",
      contextWindow: 4096,
      maxOutputTokens: 128,
    })
    const session = await daemon.client.createSession("CLI run test")

    const listed = await cli(["auth", "list", "--data-dir", daemon.dir])
    expect(listed.exitCode).toBe(0)
    expect(listed.stdout).toContain("CLI provider")

    const models = await cli(["models", "--data-dir", daemon.dir])
    expect(models.exitCode).toBe(0)
    expect(models.stdout).toContain("test-provider/fake-model")

    const run = await cli([
      "run",
      "hello",
      "--session",
      String(session.session.id),
      "--model",
      "test-provider/fake-model",
      "--data-dir",
      daemon.dir,
    ])
    expect(run.exitCode).toBe(0)
    expect(run.stdout).toContain("Fake response")
    expect(run.stdout).toContain("turn completed")
    expect(run.stdout).not.toContain("sk-cli-secret")
  }, 45_000)
})
