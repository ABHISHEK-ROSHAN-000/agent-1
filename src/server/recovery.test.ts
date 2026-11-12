import { afterEach, describe, expect, test } from "bun:test"
import { knownDurableEventSchema } from "../shared/contracts"
import { startFakeOpenAI, type FakeOpenAI } from "../test/fake-openai"
import { configureTestProvider, startTestDaemon, waitFor, type TestDaemon } from "../test/helpers"

const daemons: TestDaemon[] = []
const servers: FakeOpenAI[] = []

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.cleanup()
  for (const server of servers.splice(0)) server.close()
})

async function setup() {
  const fake = startFakeOpenAI()
  servers.push(fake)
  const daemon = await startTestDaemon()
  daemons.push(daemon)
  await configureTestProvider(daemon.client, fake.url, { name: "Recovery model" })
  const session = await daemon.client.createSession("Recovery session")
  return { fake, daemon, sessionId: String(session.session.id) }
}

async function readSse(
  response: Response,
  predicate: (events: Array<Record<string, unknown>>) => boolean,
  timeoutMs = 5_000,
): Promise<Array<Record<string, unknown>>> {
  if (!response.body) throw new Error("SSE response had no body")
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  const events: Array<Record<string, unknown>> = []
  let buffer = ""
  const deadline = Date.now() + timeoutMs
  try {
    while (Date.now() < deadline) {
      const { done, value } = await reader.read()
      if (done) break
      buffer += decoder.decode(value, { stream: true })
      let boundary = buffer.indexOf("\n\n")
      while (boundary >= 0) {
        const frame = buffer.slice(0, boundary)
        buffer = buffer.slice(boundary + 2)
        const data = frame
          .split(/\r?\n/)
          .filter((line) => line.startsWith("data:"))
          .map((line) => line.slice(5).trim())
          .join("")
        if (data) {
          events.push(JSON.parse(data) as Record<string, unknown>)
          if (predicate(events)) return events
        }
        boundary = buffer.indexOf("\n\n")
      }
    }
    return events
  } finally {
    await reader.cancel().catch(() => undefined)
  }
}

describe("Phase 8C recovery foundations", () => {
  test("hydrates active sessions and exposes the active turn in context", async () => {
    const { daemon, sessionId } = await setup()
    const started = await daemon.client.startMessage(sessionId, "please confirm")
    await waitFor(async () => {
      const turn = await daemon.client.getTurn(started.turn.id)
      return turn.turn.status === "waiting_approval" ? turn : undefined
    }, 15_000)

    const active = await daemon.client.activeSessions()
    expect(active.active[sessionId]?.turnId).toBe(started.turn.id)
    expect(active.active[sessionId]?.status).toBe("waiting_approval")

    const context = await daemon.client.sessionContext(sessionId)
    expect(context.activeTurn?.id).toBe(started.turn.id)
    expect(context.activeTurn?.status).toBe("waiting_approval")

    const admitted = await daemon.client.startMessage(sessionId, "second message")
    expect(admitted.turn.id).toBe(started.turn.id)
    const inbox = await daemon.client.listInbox(sessionId)
    expect(inbox.inbox).toHaveLength(1)
    expect(inbox.inbox[0]?.payload.text).toBe("second message")
  }, 30_000)

  test("broadcasts one approval decision to two connected clients", async () => {
    const { daemon, sessionId } = await setup()
    const started = await daemon.client.startMessage(sessionId, "please confirm")
    await waitFor(async () => {
      const turn = await daemon.client.getTurn(started.turn.id)
      return turn.turn.status === "waiting_approval" ? turn : undefined
    }, 15_000)
    const approval = (await daemon.client.listApprovals("pending")).approvals[0]!
    const first = await daemon.client.eventsResponse(0)
    const second = await daemon.client.eventsResponse(0)
    const decide = (async () => {
      await Bun.sleep(100)
      await daemon.client.decideApproval(approval.id, "approve")
    })()
    const [a, b] = await Promise.all([
      readSse(first, (events) => events.some((event) => event.type === "approval.decided")),
      readSse(second, (events) => events.some((event) => event.type === "approval.decided")),
      decide,
    ])
    expect(a.some((event) => event.type === "approval.decided")).toBe(true)
    expect(b.some((event) => event.type === "approval.decided")).toBe(true)
  }, 30_000)

  test("broadcasts a durable contract-valid approval decision", async () => {
    const { daemon, sessionId } = await setup()
    const started = await daemon.client.startMessage(sessionId, "please confirm")
    await waitFor(async () => {
      const turn = await daemon.client.getTurn(started.turn.id)
      return turn.turn.status === "waiting_approval" ? turn : undefined
    }, 15_000)
    const pending = await daemon.client.listApprovals("pending")
    const approval = pending.approvals[0]!
    await daemon.client.decideApproval(approval.id, "approve")
    const events = await readSse(
      await daemon.client.eventsResponse(0),
      (items) => items.some((item) => item.type === "approval.decided"),
    )
    const event = events.find((item) => item.type === "approval.decided")!
    expect(knownDurableEventSchema.safeParse(event).success).toBe(true)
  }, 30_000)

  test("persists unified settings and validates patches", async () => {
    const { daemon } = await setup()
    const initial = await daemon.client.settings()
    expect(initial.settings.approval.mode).toBe("smart")
    expect(initial.settings.checkpoints.retentionPolicy).toBe("keep-until-pruned")
    expect(initial.settings.tui.theme).toBe("system")

    const updated = await daemon.client.updateSettings({
      approval: { mode: "manual", timeoutSeconds: 60 },
      checkpoints: { maxPerRoot: 7 },
      models: {
        default: { providerId: "test-provider", modelId: "fake-model", reasoningEffort: null },
      },
      tui: { theme: "dark", showToolDetails: false },
    })
    expect(updated.settings.approval.mode).toBe("manual")
    expect(updated.settings.approval.timeoutSeconds).toBe(60)
    expect(updated.settings.checkpoints.maxPerRoot).toBe(7)
    expect(updated.settings.models.default?.modelId).toBe("fake-model")
    expect(updated.settings.tui.theme).toBe("dark")
    expect(updated.settings.tui.showToolDetails).toBe(false)

    const fetched = await daemon.client.settings()
    expect(fetched.settings.approval.mode).toBe("manual")
    expect(fetched.settings.checkpoints.maxPerRoot).toBe(7)
    await expect(
      daemon.client.updateSettings({ unknown: true } as never),
    ).rejects.toMatchObject({ status: 400 })
  }, 30_000)

  test("hydrates an active waiting turn after a daemon restart", async () => {
    const { daemon, sessionId } = await setup()
    const started = await daemon.client.startMessage(sessionId, "please confirm")
    await waitFor(async () => {
      const turn = await daemon.client.getTurn(started.turn.id)
      return turn.turn.status === "waiting_approval" ? turn : undefined
    }, 15_000)

    const index = daemons.indexOf(daemon)
    if (index >= 0) daemons.splice(index, 1)
    await daemon.stop()
    const restarted = await startTestDaemon({ dataDir: daemon.dir })
    daemons.push(restarted)
    const active = await waitFor(async () => {
      const result = await restarted.client.activeSessions()
      return result.active[sessionId] ? result : undefined
    }, 15_000)
    expect(active.active[sessionId]?.turnId).toBe(started.turn.id)
    const context = await restarted.client.sessionContext(sessionId)
    expect(context.activeTurn?.id).toBe(started.turn.id)
    const stream = await readSse(
      await restarted.client.turnStreamResponse(started.turn.id),
      (events) => events.some((event) => event.type === "status" && event.status === "waiting_approval"),
    )
    expect(stream.some((event) => event.type === "status" && event.status === "waiting_approval")).toBe(true)
    await restarted.client.deleteSession(sessionId)
  }, 45_000)

  test("persists settings across a daemon restart", async () => {
    const { daemon } = await setup()
    await daemon.client.updateSettings({
      approval: { mode: "manual", timeoutSeconds: 90 },
      checkpoints: { maxPerRoot: 9 },
      tui: { theme: "light" },
    })
    const index = daemons.indexOf(daemon)
    if (index >= 0) daemons.splice(index, 1)
    await daemon.stop()
    const restarted = await startTestDaemon({ dataDir: daemon.dir })
    daemons.push(restarted)
    const settings = await restarted.client.settings()
    expect(settings.settings.approval.mode).toBe("manual")
    expect(settings.settings.approval.timeoutSeconds).toBe(90)
    expect(settings.settings.checkpoints.maxPerRoot).toBe(9)
    expect(settings.settings.tui.theme).toBe("light")
  }, 30_000)

  test("renames and deletes a session, interrupting its active turn", async () => {
    const { daemon, sessionId } = await setup()
    const started = await daemon.client.startMessage(sessionId, "please confirm")
    await waitFor(async () => {
      const turn = await daemon.client.getTurn(started.turn.id)
      return turn.turn.status === "waiting_approval" ? turn : undefined
    }, 15_000)

    const renamed = await daemon.client.renameSession(sessionId, "Renamed session")
    expect(renamed.session.title).toBe("Renamed session")
    const renameEvents = await readSse(
      await daemon.client.eventsResponse(0),
      (events) => events.some((event) => event.type === "session.renamed"),
    )
    const renameEvent = renameEvents.find((event) => event.type === "session.renamed")!
    expect((renameEvent.payload as { title?: string }).title).toBe("Renamed session")
    expect(knownDurableEventSchema.safeParse(renameEvent).success).toBe(true)

    const deleted = await daemon.client.deleteSession(sessionId)
    expect(deleted.ok).toBe(true)
    const deleteEvents = await readSse(
      await daemon.client.eventsResponse(Number(renameEvent.seq)),
      (events) => events.some((event) => event.type === "session.deleted"),
    )
    const deleteEvent = deleteEvents.find((event) => event.type === "session.deleted")!
    expect((deleteEvent.payload as { sessionId?: string }).sessionId).toBe(sessionId)
    expect(knownDurableEventSchema.safeParse(deleteEvent).success).toBe(true)
    await expect(daemon.client.getSession(sessionId)).rejects.toMatchObject({ status: 404 })
    expect((await daemon.client.activeSessions()).active[sessionId]).toBeUndefined()
    expect((await daemon.client.listApprovals("pending")).approvals).toHaveLength(0)
  }, 30_000)
})
