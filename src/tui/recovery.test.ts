import { afterEach, describe, expect, test } from "bun:test"
import { CONNECTION_DEFAULTS, ConnectionManager, type ConnectionState } from "./recovery"

const servers: Array<ReturnType<typeof Bun.serve>> = []

afterEach(() => {
  for (const server of servers.splice(0)) server.stop(true)
})

function sseServer(
  handler: (after: number, request: Request) => Array<{ seq: number; type: string }> | null,
) {
  const requests: Array<{ after: number; lastEventId: string | null }> = []
  const server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    idleTimeout: 30,
    fetch(request) {
      const url = new URL(request.url)
      if (url.pathname !== "/v1/events") return new Response("not found", { status: 404 })
      const after = Number(url.searchParams.get("after") ?? "0")
      requests.push({ after, lastEventId: request.headers.get("last-event-id") })
      const events = handler(after, request)
      if (!events) return new Response("closed", { status: 503 })
      const encoder = new TextEncoder()
      return new Response(
        new ReadableStream<Uint8Array>({
          start(controller) {
            controller.enqueue(encoder.encode("retry: 1000\n\n"))
            for (const event of events) {
              controller.enqueue(
                encoder.encode(
                  `id: ${event.seq}\ndata: ${JSON.stringify({
                    seq: event.seq,
                    type: event.type,
                    sessionId: "ses_1",
                    payload: {},
                    createdAt: "2026-11-12T00:00:00.000Z",
                  })}\n\n`,
                ),
              )
            }
            controller.close()
          },
        }),
        { headers: { "content-type": "text/event-stream" } },
      )
    },
  })
  servers.push(server)
  return { url: `http://127.0.0.1:${server.port}`, requests }
}

function waitFor<T>(fn: () => T | undefined, timeoutMs = 3_000): Promise<T> {
  return new Promise((resolve, reject) => {
    const deadline = Date.now() + timeoutMs
    const tick = () => {
      const value = fn()
      if (value !== undefined) return resolve(value)
      if (Date.now() >= deadline) return reject(new Error("Timed out"))
      setTimeout(tick, 10)
    }
    tick()
  })
}

describe("ConnectionManager", () => {
  test("uses OpenCode recovery defaults", () => {
    expect(CONNECTION_DEFAULTS).toEqual({
      connectTimeoutMs: 2_000,
      reconnectDelayMs: 1_000,
      keepaliveMs: 15_000,
      idleTimeoutMs: 45_000,
      batchWindowMs: 10,
    })
  })

  test("reconnects, replays after the last sequence, and emits server.connected", async () => {
    const server = sseServer((after) => {
      if (after === 0) return [{ seq: 1, type: "session.created" }]
      if (after === 1) return [{ seq: 2, type: "turn.started" }]
      return []
    })
    const events: number[] = []
    const states: ConnectionState[] = []
    const synthetic: string[] = []
    const manager = new ConnectionManager({
      endpoint: () => server.url,
      refreshEndpoint: async () => server.url,
      onEvent: (event) => events.push(event.seq),
      onState: (state) => states.push(state),
      onSyntheticConnected: (event) => synthetic.push(event.type),
      reconnectDelayMs: 20,
      connectTimeoutMs: 500,
      batchWindowMs: 1,
    })
    manager.start()
    await waitFor(() => (events.length >= 2 ? true : undefined))
    manager.stop()
    expect(events).toEqual([1, 2])
    expect(server.requests.map((request) => request.after)).toEqual([0, 1])
    expect(server.requests[1]?.lastEventId).toBe("1")
    expect(synthetic.length).toBeGreaterThanOrEqual(1)
    expect(states).toContain("connected")
    expect(states).toContain("reconnecting")
  })

  test("survives a reconnect soak without losing or duplicating sequence numbers", async () => {
    const server = sseServer((after) => {
      const next = after + 1
      return next <= 50 ? [{ seq: next, type: "session.event" }] : []
    })
    const events: number[] = []
    const manager = new ConnectionManager({
      endpoint: () => server.url,
      refreshEndpoint: async () => server.url,
      onEvent: (event) => events.push(event.seq),
      onState: () => undefined,
      onSyntheticConnected: () => undefined,
      reconnectDelayMs: 5,
      connectTimeoutMs: 500,
      batchWindowMs: 1,
    })
    manager.start()
    await waitFor(() => (events.length >= 50 ? true : undefined), 10_000)
    manager.stop()
    expect(events).toEqual(Array.from({ length: 50 }, (_, index) => index + 1))
  }, 15_000)

  test("replaces the endpoint after a failed connection", async () => {
    const first = sseServer(() => null)
    const second = sseServer((after) => (after === 0 ? [{ seq: 7, type: "session.renamed" }] : []))
    let endpoint = first.url
    const events: number[] = []
    const manager = new ConnectionManager({
      endpoint: () => endpoint,
      refreshEndpoint: async () => {
        endpoint = second.url
        return second.url
      },
      onEvent: (event) => events.push(event.seq),
      reconnectDelayMs: 20,
      connectTimeoutMs: 200,
      batchWindowMs: 1,
    })
    manager.start()
    await waitFor(() => (events.includes(7) ? true : undefined))
    manager.stop()
    expect(events).toContain(7)
  })

  test("enforces the connect timeout and enters reconnecting", async () => {
    const states: ConnectionState[] = []
    const manager = new ConnectionManager({
      endpoint: () => "http://127.0.0.1:1",
      onEvent: () => undefined,
      onState: (state) => states.push(state),
      connectTimeoutMs: 25,
      reconnectDelayMs: 500,
      open: (_url, _after, signal) =>
        new Promise<Response>((_resolve, reject) => {
          signal.addEventListener("abort", () => reject(new Error("timeout")), { once: true })
        }),
    })
    manager.start()
    await waitFor(() => (states.includes("reconnecting") ? true : undefined), 1_000)
    manager.stop()
    expect(states).toContain("reconnecting")
  })
})
