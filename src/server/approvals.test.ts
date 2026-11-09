import { afterEach, describe, expect, test } from "bun:test"
import { rmSync } from "node:fs"
import path from "node:path"
import { startFakeOpenAI, type FakeOpenAI } from "../test/fake-openai"
import { startTestDaemon, waitFor, type TestDaemon } from "../test/helpers"
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

async function setup() {
  const fake = startFakeOpenAI()
  servers.push(fake)
  const daemon = await startTestDaemon()
  daemons.push(daemon)
  const profile = await daemon.client.createModelProfile({
    name: "Approval model",
    kind: "cloud",
    baseUrl: fake.url,
    modelId: "fake-model",
    apiKey: "sk-approval-test",
    contextWindow: 4096,
    maxOutputTokens: 128,
  })
  void profile
  const session = await daemon.client.createSession("Approval session")
  return { fake, daemon, sessionId: String(session.session.id) }
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

async function getTurn(daemon: TestDaemon, turnId: string) {
  const response = await fetch(`${daemon.state.url}/v1/turns/${turnId}`, {
    headers: { authorization: basic(daemon.password) },
  })
  return (await response.json()) as {
    turn: { id: string; status: string; error: string | null }
    messages: Array<{ role: string; text: string }>
  }
}

async function waitStatus(daemon: TestDaemon, turnId: string, status: string) {
  return waitFor(async () => {
    const result = await getTurn(daemon, turnId)
    return result.turn.status === status ? result : undefined
  }, 10_000)
}

describe("Phase 3 approvals", () => {
  test("pauses a write tool, enforces exact arguments, and resumes after approval", async () => {
    const { daemon, sessionId } = await setup()
    const started = await startMessage(daemon, sessionId, "please confirm")
    const waiting = await waitStatus(daemon, started.turn.id, "waiting_approval")
    expect(waiting.turn.status).toBe("waiting_approval")

    const approvalsResponse = await fetch(`${daemon.state.url}/v1/approvals?status=pending`, {
      headers: { authorization: basic(daemon.password) },
    })
    expect(approvalsResponse.status).toBe(200)
    const approvals = (await approvalsResponse.json()) as {
      approvals: Array<{
        id: string
        toolName: string
        arguments: unknown
        argumentsHash: string
        status: string
      }>
    }
    expect(approvals.approvals).toHaveLength(1)
    const approval = approvals.approvals[0]!
    expect(approval.toolName).toBe("test_confirm")
    expect(approval.status).toBe("pending")

    const changed = await fetch(`${daemon.state.url}/v1/approvals/${approval.id}/decision`, {
      method: "POST",
      headers: {
        authorization: basic(daemon.password),
        "content-type": "application/json",
      },
      body: JSON.stringify({ decision: "approve", arguments: { note: "changed" } }),
    })
    expect(changed.status).toBe(409)
    const stillPending = await fetch(`${daemon.state.url}/v1/approvals/${approval.id}`, {
      headers: { authorization: basic(daemon.password) },
    })
    expect(((await stillPending.json()) as { approval: { status: string } }).approval.status).toBe("pending")

    const approved = await fetch(`${daemon.state.url}/v1/approvals/${approval.id}/decision`, {
      method: "POST",
      headers: {
        authorization: basic(daemon.password),
        "content-type": "application/json",
      },
      body: JSON.stringify({ decision: "approve" }),
    })
    expect(approved.status).toBe(200)
    expect(((await approved.json()) as { approval: { status: string } }).approval.status).toBe("approved")

    const completed = await waitStatus(daemon, started.turn.id, "completed")
    expect(completed.messages.some((message) => message.role === "tool")).toBe(true)
    expect(completed.messages.some((message) => message.text.includes("Fake final answer"))).toBe(true)

    const audit = await fetch(`${daemon.state.url}/v1/audit`, {
      headers: { authorization: basic(daemon.password) },
    })
    const auditText = await audit.text()
    expect(auditText).toContain("approval.approved")
    expect(auditText).toContain("tool.executed")
  }, 30_000)

  test("rejecting an approval returns a denial tool result", async () => {
    const { daemon, sessionId } = await setup()
    const started = await startMessage(daemon, sessionId, "please confirm")
    await waitStatus(daemon, started.turn.id, "waiting_approval")
    const approvalsResponse = await fetch(`${daemon.state.url}/v1/approvals?status=pending`, {
      headers: { authorization: basic(daemon.password) },
    })
    const approval = ((await approvalsResponse.json()) as { approvals: Array<{ id: string }> })
      .approvals[0]!
    const rejected = await fetch(`${daemon.state.url}/v1/approvals/${approval.id}/decision`, {
      method: "POST",
      headers: {
        authorization: basic(daemon.password),
        "content-type": "application/json",
      },
      body: JSON.stringify({ decision: "reject", reason: "not now" }),
    })
    expect(rejected.status).toBe(200)
    const completed = await waitStatus(daemon, started.turn.id, "completed")
    expect(completed.messages.some((message) => message.role === "tool")).toBe(true)
    expect(JSON.stringify(completed.messages)).toContain("denied")
  }, 30_000)

  test("a deny rule prevents the tool without creating an approval", async () => {
    const { daemon, sessionId } = await setup()
    const rule = await fetch(`${daemon.state.url}/v1/rules`, {
      method: "POST",
      headers: {
        authorization: basic(daemon.password),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        action: "tool.test_echo",
        resource: "*",
        effect: "deny",
        position: 1,
        note: "deny echo",
      }),
    })
    expect(rule.status).toBe(201)
    const started = await startMessage(daemon, sessionId, "please echo")
    const completed = await waitStatus(daemon, started.turn.id, "completed")
    const pending = await fetch(`${daemon.state.url}/v1/approvals?status=pending`, {
      headers: { authorization: basic(daemon.password) },
    })
    expect(((await pending.json()) as { approvals: unknown[] }).approvals).toHaveLength(0)
    expect(JSON.stringify(completed.messages)).toContain("denied")
  }, 30_000)

  test("pending approvals survive a daemon restart and still resume", async () => {
    const { daemon, sessionId } = await setup()
    const started = await startMessage(daemon, sessionId, "please confirm")
    await waitStatus(daemon, started.turn.id, "waiting_approval")
    const approvalsResponse = await fetch(`${daemon.state.url}/v1/approvals?status=pending`, {
      headers: { authorization: basic(daemon.password) },
    })
    const approval = ((await approvalsResponse.json()) as { approvals: Array<{ id: string }> })
      .approvals[0]!
    const oldIndex = daemons.indexOf(daemon)
    if (oldIndex >= 0) daemons.splice(oldIndex, 1)
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
    const pending = await fetch(`${restarted.state.url}/v1/approvals?status=pending`, {
      headers: { authorization: basic(restarted.password) },
    })
    expect(((await pending.json()) as { approvals: unknown[] }).approvals).toHaveLength(1)
    const approved = await fetch(`${restarted.state.url}/v1/approvals/${approval.id}/decision`, {
      method: "POST",
      headers: {
        authorization: basic(restarted.password),
        "content-type": "application/json",
      },
      body: JSON.stringify({ decision: "approve" }),
    })
    expect(approved.status).toBe(200)
    const completed = await waitStatus(restarted, started.turn.id, "completed")
    expect(completed.messages.some((message) => message.role === "tool")).toBe(true)
  }, 45_000)

  test("rules can be listed, edited, and removed", async () => {
    const { daemon } = await setup()
    const list = await fetch(`${daemon.state.url}/v1/rules`, {
      headers: { authorization: basic(daemon.password) },
    })
    expect(list.status).toBe(200)
    const rules = (await list.json()) as { rules: Array<{ id: string }> }
    expect(rules.rules.length).toBeGreaterThan(4)

    const created = await fetch(`${daemon.state.url}/v1/rules`, {
      method: "POST",
      headers: {
        authorization: basic(daemon.password),
        "content-type": "application/json",
      },
      body: JSON.stringify({ action: "tool.future", resource: "*", effect: "ask" }),
    })
    const rule = ((await created.json()) as { rule: { id: string } }).rule
    const updated = await fetch(`${daemon.state.url}/v1/rules/${rule.id}`, {
      method: "PATCH",
      headers: {
        authorization: basic(daemon.password),
        "content-type": "application/json",
      },
      body: JSON.stringify({ effect: "deny" }),
    })
    expect(updated.status).toBe(200)
    expect(((await updated.json()) as { rule: { effect: string } }).rule.effect).toBe("deny")
    const removed = await fetch(`${daemon.state.url}/v1/rules/${rule.id}`, {
      method: "DELETE",
      headers: { authorization: basic(daemon.password) },
    })
    expect(removed.status).toBe(200)
  })
})
