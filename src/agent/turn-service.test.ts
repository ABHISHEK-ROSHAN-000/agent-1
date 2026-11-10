import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Logger } from "../core/log"
import { Database } from "../db/database"
import { EventService } from "../events/service"
import { ModelService } from "../models/model-service"
import { ProviderService } from "../models/provider-service"
import { PermissionService } from "../permissions/permission-service"
import { JournalService } from "../tools/journal-service"
import { ToolService } from "../tools/tool-service"
import { WorkspaceService } from "../tools/workspace-service"
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

async function setup(contextWindow = 8_192) {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-1-turn-"))
  dirs.push(dir)
  const db = await Database.open({
    dbPath: path.join(dir, "agent-1.db"),
    backupDir: path.join(dir, "backups"),
  })
  databases.push(db)
  const logger = new Logger({ level: "error" })
  const providerService = new ProviderService(db, logger, path.join(dir, "secrets", "model-keys.dpapi.json"))
  await providerService.initialize()
  const fake = startFakeOpenAI()
  servers.push(fake)
  await providerService.createCustom({
    id: "test-provider",
    name: "fake",
    baseUrl: fake.url,
    apiKey: "test-key",
    models: [
      {
        id: "fake-model",
        name: "Fake model",
        contextWindow,
        maxOutputTokens: 256,
        supportsTools: true,
      },
    ],
  })
  const modelService = new ModelService(providerService, logger)
  const events = new EventService(db, logger)
  const permissions = new PermissionService(db, logger)
  const workspace = new WorkspaceService(db, logger, dir)
  const journal = new JournalService(db, logger)
  const tools = new ToolService(workspace, journal, logger)
  const bus = new TurnBus()
  const turns = new TurnService(db, events, modelService, providerService, permissions, tools, bus, logger, {
    maxSteps: 4,
    maxWallMs: 10_000,
  })
  const session = await db.createSession("Test chat")
  return {
    dir,
    db,
    logger,
    modelService,
    providerService,
    fake,
    selection: { providerId: "test-provider", modelId: "fake-model" },
    events,
    bus,
    turns,
    session: session.session,
  }
}

describe("Turn runtime", () => {
  test("completes a streaming chat turn and persists messages", async () => {
    const { db, modelService, turns, session } = await setup()
    const tested = await modelService.test("test-provider", "fake-model")
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
    const { db, turns, session } = await setup()
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
    const { db, turns, session } = await setup(1_024)
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
