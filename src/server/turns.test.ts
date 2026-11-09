import { afterEach, describe, expect, test } from "bun:test"
import { rmSync } from "node:fs"
import path from "node:path"
import { startTestDaemon, waitFor, type TestDaemon } from "../test/helpers"
import { startFakeOpenAI, type FakeOpenAI } from "../test/fake-openai"
import { removeState } from "../daemon/state"

const daemons: TestDaemon[] = []
const servers: FakeOpenAI[] = []

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.cleanup()
  for (const server of servers.splice(0)) server.close()
})

function basic(password: string): string {
  return `Basic ${Buffer.from(`agent-1:${password}`, "utf8").toString("base64")}`
}

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch (error) {
    return (error as NodeJS.ErrnoException).code === "EPERM"
  }
}

async function startDaemonWithModel(env?: Record<string, string>) {
  const fake = startFakeOpenAI()
  servers.push(fake)
  const daemon = await startTestDaemon({ env })
  daemons.push(daemon)
  const response = await fetch(`${daemon.state.url}/v1/model-profiles`, {
    method: "POST",
    headers: {
      authorization: basic(daemon.password),
      "content-type": "application/json",
    },
    body: JSON.stringify({
      name: "Test model",
      kind: "cloud",
      baseUrl: fake.url,
      modelId: "fake-model",
      apiKey: "sk-test-not-for-logs",
      contextWindow: 8192,
      maxOutputTokens: 256,
    }),
  })
  expect(response.status).toBe(201)
  const profile = (await response.json()) as { profile: { id: string } }
  const session = await daemon.client.createSession("Chat session")
  return { fake, daemon, profileId: profile.profile.id, sessionId: session.session.id as string }
}

async function startMessage(
  daemon: TestDaemon,
  sessionId: string,
  content: string,
  modelProfileId?: string,
) {
  const response = await fetch(`${daemon.state.url}/v1/sessions/${sessionId}/messages`, {
    method: "POST",
    headers: {
      authorization: basic(daemon.password),
      "content-type": "application/json",
    },
    body: JSON.stringify({ content, ...(modelProfileId ? { modelProfileId } : {}) }),
  })
  expect(response.status).toBe(202)
  return (await response.json()) as { turn: { id: string }; streamUrl: string }
}

async function waitTurn(daemon: TestDaemon, turnId: string) {
  return waitFor(async () => {
    const response = await fetch(`${daemon.state.url}/v1/turns/${turnId}`, {
      headers: { authorization: basic(daemon.password) },
    })
    if (!response.ok) return undefined
    const body = (await response.json()) as {
      turn: { status: string; error: string | null }
      messages: unknown[]
    }
    return body.turn.status === "completed" || body.turn.status === "failed" || body.turn.status === "cancelled"
      ? body
      : undefined
  }, 15_000)
}

async function readTurnStream(url: string, password: string, signal: AbortSignal) {
  const response = await fetch(url, {
    headers: { authorization: basic(password) },
    signal,
  })
  expect(response.status).toBe(200)
  if (!response.body) throw new Error("No stream body")
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ""
  const events: Array<Record<string, unknown>> = []
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let index = buffer.indexOf("\n\n")
      while (index >= 0) {
        const frame = buffer.slice(0, index)
        buffer = buffer.slice(index + 2)
        const data = frame
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("")
        if (data) {
          const event = JSON.parse(data) as Record<string, unknown>
          events.push(event)
          if (event.type === "done") return events
        }
        index = buffer.indexOf("\n\n")
      }
    }
    return events
  } finally {
    await reader.cancel().catch(() => {})
  }
}

describe("Phase 2 turn API", () => {
  test("streams a chat turn, persists history, and redacts model keys", async () => {
    const { daemon, sessionId } = await startDaemonWithModel()
    const started = await startMessage(daemon, sessionId, "slow friendly hello")
    const controller = new AbortController()
    const events = await readTurnStream(
      `${daemon.state.url}${started.streamUrl}`,
      daemon.password,
      controller.signal,
    )
    expect(events.some((event) => event.type === "delta")).toBe(true)
    const completed = await waitTurn(daemon, started.turn.id)
    expect(completed.turn.status).toBe("completed")
    expect(completed.messages.length).toBeGreaterThanOrEqual(2)
    expect(
      completed.messages.some(
        (message) => (message as { role?: string }).role === "assistant",
      ),
    ).toBe(true)

    const profiles = await fetch(`${daemon.state.url}/v1/model-profiles`, {
      headers: { authorization: basic(daemon.password) },
    })
    const profilesText = await profiles.text()
    expect(profilesText).not.toContain("sk-test-not-for-logs")
    expect(profiles.status).toBe(200)
  }, 30_000)

  test("runs a tool loop through the HTTP API", async () => {
    const { daemon, sessionId } = await startDaemonWithModel()
    const started = await startMessage(daemon, sessionId, "please echo")
    const completed = await waitTurn(daemon, started.turn.id)
    expect(completed.turn.status).toBe("completed")
    expect(
      completed.messages.some((message) => (message as { role?: string }).role === "tool"),
    ).toBe(true)
    const text = JSON.stringify(completed.messages)
    expect(text).toContain("Fake final answer")
  }, 30_000)

  test("cancel stops a slow turn", async () => {
    const { daemon, sessionId } = await startDaemonWithModel()
    const started = await startMessage(daemon, sessionId, "slow please")
    const cancelled = await fetch(`${daemon.state.url}/v1/turns/${started.turn.id}/cancel`, {
      method: "POST",
      headers: { authorization: basic(daemon.password) },
    })
    expect(cancelled.status).toBe(200)
    const body = await waitTurn(daemon, started.turn.id)
    expect(body.turn.status).toBe("cancelled")
  }, 30_000)

  test("budget cap fails a looping tool turn", async () => {
    const { daemon, sessionId } = await startDaemonWithModel({ AGENT1_TURN_MAX_STEPS: "2" })
    const started = await startMessage(daemon, sessionId, "loop forever")
    const body = await waitTurn(daemon, started.turn.id)
    expect(body.turn.status).toBe("failed")
    expect(body.turn.error).toContain("budget_exceeded")
  }, 30_000)

  test("resumes a turn after a forced daemon kill", async () => {
    const { fake, daemon, sessionId } = await startDaemonWithModel()
    const started = await startMessage(daemon, sessionId, "slow one two three four")
    await waitFor(() => (fake.requests.length > 0 ? true : undefined), 5_000)
    process.kill(daemon.state.pid)
    await waitFor(() => (isAlive(daemon.state.pid) ? undefined : true), 8_000)
    removeState(path.join(daemon.dir, "state", "service.json"))
    try {
      rmSync(path.join(daemon.dir, "state", "service.lock"), { force: true })
    } catch {
      // Best effort.
    }

    const restarted = await startTestDaemon({ dataDir: daemon.dir })
    daemons.push(restarted)
    const body = await waitFor(async () => {
      const response = await fetch(`${restarted.state.url}/v1/turns/${started.turn.id}`, {
        headers: { authorization: basic(restarted.password) },
      })
      if (!response.ok) return undefined
      const result = (await response.json()) as {
        turn: { status: string; error: string | null }
        messages: Array<{ role: string; text: string }>
      }
      return result.turn.status === "completed" || result.turn.status === "failed"
        ? result
        : undefined
    }, 20_000)
    expect(body.turn.status).toBe("completed")
    expect(body.messages.filter((message) => message.role === "user")).toHaveLength(1)
    expect(body.messages.some((message) => message.role === "assistant")).toBe(true)
  }, 45_000)
})
