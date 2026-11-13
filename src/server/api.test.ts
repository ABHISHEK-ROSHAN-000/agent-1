import { afterEach, describe, expect, test } from "bun:test"
import { request as httpRequest } from "node:http"
import { AgentOneClient } from "../client/client"
import { startTestDaemon, type TestDaemon } from "../test/helpers"

const daemons: TestDaemon[] = []

afterEach(async () => {
  for (const daemon of daemons.splice(0)) await daemon.cleanup()
})

async function daemon(options?: Parameters<typeof startTestDaemon>[0]): Promise<TestDaemon> {
  const instance = await startTestDaemon(options)
  daemons.push(instance)
  return instance
}

function basic(password: string): string {
  return `Basic ${Buffer.from(`agent-1:${password}`, "utf8").toString("base64")}`
}

function cookieFrom(response: Response): string {
  const header = response.headers.get("set-cookie") ?? ""
  const match = /agent1_session(?:_\d+)?=([^;]+)/.exec(header)
  if (!match?.[1]) throw new Error(`No session cookie in: ${header}`)
  return match[0].split(";")[0]!
}

async function freePort(): Promise<number> {
  const server = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: () => new Response("ok") })
  const port = server.port
  server.stop(true)
  if (port === undefined) throw new Error("Could not allocate a test port")
  return port
}

function rawGet(
  url: string,
  headers: Record<string, string>,
): Promise<{ status: number; body: string; headers: Record<string, string | undefined> }> {
  return new Promise((resolve, reject) => {
    const target = new URL(url)
    const request = httpRequest(
      {
        hostname: target.hostname,
        port: target.port,
        path: `${target.pathname}${target.search}`,
        method: "GET",
        headers,
      },
      (response) => {
        let body = ""
        response.setEncoding("utf8")
        response.on("data", (chunk: string) => (body += chunk))
        response.on("end", () =>
          resolve({
            status: response.statusCode ?? 0,
            body,
            headers: {
              "www-authenticate": response.headers["www-authenticate"],
            },
          }),
        )
      },
    )
    request.on("error", reject)
    request.end()
  })
}

function withHost(url: string, host: string): Promise<{ status: number; body: string }> {
  return rawGet(url, { host })
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
    throw new Error(`Timed out waiting for SSE events; got ${events.length}`)
  } finally {
    await reader.cancel().catch(() => {})
  }
}

describe("Phase 1 HTTP API", () => {
  test("health, auth, sessions, idempotency, and host allowlist", async () => {
    const instance = await daemon()
    const health = await fetch(`${instance.state.url}/v1/health`)
    expect(health.status).toBe(200)
    const healthBody = (await health.json()) as { status: string; version: string }
    expect(healthBody.status).toBe("ok")
    expect(healthBody.version).toBe("0.1.4")

    const unauthorized = await fetch(`${instance.state.url}/v1/info`)
    expect(unauthorized.status).toBe(401)

    const info = await fetch(`${instance.state.url}/v1/info`, {
      headers: { authorization: basic(instance.password) },
    })
    expect(info.status).toBe(200)
    expect(((await info.json()) as { capabilities: string[] }).capabilities).toContain("sessions")

    const badHost = await withHost(`${instance.state.url}/v1/health`, "evil.example")
    expect(badHost.status).toBe(403)

    const created = await instance.client.createSession("One")
    expect(created.session.title).toBe("One")
    const list = await instance.client.listSessions()
    expect(list.sessions).toHaveLength(1)

    const idempotencyHeaders = {
      authorization: basic(instance.password),
      "content-type": "application/json",
      "idempotency-key": "idem-test-1",
    }
    const first = await fetch(`${instance.state.url}/v1/sessions`, {
      method: "POST",
      headers: idempotencyHeaders,
      body: JSON.stringify({ title: "Idempotent" }),
    })
    expect(first.status).toBe(201)
    const firstBody = (await first.json()) as { session: { id: string } }
    const second = await fetch(`${instance.state.url}/v1/sessions`, {
      method: "POST",
      headers: idempotencyHeaders,
      body: JSON.stringify({ title: "Idempotent" }),
    })
    expect(second.status).toBe(201)
    const secondBody = (await second.json()) as { session: { id: string } }
    expect(secondBody.session.id).toBe(firstBody.session.id)

    const missing = await fetch(`${instance.state.url}/v1/nope`, {
      headers: { authorization: basic(instance.password) },
    })
    expect(missing.status).toBe(404)

    const spec = await fetch(`${instance.state.url}/v1/openapi.json`, {
      headers: { authorization: basic(instance.password) },
    })
    expect(spec.status).toBe(200)
    expect(((await spec.json()) as { openapi: string }).openapi).toBe("3.1.0")
  })

  test("browser fetches do not trigger the native Basic auth dialog", async () => {
    const instance = await daemon()
    const cli = await rawGet(`${instance.state.url}/v1/info`, {})
    expect(cli.status).toBe(401)
    expect(cli.headers["www-authenticate"]).toContain("Basic")

    const navigate = await rawGet(`${instance.state.url}/v1/info`, {
      "sec-fetch-mode": "navigate",
    })
    expect(navigate.status).toBe(401)
    expect(navigate.headers["www-authenticate"]).toContain("Basic")

    for (const mode of ["same-origin", "cors"]) {
      const browserFetch = await rawGet(`${instance.state.url}/v1/info`, {
        "sec-fetch-mode": mode,
      })
      expect(browserFetch.status).toBe(401)
      expect(browserFetch.headers["www-authenticate"]).toBeUndefined()
    }
  })

  test("configured hostnames are allowed", async () => {
    const instance = await daemon({ env: { AGENT1_ALLOWED_HOSTS: "agent-1.test" } })
    const allowed = await withHost(`${instance.state.url}/v1/health`, "agent-1.test")
    expect(allowed.status).toBe(200)
    const rejected = await withHost(`${instance.state.url}/v1/health`, "other.test")
    expect(rejected.status).toBe(403)
  })

  test("login cookie, origin checks, pairing, and rotation", async () => {
    const instance = await daemon()
    const loginUrl = `${instance.state.url}/v1/auth/login`

    const wrong = await fetch(loginUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "wrong" }),
    })
    expect(wrong.status).toBe(401)

    const login = await fetch(loginUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: instance.password }),
    })
    expect(login.status).toBe(200)
    expect(login.headers.get("set-cookie")).toContain("HttpOnly")
    const cookie = cookieFrom(login)

    const info = await fetch(`${instance.state.url}/v1/info`, { headers: { cookie } })
    expect(info.status).toBe(200)

    const mismatchedOrigin = await fetch(`${instance.state.url}/v1/info`, {
      headers: { cookie, origin: "http://127.0.0.1:1" },
    })
    expect(mismatchedOrigin.status).toBe(403)

    const forbiddenOrigin = await fetch(`${instance.state.url}/v1/sessions`, {
      method: "POST",
      headers: { cookie, "content-type": "application/json", origin: "https://evil.example" },
      body: JSON.stringify({ title: "No" }),
    })
    expect(forbiddenOrigin.status).toBe(403)

    const allowedOrigin = await fetch(`${instance.state.url}/v1/sessions`, {
      method: "POST",
      headers: {
        cookie,
        "content-type": "application/json",
        origin: instance.state.url,
      },
      body: JSON.stringify({ title: "Allowed" }),
    })
    expect(allowedOrigin.status).toBe(201)

    const pairing = await instance.client.pair()
    const pendingPairing = await instance.client.pair()
    expect(pairing.code).toBeString()
    expect(pairing.urls).toContain(instance.state.url)
    expect(pairing.expiresIn).toBeGreaterThan(0)
    expect((await instance.client.remote()).state).toBe("off")
    const paired = await fetch(pairing.url, { redirect: "manual" })
    expect(paired.status).toBe(303)
    expect(paired.headers.get("set-cookie")).toMatch(/agent1_session(_\d+)?=/)
    const reused = await fetch(pairing.url, { redirect: "manual" })
    expect(reused.status).toBe(400)

    const rotated = await instance.client.rotatePassword()
    expect(rotated.password).not.toBe(instance.password)
    const oldCookieInfo = await fetch(`${instance.state.url}/v1/info`, { headers: { cookie } })
    expect(oldCookieInfo.status).toBe(401)
    const stalePairing = await fetch(pendingPairing.url, { redirect: "manual" })
    expect(stalePairing.status).toBe(400)

    const logout = await fetch(`${instance.state.url}/v1/auth/logout`, {
      method: "POST",
      headers: {
        cookie: cookieFrom(
          await fetch(`${instance.state.url}/v1/auth/login`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify({ password: rotated.password }),
          }),
        ),
        origin: instance.state.url,
      },
    })
    expect(logout.status).toBe(200)

    const newClient = new AgentOneClient({
      baseUrl: instance.state.url,
      password: rotated.password,
    })
    expect((await newClient.info()).version).toBe("0.1.4")
    await newClient.stop()
  })

  test("paired sessions survive a restart while unused pairing links do not", async () => {
    const port = await freePort()
    const first = await startTestDaemon({ env: { AGENT1_PORT: String(port) } })
    let second: TestDaemon | undefined
    try {
      const login = await fetch(`${first.state.url}/v1/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: first.password }),
      })
      expect(login.status).toBe(200)
      const cookie = cookieFrom(login)
      expect(cookie).toContain(`agent1_session_${port}=`)

      const pairing = await first.client.pair()
      expect(pairing.url).toContain("/auth/connect/")
      await first.stop()

      second = await startTestDaemon({ dataDir: first.dir, env: { AGENT1_PORT: String(port) } })
      expect(second.state.port).toBe(port)

      const afterRestart = await fetch(`${second.state.url}/v1/info`, { headers: { cookie } })
      expect(afterRestart.status).toBe(200)

      const stalePairing = await fetch(pairing.url, { redirect: "manual" })
      expect(stalePairing.status).toBe(400)
    } finally {
      await second?.cleanup()
      await first.cleanup()
    }
  }, 30_000)

  test("SSE replays durable events and honors Last-Event-ID", async () => {
    const instance = await daemon()
    await instance.client.createSession("First")
    await instance.client.createSession("Second")

    const controller = new AbortController()
    const response = await fetch(`${instance.state.url}/v1/events?after=0`, {
      headers: { authorization: basic(instance.password) },
      signal: controller.signal,
    })
    expect(response.status).toBe(200)
    const events = await readSse(response, (entries) => entries.length >= 3)
    expect(events.some((event) => event.type === "service.started")).toBe(true)
    expect(events.filter((event) => event.type === "session.created")).toHaveLength(2)
    controller.abort()

    const latest = events[events.length - 1]?.seq as number
    const replayController = new AbortController()
    const replay = await fetch(`${instance.state.url}/v1/events`, {
      headers: {
        authorization: basic(instance.password),
        "last-event-id": String(latest - 1),
      },
      signal: replayController.signal,
    })
    const replayed = await readSse(replay, (entries) => entries.length >= 1)
    expect(replayed[0]?.seq).toBe(latest)
    replayController.abort()
  })

  test("login rate limiter blocks repeated failures", async () => {
    const instance = await daemon()
    const loginUrl = `${instance.state.url}/v1/auth/login`
    for (let index = 0; index < 5; index++) {
      const response = await fetch(loginUrl, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password: `wrong-${index}` }),
      })
      expect(response.status).toBe(401)
    }
    const blocked = await fetch(loginUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: "still-wrong" }),
    })
    expect(blocked.status).toBe(429)
  })

  test("secure cookie mode is honored", async () => {
    const instance = await daemon({ env: { AGENT1_SECURE_COOKIES: "1" } })
    const login = await fetch(`${instance.state.url}/v1/auth/login`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ password: instance.password }),
    })
    expect(login.status).toBe(200)
    expect(login.headers.get("set-cookie")).toContain("Secure")
  })
})
