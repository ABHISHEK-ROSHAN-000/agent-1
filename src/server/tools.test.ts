import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, readdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { startFakeOpenAI, type FakeOpenAI } from "../test/fake-openai"
import { configureTestProvider, startTestDaemon, waitFor, type TestDaemon } from "../test/helpers"

const daemons: TestDaemon[] = []
const servers: FakeOpenAI[] = []
const dirs: string[] = []

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.cleanup()
  for (const server of servers.splice(0)) server.close()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true, maxRetries: 5 })
})

function basic(password: string): string {
  return `Basic ${Buffer.from(`agent-1:${password}`, "utf8").toString("base64")}`
}

async function setup() {
  const fake = startFakeOpenAI()
  servers.push(fake)
  const daemon = await startTestDaemon()
  daemons.push(daemon)
  await configureTestProvider(daemon.client, fake.url, { name: "Tools model", apiKey: "sk-tools-test" })
  const root = await mkdtemp(path.join(os.tmpdir(), "agent-1-folderops-"))
  dirs.push(root)
  await writeFile(path.join(root, "a.txt"), "A\n")
  await writeFile(path.join(root, "b.txt"), "B\n")
  const session = await daemon.client.createSession("Folder Ops reference")
  return { fake, daemon, root, sessionId: String(session.session.id) }
}

async function startMessage(daemon: TestDaemon, sessionId: string, content: string) {
  const response = await fetch(`${daemon.state.url}/v1/sessions/${sessionId}/messages`, {
    method: "POST",
    headers: {
      authorization: basic(daemon.password),
      "content-type": "application/json",
    },
    body: JSON.stringify({ content }),
  })
  expect(response.status).toBe(202)
  return (await response.json()) as { turn: { id: string } }
}

async function turnStatus(daemon: TestDaemon, turnId: string) {
  const response = await fetch(`${daemon.state.url}/v1/turns/${turnId}`, {
    headers: { authorization: basic(daemon.password) },
  })
  return (await response.json()) as {
    turn: { status: string; error: string | null }
    messages: Array<{ role: string; text: string }>
  }
}

describe("Folder Ops reference through generic tools", () => {
  test("applies a checkpoint-first batch without a per-write approval", async () => {
    const { daemon, root, sessionId } = await setup()
    const moves = [
      { from: "a.txt", to: "sorted/a.txt" },
      { from: "b.txt", to: "sorted/b.txt" },
    ]
    const started = await startMessage(
      daemon,
      sessionId,
      `apply moves: ${JSON.stringify({ root, moves })}`,
    )

    const completed = await waitFor(async () => {
      const status = await turnStatus(daemon, started.turn.id)
      return status.turn.status === "completed" ? status : undefined
    }, 15_000)
    expect(completed.turn.error).toBeNull()
    expect(await readFile(path.join(root, "sorted", "a.txt"), "utf8")).toBe("A\n")
    expect(await readFile(path.join(root, "sorted", "b.txt"), "utf8")).toBe("B\n")

    const checkpointResponse = await fetch(`${daemon.state.url}/v1/checkpoints`, {
      headers: { authorization: basic(daemon.password) },
    })
    const checkpoints = (await checkpointResponse.json()) as {
      checkpoints: Array<{ id: string; rootPath: string; reason: string; commit: string }>
    }
    const checkpoint = checkpoints.checkpoints.find(
      (entry) => entry.rootPath.toLowerCase() === path.resolve(root).toLowerCase(),
    )
    expect(checkpoint).toBeDefined()
    expect(checkpoint!.commit).toHaveLength(40)

    const diff = await fetch(`${daemon.state.url}/v1/checkpoints/${checkpoint!.id}/diff`, {
      headers: { authorization: basic(daemon.password) },
    })
    expect(diff.status).toBe(200)
    const diffBody = (await diff.json()) as { diff: { files: unknown[] } }
    expect(diffBody.diff.files.length).toBeGreaterThan(0)

    const restored = await fetch(`${daemon.state.url}/v1/checkpoints/${checkpoint!.id}/restore`, {
      method: "POST",
      headers: {
        authorization: basic(daemon.password),
        "content-type": "application/json",
      },
      body: JSON.stringify({ safe: true }),
    })
    expect(restored.status).toBe(200)
    expect(await readFile(path.join(root, "a.txt"), "utf8")).toBe("A\n")
    expect(await readFile(path.join(root, "b.txt"), "utf8")).toBe("B\n")
    expect(await readdir(path.join(root, "sorted")).catch(() => [])).toEqual([])

  }, 45_000)

  test("lists tools and does not expose workspace grants", async () => {
    const { daemon } = await setup()
    const tools = await fetch(`${daemon.state.url}/v1/tools`, {
      headers: { authorization: basic(daemon.password) },
    })
    expect(tools.status).toBe(200)
    const body = (await tools.json()) as { tools: Array<{ name: string; risk: string }> }
    expect(body.tools.some((tool) => tool.name === "fs_apply_moves")).toBe(true)
    expect(body.tools.some((tool) => tool.name === "fs_undo")).toBe(false)
    expect(body.tools.some((tool) => tool.name === "shell_exec")).toBe(true)
    expect(body.tools.some((tool) => tool.name === "web_fetch")).toBe(true)

    const workspaces = await fetch(`${daemon.state.url}/v1/workspaces`, {
      headers: { authorization: basic(daemon.password) },
    })
    expect(workspaces.status).toBe(404)
  })
})
