import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Logger } from "../core/log"
import { Database } from "../db/database"
import { EventService } from "../events/service"
import { ModelService } from "../models/model-service"
import { ProviderService } from "../models/provider-service"
import { startFakeOpenAI, type FakeOpenAI } from "../test/fake-openai"
import { MemoryReviewService } from "./memory-review-service"
import { MemoryReviewWriter } from "./memory-review-writer"
import { MemoryService } from "./memory-service"

const cleanups: Array<() => Promise<void>> = []
const servers: FakeOpenAI[] = []

afterEach(async () => {
  for (const server of servers.splice(0)) server.close()
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function setup(interval = 2) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-1-review-"))
  const db = await Database.open({
    dbPath: path.join(dir, "agent-1.db"),
    backupDir: path.join(dir, "backups"),
  })
  const logger = new Logger({ level: "error" })
  const provider = new ProviderService(db, logger, path.join(dir, "secrets", "model-keys.dpapi.json"))
  await provider.initialize()
  const fake = startFakeOpenAI()
  servers.push(fake)
  await provider.createCustom({
    id: "review-provider",
    name: "review fake",
    baseUrl: fake.url,
    apiKey: "review-key",
    models: [
      {
        id: "review-model",
        name: "Review model",
        contextWindow: 8_192,
        maxOutputTokens: 256,
        supportsTools: true,
        reasoning: false,
        reasoningOptions: [],
      },
    ],
  })
  const models = new ModelService(provider)
  const events = new EventService(db, logger)
  const memory = new MemoryService(db)
  const review = new MemoryReviewService(db, events, models, memory, logger, { defaultInterval: interval })
  await review.initialize()
  const session = (await db.createSession("Review session")).session
  await db.setSessionModel(session.id, "review-provider", "review-model")
  cleanups.push(async () => {
    await db.close()
    await rm(dir, { recursive: true, force: true })
  })
  return { db, events, fake, memory, review, session }
}

async function addUserMessage(db: Database, sessionId: string, text: string) {
  const created = await db.createTurnWithUserMessage(sessionId, "review-provider", "review-model", text)
  await db.setTurnStatus(created.turn.id, "completed")
}

describe("MemoryReviewWriter", () => {
  test("applies additions directly and stages destructive changes", async () => {
    const { db, memory, session } = await setup()
    const writer = new MemoryReviewWriter(memory)
    await memory.mutate({
      store: "user",
      operations: [{ action: "add", content: "old fact" }],
    })

    const added = await writer.apply(
      { target: "user", operations: [{ action: "add", content: "new fact" }] },
      { sessionId: session.id },
    )
    expect(added.success).toBe(true)
    expect(added.applied).toBe(1)
    expect((await memory.load("user")).entries).toContain("new fact")

    const staged = await writer.apply(
      {
        target: "user",
        operations: [
          { action: "patch", oldText: "old fact", content: "new old fact" },
          { action: "remove", oldText: "new fact" },
        ],
      },
      { sessionId: session.id },
    )
    expect(staged.success).toBe(true)
    expect(staged.staged).toBe(2)
    expect((await memory.load("user")).entries).toEqual(["old fact", "new fact"])
    expect((await db.listMemoryPending("pending")).map((entry) => entry.origin)).toEqual([
      "background_review",
      "background_review",
    ])
  })
})

describe("MemoryReviewService", () => {
  test("waits for the configured turn interval, then applies a review addition", async () => {
    const { db, fake, memory, review, session } = await setup(2)
    await addUserMessage(db, session.id, "review save: user prefers focused tests")

    expect(await review.maybeReview(session.id)).toBeNull()

    await addUserMessage(db, session.id, "review save: user prefers focused tests")
    const run = await review.maybeReview(session.id)
    expect(run?.status).toBe("completed")
    expect((await memory.load("user")).entries).toContain("user prefers focused tests")
    expect((await db.listTurns(session.id, 10)).length).toBe(2)
    expect((await db.getSessionMessages(session.id)).every((message) => message.role === "user")).toBe(true)
    expect(fake.requests.at(-1)?.tools?.some((entry) => entry.function?.name === "memory")).toBe(true)

    const reviews = await db.listMemoryReviewRuns(session.id)
    expect(reviews[0]?.trigger).toBe("nudge")
    expect(reviews[0]?.status).toBe("completed")
  })

  test("stages a review removal and leaves memory unchanged", async () => {
    const { db, memory, review, session } = await setup(1)
    await memory.mutate({
      store: "user",
      operations: [{ action: "add", content: "old review fact" }],
    })
    await addUserMessage(db, session.id, "review remove: old review fact")

    const run = await review.maybeReview(session.id)
    expect(run?.status).toBe("completed")
    expect((await memory.load("user")).entries).toEqual(["old review fact"])
    const pending = await db.listMemoryPending("pending")
    expect(pending).toHaveLength(1)
    expect(pending[0]?.origin).toBe("background_review")

    const event = (await db.eventsAfter(0)).find((entry) => entry.type === "memory.review.completed")
    expect(event?.payload).toMatchObject({ staged: 1, applied: 0 })
  })

  test("does not review while a session turn is active", async () => {
    const { db, review, session } = await setup(1)
    await db.createTurnWithUserMessage(session.id, "review-provider", "review-model", "still active")
    expect(await review.maybeReview(session.id)).toBeNull()
    expect(await review.reviewNow(session.id)).toBeNull()
  })

  test("cancels an in-flight review", async () => {
    const { db, fake, memory, review, session } = await setup(1)
    await addUserMessage(db, session.id, "review save: cancelable fact")
    fake.delayNext(500)

    const pending = review.reviewNow(session.id, "manual")
    await Bun.sleep(50)
    review.cancel(session.id)
    const run = await pending

    expect(run?.status).toBe("cancelled")
    expect((await memory.load("user")).entries).not.toContain("cancelable fact")
  })

  test("marks interrupted reviews failed on startup", async () => {
    const { db, review, session } = await setup(1)
    const run = await db.createMemoryReviewRun({
      sessionId: session.id,
      trigger: "nudge",
      turnsSinceMemory: 1,
    })
    expect(run.status).toBe("running")
    await review.initialize()
    expect((await db.getMemoryReviewRun(run.id))?.status).toBe("failed")
  })

  test("respects the disabled setting and prevents duplicate due reviews", async () => {
    const { db, memory, review, session } = await setup(1)
    await db.setSetting("memory.review.enabled", "false")
    await addUserMessage(db, session.id, "review save: should not be saved")
    expect(await review.maybeReview(session.id)).toBeNull()
    expect((await memory.load("user")).entries).toEqual([])

    await db.setSetting("memory.review.enabled", "true")
    const first = await review.maybeReview(session.id)
    expect(first?.status).toBe("completed")
    expect(await review.maybeReview(session.id)).toBeNull()
  })
})
