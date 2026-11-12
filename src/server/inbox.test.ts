import { afterEach, describe, expect, test } from "bun:test"
import { copyFile, mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { configureTestProvider, startTestDaemon, waitFor, type TestDaemon } from "../test/helpers"
import { startFakeOpenAI, type FakeOpenAI } from "../test/fake-openai"

const daemons: TestDaemon[] = []
const servers: FakeOpenAI[] = []
const dirs: string[] = []

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.cleanup()
  for (const server of servers.splice(0)) server.close()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true, maxRetries: 5 })
})

async function setup() {
  const fake = startFakeOpenAI()
  servers.push(fake)
  const daemon = await startTestDaemon()
  daemons.push(daemon)
  await configureTestProvider(daemon.client, fake.url, { name: "Inbox model" })
  const session = await daemon.client.createSession("Inbox session")
  return { fake, daemon, sessionId: session.session.id as string }
}

async function waitWaitingApproval(daemon: TestDaemon, turnId: string) {
  return waitFor(async () => {
    const turn = await daemon.client.getTurn(turnId)
    return turn.turn.status === "waiting_approval" ? turn : undefined
  }, 15_000)
}

async function waitCompleted(daemon: TestDaemon, turnId: string) {
  return waitFor(async () => {
    const turn = await daemon.client.getTurn(turnId)
    return turn.turn.status === "completed" ? turn : undefined
  }, 20_000)
}

describe("Phase 8E inbox and queue", () => {
  test("admits a queued prompt while an approval is pending and delivers it at idle", async () => {
    const { daemon, sessionId } = await setup()
    const started = await daemon.client.startMessage(sessionId, "please confirm")
    await waitWaitingApproval(daemon, started.turn.id)

    const admitted = await daemon.client.admitMessage(sessionId, "queued follow-up", {
      delivery: "queue",
    })
    expect(admitted.turn?.id).toBe(started.turn.id)
    expect(admitted.inbox.delivery).toBe("queue")
    expect((await daemon.client.listInbox(sessionId)).inbox).toHaveLength(1)

    const approval = (await daemon.client.listApprovals("pending")).approvals[0]!
    await daemon.client.decideApproval(approval.id, "approve")
    await waitCompleted(daemon, started.turn.id)

    expect((await daemon.client.listInbox(sessionId)).inbox).toHaveLength(0)
    const messages = (await daemon.client.listMessages(sessionId, 100)).messages
    expect(messages.some((message) => message.text === "queued follow-up")).toBe(true)
  }, 30_000)

  test("steers pending input at the approval boundary without creating a second turn", async () => {
    const { daemon, sessionId } = await setup()
    const started = await daemon.client.startMessage(sessionId, "please confirm")
    await waitWaitingApproval(daemon, started.turn.id)

    const admitted = await daemon.client.admitMessage(sessionId, "steered follow-up", {
      delivery: "steer",
    })
    expect(admitted.inbox.delivery).toBe("steer")
    const approval = (await daemon.client.listApprovals("pending")).approvals[0]!
    await daemon.client.decideApproval(approval.id, "approve")
    await waitCompleted(daemon, started.turn.id)

    expect((await daemon.client.listInbox(sessionId)).inbox).toHaveLength(0)
    const messages = (await daemon.client.listMessages(sessionId, 100)).messages
    expect(messages.some((message) => message.text === "steered follow-up")).toBe(true)
  }, 30_000)

  test("cancels only a pending queued prompt", async () => {
    const { daemon, sessionId } = await setup()
    const started = await daemon.client.startMessage(sessionId, "please confirm")
    await waitWaitingApproval(daemon, started.turn.id)
    const queued = await daemon.client.admitMessage(sessionId, "delete me", {
      delivery: "queue",
    })
    const kept = await daemon.client.admitMessage(sessionId, "keep me", {
      delivery: "queue",
    })
    await daemon.client.cancelInbox(sessionId, queued.inbox.id)
    const pending = (await daemon.client.listInbox(sessionId)).inbox
    expect(pending.map((item) => item.id)).toEqual([kept.inbox.id])

    const approval = (await daemon.client.listApprovals("pending")).approvals[0]!
    await daemon.client.decideApproval(approval.id, "approve")
    await waitCompleted(daemon, started.turn.id)
    const messages = (await daemon.client.listMessages(sessionId, 100)).messages
    expect(messages.some((message) => message.text === "delete me")).toBe(false)
    expect(messages.some((message) => message.text === "keep me")).toBe(true)
  }, 30_000)

  test("queues from two clients without interleaving execution", async () => {
    const { daemon, sessionId } = await setup()
    const started = await daemon.client.startMessage(sessionId, "please confirm")
    await waitWaitingApproval(daemon, started.turn.id)

    const [a, b] = await Promise.all([
      daemon.client.admitMessage(sessionId, "client A", { delivery: "queue" }),
      daemon.client.admitMessage(sessionId, "client B", { delivery: "steer" }),
    ])
    expect(a.turn?.id).toBe(started.turn.id)
    expect(b.turn?.id).toBe(started.turn.id)
    const pending = (await daemon.client.listInbox(sessionId)).inbox
    expect(pending).toHaveLength(2)

    const approval = (await daemon.client.listApprovals("pending")).approvals[0]!
    await daemon.client.decideApproval(approval.id, "approve")
    await waitCompleted(daemon, started.turn.id)
    const active = await daemon.client.activeSessions()
    expect(active.active[sessionId]).toBeUndefined()
    const messages = (await daemon.client.listMessages(sessionId, 100)).messages
    expect(messages.filter((message) => message.role === "user")).toHaveLength(3)
  }, 30_000)

  test("changing a parked queue item to steer starts the idle session", async () => {
    const { daemon, sessionId } = await setup()
    const queued = await daemon.client.admitMessage(sessionId, "steer me", {
      delivery: "queue",
    })
    expect(queued.turn).toBeNull()
    expect((await daemon.client.activeSessions()).active[sessionId]).toBeUndefined()

    const steered = await daemon.client.setInboxDelivery(sessionId, queued.inbox.id, "steer")
    expect(steered.turn).not.toBeNull()
    await waitCompleted(daemon, steered.turn!.id)
    expect((await daemon.client.listInbox(sessionId)).inbox).toHaveLength(0)
  }, 30_000)

  test("admits an image prompt and sends actual media to the provider", async () => {
    const fake = startFakeOpenAI()
    servers.push(fake)
    const daemon = await startTestDaemon()
    daemons.push(daemon)
    await configureTestProvider(daemon.client, fake.url, {
      name: "Vision model",
      inputModalities: ["text", "image"],
    })
    const session = await daemon.client.createSession("Vision session")
    const sessionId = session.session.id as string
    const bytes = await Bun.file(new URL("../../web/public/icon-192.png", import.meta.url)).arrayBuffer()
    const admitted = await daemon.client.admitMessage(sessionId, "What is in this image?", {
      delivery: "steer",
      files: [
        {
          uri: `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`,
          name: "icon.png",
          source: { type: "inline" },
        },
      ],
    })
    expect(admitted.turn).not.toBeNull()
    await waitCompleted(daemon, admitted.turn!.id)
    const request = fake.requests.at(-1)
    expect(JSON.stringify(request?.messages)).toContain("image_url")
    expect(JSON.stringify(request?.messages)).toContain("data:image/png;base64,")
    const messages = (await daemon.client.listMessages(sessionId, 100)).messages
    const files = (messages[0] as { files?: Array<{ uri: string }> }).files
    expect(files).toHaveLength(1)
    const media = await fetch(`${daemon.state.url}/v1/media/${files![0]!.uri.slice(6)}`, {
      headers: {
        authorization: `Basic ${Buffer.from(`agent-1:${daemon.password}`).toString("base64")}`,
      },
    })
    expect(media.status).toBe(200)
    expect(media.headers.get("content-type")).toBe("image/png")
    expect((await media.arrayBuffer()).byteLength).toBeGreaterThan(100)
    const missing = await fetch(`${daemon.state.url}/v1/media/${"0".repeat(64)}`, {
      headers: {
        authorization: `Basic ${Buffer.from(`agent-1:${daemon.password}`).toString("base64")}`,
      },
    })
    expect(missing.status).toBe(404)
  }, 30_000)

  test("does not send an image to a text-only model", async () => {
    const fake = startFakeOpenAI()
    servers.push(fake)
    const daemon = await startTestDaemon()
    daemons.push(daemon)
    await configureTestProvider(daemon.client, fake.url, {
      name: "Text model",
      inputModalities: ["text"],
    })
    const session = await daemon.client.createSession("Text-only vision")
    const sessionId = session.session.id as string
    const bytes = await Bun.file(new URL("../../web/public/icon-192.png", import.meta.url)).arrayBuffer()
    const admitted = await daemon.client.admitMessage(sessionId, "What is in this image?", {
      delivery: "steer",
      files: [
        {
          uri: `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`,
          name: "icon.png",
        },
      ],
    })
    await waitCompleted(daemon, admitted.turn!.id)
    const body = JSON.stringify(fake.requests.at(-1)?.messages)
    expect(body).toContain("does not support image")
    expect(body).not.toContain("image_url")
  }, 30_000)

  test("a tool call can read an image and deliver it to the model", async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), "agent-1-read-image-"))
    dirs.push(dir)
    const imagePath = path.join(dir, "screenshot.png")
    await copyFile(new URL("../../web/public/icon-192.png", import.meta.url), imagePath)
    const fake = startFakeOpenAI()
    servers.push(fake)
    const daemon = await startTestDaemon()
    daemons.push(daemon)
    await configureTestProvider(daemon.client, fake.url, {
      name: "Tool vision model",
      inputModalities: ["text", "image"],
    })
    const session = await daemon.client.createSession("Tool vision")
    const sessionId = session.session.id as string
    const admitted = await daemon.client.admitMessage(sessionId, `read image ${imagePath}`, {
      delivery: "steer",
    })
    await waitCompleted(daemon, admitted.turn!.id)
    const found = fake.requests.some((request) => {
      const body = JSON.stringify(request.messages)
      return body.includes("image_url") && body.includes("data:image/png;base64,")
    })
    expect(found).toBe(true)
  }, 30_000)

  test("keeps attachments on a queued prompt through promotion", async () => {
    const fake = startFakeOpenAI()
    servers.push(fake)
    const daemon = await startTestDaemon()
    daemons.push(daemon)
    await configureTestProvider(daemon.client, fake.url, {
      name: "Queued vision",
      inputModalities: ["text", "image"],
    })
    const session = await daemon.client.createSession("Queued vision")
    const sessionId = session.session.id as string
    const started = await daemon.client.startMessage(sessionId, "please confirm")
    await waitWaitingApproval(daemon, started.turn.id)
    const bytes = await Bun.file(new URL("../../web/public/icon-192.png", import.meta.url)).arrayBuffer()
    const admitted = await daemon.client.admitMessage(sessionId, "queued image", {
      delivery: "queue",
      files: [
        {
          uri: `data:image/png;base64,${Buffer.from(bytes).toString("base64")}`,
          name: "queued.png",
        },
      ],
    })
    expect(admitted.inbox.payload.files).toHaveLength(1)
    const approval = (await daemon.client.listApprovals("pending")).approvals[0]!
    await daemon.client.decideApproval(approval.id, "approve")
    await waitCompleted(daemon, started.turn.id)
    const messages = (await daemon.client.listMessages(sessionId, 100)).messages
    const queued = messages.find((message) => message.text === "queued image")
    expect((queued as { files?: unknown[] } | undefined)?.files).toHaveLength(1)
  }, 30_000)

  test("preserves queued prompts across a daemon restart", async () => {
    const { daemon, sessionId } = await setup()
    const queued = await daemon.client.admitMessage(sessionId, "survive restart", {
      delivery: "queue",
    })
    expect(queued.turn).toBeNull()
    await daemon.stop()

    const restarted = await startTestDaemon({ dataDir: daemon.dir })
    daemons.push(restarted)
    const pending = await restarted.client.listInbox(sessionId)
    expect(pending.inbox).toHaveLength(1)
    expect(pending.inbox[0]?.payload.text).toBe("survive restart")
  }, 30_000)
})
