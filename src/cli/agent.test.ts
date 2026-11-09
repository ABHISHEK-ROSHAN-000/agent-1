import { afterEach, describe, expect, test } from "bun:test"
import path from "node:path"
import { startFakeOpenAI, type FakeOpenAI } from "../test/fake-openai"
import { startTestDaemon, type TestDaemon } from "../test/helpers"

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

describe("CLI model and chat flow", () => {
  test("configures a model and streams a turn", async () => {
    const fake = startFakeOpenAI()
    servers.push(fake)
    const daemon = await startTestDaemon()
    daemons.push(daemon)
    const profile = await daemon.client.createModelProfile({
      name: "CLI model",
      kind: "cloud",
      baseUrl: fake.url,
      modelId: "fake-model",
      apiKey: "sk-cli-secret",
      contextWindow: 4096,
      maxOutputTokens: 128,
    })
    expect(profile.profile.id).toStartWith("mdl_")
    const session = await daemon.client.createSession("CLI chat test")

    const listed = await cli(["model", "list", "--data-dir", daemon.dir])
    expect(listed.exitCode).toBe(0)
    expect(listed.stdout).toContain("CLI model")

    const chat = await cli([
      "chat",
      "--session",
      String(session.session.id),
      "--message",
      "hello",
      "--data-dir",
      daemon.dir,
    ])
    expect(chat.exitCode).toBe(0)
    expect(chat.stdout).toContain("Fake response")
    expect(chat.stdout).toContain("turn completed")
    expect(chat.stdout).not.toContain("sk-cli-secret")
  }, 45_000)
})
