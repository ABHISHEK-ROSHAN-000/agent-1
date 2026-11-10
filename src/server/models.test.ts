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

describe("provider and model catalog API", () => {
  test("connects a provider once, shares its key, and selects its models", async () => {
    const fake = startFakeOpenAI()
    servers.push(fake)
    const daemon = await startTestDaemon()
    daemons.push(daemon)
    const auth = { authorization: basic(daemon.password), "content-type": "application/json" }

    const createdResponse = await fetch(`${daemon.state.url}/v1/providers`, {
      method: "POST",
      headers: auth,
      body: JSON.stringify({
        id: "local-test",
        name: "Local test",
        kind: "local",
        baseUrl: fake.url,
        apiKey: "sk-model-secret",
        models: [
          {
            id: "fake-model",
            name: "Fake model",
            contextWindow: 4096,
            maxOutputTokens: 128,
            supportsTools: true,
          },
        ],
      }),
    })
    expect(createdResponse.status).toBe(201)
    const created = (await createdResponse.json()) as { provider: { id: string; connected: boolean } }
    expect(created.provider.id).toBe("local-test")
    expect(created.provider.connected).toBe(true)

    const listed = await fetch(`${daemon.state.url}/v1/providers`, {
      headers: { authorization: basic(daemon.password) },
    })
    expect(listed.status).toBe(200)
    const listedText = await listed.text()
    expect(listedText).not.toContain("sk-model-secret")
    expect(listedText).toContain("Local test")

    const models = await fetch(`${daemon.state.url}/v1/models`, {
      headers: { authorization: basic(daemon.password) },
    })
    expect(models.status).toBe(200)
    const modelList = (await models.json()) as { models: Array<{ providerId: string; modelId: string }> }
    expect(
      modelList.models.some((model) => model.providerId === "local-test" && model.modelId === "fake-model"),
    ).toBe(true)

    const tested = await fetch(`${daemon.state.url}/v1/models/local-test/fake-model/test`, {
      method: "POST",
      headers: auth,
      body: "{}",
    })
    expect(tested.status).toBe(200)
    const testResult = (await tested.json()) as { ok: boolean; supportsTools: boolean }
    expect(testResult.ok).toBe(true)
    expect(testResult.supportsTools).toBe(true)

    const updated = await fetch(`${daemon.state.url}/v1/models/local-test/fake-model`, {
      method: "PATCH",
      headers: auth,
      body: JSON.stringify({ favorite: true }),
    })
    expect(updated.status).toBe(200)
    expect(((await updated.json()) as { model: { favorite: boolean } }).model.favorite).toBe(true)

    const defaulted = await fetch(`${daemon.state.url}/v1/models/default`, {
      method: "PUT",
      headers: auth,
      body: JSON.stringify({ providerId: "local-test", modelId: "fake-model" }),
    })
    expect(defaulted.status).toBe(200)
    const defaultModel = await fetch(`${daemon.state.url}/v1/models/default`, {
      headers: { authorization: basic(daemon.password) },
    })
    expect(((await defaultModel.json()) as { model: { modelId: string } }).model.modelId).toBe("fake-model")

    const credentials = (await (
      await fetch(`${daemon.state.url}/v1/providers`, {
        headers: { authorization: basic(daemon.password) },
      })
    ).json()) as { providers: Array<{ id: string; credentials: Array<{ id: string }> }> }
    const credentialId = credentials.providers.find((provider) => provider.id === "local-test")?.credentials[0]?.id
    expect(credentialId).toBeString()
    const removed = await fetch(
      `${daemon.state.url}/v1/providers/local-test/credentials/${encodeURIComponent(credentialId!)}`,
      { method: "DELETE", headers: auth },
    )
    expect(removed.status).toBe(200)
    const empty = await fetch(`${daemon.state.url}/v1/models`, {
      headers: { authorization: basic(daemon.password) },
    })
    expect(((await empty.json()) as { models: unknown[] }).models).toHaveLength(0)
  }, 30_000)

  test("detects an OpenRouter environment key and exposes free tool models", async () => {
    const daemon = await startTestDaemon({ env: { OPENROUTER_API_KEY: "sk-or-env-test" } })
    daemons.push(daemon)
    const providers = await fetch(`${daemon.state.url}/v1/providers`, {
      headers: { authorization: basic(daemon.password) },
    })
    const providerBody = (await providers.json()) as {
      providers: Array<{ id: string; connected: boolean; source: string }>
    }
    const openrouter = providerBody.providers.find((provider) => provider.id === "openrouter")
    expect(openrouter?.connected).toBe(true)
    expect(openrouter?.source).toBe("environment")
    expect(JSON.stringify(providerBody)).not.toContain("sk-or-env-test")

    const models = await fetch(`${daemon.state.url}/v1/models`, {
      headers: { authorization: basic(daemon.password) },
    })
    const modelBody = (await models.json()) as { models: Array<{ providerId: string; modelId: string }> }
    const requested = [
      "thinkingmachines/inkling-2-small:free",
      "dots-studio/dots-3-note-preview:free",
      "nvidia/nemotron-3.5-super-vl:free",
    ]
    for (const modelId of requested) {
      const model = modelBody.models.find(
        (entry) => entry.providerId === "openrouter" && entry.modelId === modelId,
      ) as (typeof modelBody.models)[number] & { supportsTools?: boolean }
      expect(model).toBeDefined()
      expect(model.supportsTools).toBe(true)
    }
  }, 30_000)

  test("rejects an invalid provider URL", async () => {
    const daemon = await startTestDaemon()
    daemons.push(daemon)
    const response = await fetch(`${daemon.state.url}/v1/providers`, {
      method: "POST",
      headers: {
        authorization: basic(daemon.password),
        "content-type": "application/json",
      },
      body: JSON.stringify({
        name: "Bad",
        baseUrl: "not-a-url",
      }),
    })
    expect(response.status).toBe(400)
  })
})
