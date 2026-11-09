import { afterEach, describe, expect, test } from "bun:test"
import { startFakeOpenAI, type FakeOpenAI } from "../test/fake-openai"
import { startTestDaemon, type TestDaemon } from "../test/helpers"

const daemons: TestDaemon[] = []
const servers: FakeOpenAI[] = []

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.cleanup()
  for (const server of servers.splice(0)) server.close()
})

function basic(password: string): string {
  return `Basic ${Buffer.from(`agent-1:${password}`, "utf8").toString("base64")}`
}

describe("model profile API", () => {
  test("creates, tests, updates, defaults, and removes a profile without leaking its key", async () => {
    const fake = startFakeOpenAI()
    servers.push(fake)
    const daemon = await startTestDaemon()
    daemons.push(daemon)
    const auth = { authorization: basic(daemon.password), "content-type": "application/json" }

    const createdResponse = await fetch(`${daemon.state.url}/v1/model-profiles`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        name: "Local test",
        kind: "local",
        baseUrl: fake.url,
        modelId: "fake-model",
        contextWindow: 4096,
        maxOutputTokens: 128,
        apiKey: "sk-model-secret",
      }),
    })
    expect(createdResponse.status).toBe(201)
    const created = (await createdResponse.json()) as { profile: { id: string; hasApiKey: boolean } }
    expect(created.profile.id).toStartWith("mdl_")
    expect(created.profile.hasApiKey).toBe(true)

    const listed = await fetch(`${daemon.state.url}/v1/model-profiles`, {
      headers: { authorization: basic(daemon.password) },
    })
    expect(listed.status).toBe(200)
    const listedText = await listed.text()
    expect(listedText).not.toContain("sk-model-secret")
    expect(listedText).toContain("Local test")

    const tested = await fetch(`${daemon.state.url}/v1/model-profiles/${created.profile.id}/test`, {
      method: "POST",
      headers: auth,
      body: "{}",
    })
    expect(tested.status).toBe(200)
    const testResult = (await tested.json()) as { ok: boolean; supportsTools: boolean }
    expect(testResult.ok).toBe(true)
    expect(testResult.supportsTools).toBe(true)

    const updated = await fetch(`${daemon.state.url}/v1/model-profiles/${created.profile.id}`, {
      method: "PATCH",
      headers: auth,
      body: JSON.stringify({ name: "Renamed model", contextWindow: 2048 }),
    })
    expect(updated.status).toBe(200)
    expect(((await updated.json()) as { profile: { name: string } }).profile.name).toBe("Renamed model")

    const defaulted = await fetch(
      `${daemon.state.url}/v1/model-profiles/${created.profile.id}/default`,
      { method: "POST", headers: auth, body: "{}" },
    )
    expect(defaulted.status).toBe(200)

    const removed = await fetch(`${daemon.state.url}/v1/model-profiles/${created.profile.id}`, {
      method: "DELETE",
      headers: auth,
    })
    expect(removed.status).toBe(200)
    const empty = await fetch(`${daemon.state.url}/v1/model-profiles`, {
      headers: { authorization: basic(daemon.password) },
    })
    expect(((await empty.json()) as { profiles: unknown[] }).profiles).toHaveLength(0)
  }, 30_000)

  test("rejects an invalid model URL", async () => {
    const daemon = await startTestDaemon()
    daemons.push(daemon)
    const response = await fetch(`${daemon.state.url}/v1/model-profiles`, {
      method: "POST",
      headers: {
        authorization: basic(daemon.password),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "Bad",
        kind: "cloud",
        baseUrl: "not-a-url",
        modelId: "x",
      }),
    })
    expect(response.status).toBe(400)
  })
})
