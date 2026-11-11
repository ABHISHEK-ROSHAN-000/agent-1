import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { Database } from "../db/database"
import { SessionSearchService } from "./session-search-service"

const cleanups: Array<() => Promise<void>> = []

afterEach(async () => {
  for (const cleanup of cleanups.splice(0).reverse()) await cleanup()
})

async function setup() {
  const dir = await mkdtemp(path.join(os.tmpdir(), "agent-1-search-"))
  const db = await Database.open({
    dbPath: path.join(dir, "agent-1.db"),
    backupDir: path.join(dir, "backups"),
  })
  cleanups.push(async () => {
    await db.close()
    await rm(dir, { recursive: true, force: true })
  })
  const search = new SessionSearchService(db)
  const sessionA = (await db.createSession("Orion release")).session
  const sessionB = (await db.createSession("Orion deploy")).session
  const userA = await db.createTurnWithUserMessage(
    sessionA.id,
    "test-provider",
    "test-model",
    "Release plan for Orion",
  )
  const assistantA = await db.saveTurnStep(userA.turn.id, {
    step: 1,
    sessionId: sessionA.id,
    messages: [{ role: "assistant", text: "The Orion release is Friday.", content: { role: "assistant", content: "The Orion release is Friday." } }],
    checkpoint: {},
    status: "completed",
  })
  const userB = await db.createTurnWithUserMessage(
    sessionB.id,
    "test-provider",
    "test-model",
    "Orion deploy notes",
  )
  const assistantB = await db.saveTurnStep(userB.turn.id, {
    step: 1,
    sessionId: sessionB.id,
    messages: [{ role: "assistant", text: "Deploy after the test suite passes.", content: { role: "assistant", content: "Deploy after the test suite passes." } }],
    checkpoint: {},
    status: "completed",
  })
  return {
    db,
    search,
    sessionA: sessionA.id,
    sessionB: sessionB.id,
    userA: userA.userMessage,
    assistantA: assistantA.find((message) => message.role === "assistant")!,
    userB: userB.userMessage,
    assistantB: assistantB.find((message) => message.role === "assistant")!,
  }
}

describe("SessionSearchService", () => {
  test("discovers matching messages and excludes the active session", async () => {
    const { search, sessionA } = await setup()
    const result = await search.search({ query: "Orion", currentSessionId: sessionA })
    expect(result.ok).toBe(true)
    expect(result.mode).toBe("discover")
    expect(result.results).toHaveLength(1)
    expect(result.results?.[0]?.sessionId).not.toBe(sessionA)
    expect(result.results?.[0]?.matches[0]?.text).toContain("Orion")

    const all = await search.search({ query: "Orion" })
    expect(all.results).toHaveLength(2)
  })

  test("reads a session and returns bounded message provenance", async () => {
    const { search, sessionA } = await setup()
    const result = await search.search({ sessionId: sessionA })
    expect(result.ok).toBe(true)
    expect(result.mode).toBe("read")
    expect(result.title).toBe("Orion release")
    expect(result.messages?.map((message) => message.role)).toContain("assistant")
    expect(result.messages?.[0]?.sessionId).toBe(sessionA)
  })

  test("scrolls around a message and reports the remaining window", async () => {
    const { search, sessionA, assistantA } = await setup()
    const result = await search.search({
      sessionId: sessionA,
      aroundMessageId: assistantA.id,
      window: 1,
    })
    expect(result.ok).toBe(true)
    expect(result.mode).toBe("scroll")
    expect(result.messages?.some((message) => message.id === assistantA.id)).toBe(true)
    expect(result.messagesBefore).toBeGreaterThanOrEqual(0)
    expect(result.messagesAfter).toBeGreaterThanOrEqual(0)
  })

  test("browses recent sessions and reports invalid FTS queries", async () => {
    const { search } = await setup()
    const browse = await search.search({})
    expect(browse.mode).toBe("browse")
    expect(browse.sessions?.length).toBeGreaterThanOrEqual(2)

    const invalid = await search.search({ query: '"' })
    expect(invalid.ok).toBe(false)
    expect(invalid.error).toBeTruthy()
  })

  test("filters roles by default and on request", async () => {
    const { db, search, sessionA } = await setup()
    const turn = await db.createTurnWithUserMessage(
      sessionA,
      "test-provider",
      "test-model",
      "alpha request",
    )
    await db.saveTurnStep(turn.turn.id, {
      step: 1,
      sessionId: sessionA,
      messages: [{ role: "tool", text: "toolonly match alpha", content: { role: "tool", content: "toolonly match alpha" } }],
      checkpoint: {},
      status: "completed",
    })

    const normal = await search.search({ query: "toolonly", currentSessionId: sessionA })
    expect(normal.results ?? []).toHaveLength(0)

    const withTools = await search.search({ query: "toolonly", currentSessionId: "other", roleFilter: "tool" })
    expect(withTools.results?.length).toBeGreaterThan(0)
  })
})

