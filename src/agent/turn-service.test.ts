import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Logger } from "../core/log"
import { Database } from "../db/database"
import { EventService } from "../events/service"
import { ModelService } from "../models/model-service"
import { TurnBus } from "./turn-bus"
import { TurnService } from "./turn-service"
import { startFakeOpenAI, type FakeOpenAI } from "../test/fake-openai"
import { waitFor } from "../test/helpers"

const dirs: string[] = []
const servers: FakeOpenAI[] = []
const databases: Database[] = []

afterEach(async () => {
  for (const db of databases.splice(0)) await db.close()
  for (const server of servers.splice(0)) server.close()
  for (const dir of dirs.splice(0)) await rm(dir, { recursive: true, force: true, maxRetries: 5 })
})

async function setup() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-1-turn-"))
  dirs.push(dir)
  const db = await Database.open({
    dbPath: path.join(dir, "agent-1.db"),
    backupDir: path.join(dir, "backups"),
  })
  databases.push(db)
  const logger = new Logger({ level: "error" })
  const modelService = new ModelService(db, logger, path.join(dir, "secrets", "model-keys.dpapi.json"))
  const fake = startFakeOpenAI()
  servers.push(fake)
  const profile = await modelService.create({
    name: "fake",
    kind: "cloud",
    baseUrl: fake.url,
    modelId: "fake-model",
    apiKey: "test-key",
    contextWindow: 8_192,
    maxOutputTokens: 256,
  })
  const events = new EventService(db, logger)
  const bus = new TurnBus()
  const turns = new TurnService(db, events, modelService, bus, logger, {
    maxSteps: 4,
    maxWallMs: 10_000,
  })
  const session = await db.createSession("Test chat")
  return { dir, db, logger, modelService, fake, profile, events, bus, turns, session: session.session }
}

describe("Turn runtime", () => {
  test("completes a streaming chat turn and persists messages", async () => {
    const { db, modelService, profile, turns, session } = await setup()
    const tested = await modelService.test(profile.id)
    expect(tested.ok).toBe(true)
    expect(tested.supportsTools).toBe(true)

    const started = await turns.startTurn(session.id, "Hello there")
    expect(started.turn.status).toBe("queued")
    const completed = await waitFor(async () => {
      const turn = await db.getTurn(started.turn.id)
      return turn && (turn.status === "completed" || turn.status === "failed") ? turn : undefined
    }, 10_000)
    expect(completed.status).toBe("completed")
    expect(completed.error).toBeNull()
    const messages = await turns.listMessages(session.id)
    expect(messages.length).toBeGreaterThanOrEqual(2)
    expect(messages.some((message) => message.role === "assistant")).toBe(true)
    expect(messages[0]?.text).toBe("Hello there")
  })

  test("runs a read-only tool loop", async () => {
    const { db, profile, turns, session } = await setup()
    void profile
    const started = await turns.startTurn(session.id, "Please echo this")
    const completed = await waitFor(async () => {
      const turn = await db.getTurn(started.turn.id)
      return turn && (turn.status === "completed" || turn.status === "failed") ? turn : undefined
    }, 10_000)
    expect(completed.status).toBe("completed")
    const messages = await turns.listMessages(session.id)
    expect(messages.some((message) => message.role === "tool")).toBe(true)
    expect(messages.some((message) => message.text.includes("Fake final answer"))).toBe(true)
  })

  test("compacts a long session into a stored summary", async () => {
    const { db, profile, turns, session } = await setup()
    await db.updateModelProfile(profile.id, { contextWindow: 1_024 })
    const long = "Please remember this detailed preference and context. ".repeat(24)
    for (let index = 0; index < 5; index++) {
      const started = await turns.startTurn(session.id, `${long} ${index}`)
      const completed = await waitFor(async () => {
        const turn = await db.getTurn(started.turn.id)
        return turn && (turn.status === "completed" || turn.status === "failed") ? turn : undefined
      }, 10_000)
      expect(completed.status).toBe("completed")
    }
    const updated = await db.getSession(session.id)
    expect(updated?.summary).toBeTruthy()
    expect(updated?.summaryThroughSeq).toBeGreaterThan(0)
  }, 30_000)
})
