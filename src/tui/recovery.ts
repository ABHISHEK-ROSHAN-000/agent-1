import { isDurableEventRecord } from "../shared/contracts"
import type { EventRecord } from "../shared/types"
import { SseParser } from "../client/event-stream"

export type ConnectionState = "connecting" | "connected" | "reconnecting"

export interface SyntheticServerConnected {
  readonly type: "server.connected"
  readonly url: string
  readonly at: string
}

export interface ConnectionManagerOptions {
  readonly endpoint: () => string | Promise<string>
  readonly refreshEndpoint?: () => Promise<string | null | undefined>
  readonly onEvent: (event: EventRecord) => void
  readonly onState?: (state: ConnectionState) => void
  readonly onSyntheticConnected?: (event: SyntheticServerConnected) => void
  readonly open?: (url: string, after: number, signal: AbortSignal) => Promise<Response>
  readonly after?: number
  readonly connectTimeoutMs?: number
  readonly reconnectDelayMs?: number
  readonly keepaliveMs?: number
  readonly idleTimeoutMs?: number
  readonly batchWindowMs?: number
}

export const CONNECTION_DEFAULTS = {
  connectTimeoutMs: 2_000,
  reconnectDelayMs: 1_000,
  keepaliveMs: 15_000,
  idleTimeoutMs: 45_000,
  batchWindowMs: 10,
} as const

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function parseDurableEvent(data: string): EventRecord | null {
  try {
    const parsed = JSON.parse(data) as unknown
    if (!isDurableEventRecord(parsed)) return null
    return parsed
  } catch {
    return null
  }
}

export class ConnectionManager {
  private stopped = true
  private state: ConnectionState = "connecting"
  private cursor: number
  private baseUrl: string | null = null
  private controller: AbortController | null = null
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null
  private idleTimer: ReturnType<typeof setTimeout> | null = null
  private batchTimer: ReturnType<typeof setTimeout> | null = null
  private queue: EventRecord[] = []
  private attempts = 0

  constructor(private readonly options: ConnectionManagerOptions) {
    this.cursor = options.after ?? 0
  }

  get currentState(): ConnectionState {
    return this.state
  }

  get lastSequence(): number {
    return this.cursor
  }

  start(): void {
    if (!this.stopped) return
    this.stopped = false
    this.attempts = 0
    this.options.onState?.(this.state)
    void this.loop()
  }

  stop(): void {
    this.stopped = true
    this.controller?.abort()
    this.controller = null
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer)
    if (this.idleTimer) clearTimeout(this.idleTimer)
    if (this.batchTimer) clearTimeout(this.batchTimer)
    this.reconnectTimer = null
    this.idleTimer = null
    this.batchTimer = null
  }

  private setState(next: ConnectionState): void {
    if (this.state === next) return
    this.state = next
    this.options.onState?.(next)
  }

  private async loop(): Promise<void> {
    while (!this.stopped) {
      if (this.attempts > 0) {
        await sleep(this.options.reconnectDelayMs ?? CONNECTION_DEFAULTS.reconnectDelayMs)
        if (this.stopped) return
        const refreshed = await this.options.refreshEndpoint?.().catch(() => undefined)
        if (refreshed) this.baseUrl = refreshed.replace(/\/+$/, "")
      }

      try {
        if (!this.baseUrl) this.baseUrl = (await this.options.endpoint()).replace(/\/+$/, "")
        this.setState(this.attempts === 0 ? "connecting" : "reconnecting")
        const controller = new AbortController()
        this.controller = controller
        const timeout = setTimeout(
          () => controller.abort(),
          this.options.connectTimeoutMs ?? CONNECTION_DEFAULTS.connectTimeoutMs,
        )
        let response: Response
        try {
          response = await this.open(this.baseUrl, controller.signal)
        } finally {
          clearTimeout(timeout)
        }
        if (!response.ok || !response.body) {
          throw new Error(`Event stream failed (${response.status})`)
        }

        this.setState("connected")
        this.options.onSyntheticConnected?.({
          type: "server.connected",
          url: this.baseUrl,
          at: new Date().toISOString(),
        })
        this.resetIdle(controller)
        await this.read(response.body, controller)
      } catch {
        // The reconnect loop intentionally treats transport errors as normal.
      } finally {
        this.controller = null
        if (this.idleTimer) clearTimeout(this.idleTimer)
        this.idleTimer = null
      }

      if (this.stopped) return
      this.attempts++
      this.setState("reconnecting")
    }
  }

  private open(url: string, signal: AbortSignal): Promise<Response> {
    if (this.options.open) return this.options.open(url, this.cursor, signal)
    const headers: Record<string, string> = { accept: "text/event-stream" }
    if (this.cursor > 0) headers["last-event-id"] = String(this.cursor)
    return fetch(`${url}/v1/events?after=${encodeURIComponent(String(this.cursor))}`, {
      headers,
      signal,
    })
  }

  private async read(body: ReadableStream<Uint8Array>, controller: AbortController): Promise<void> {
    const reader = body.getReader()
    const decoder = new TextDecoder()
    const parser = new SseParser()
    try {
      while (!this.stopped) {
        const { done, value } = await reader.read()
        if (done) return
        this.resetIdle(controller)
        const frames = parser.feed(decoder.decode(value, { stream: true }))
        for (const frame of frames) {
          const event = parseDurableEvent(frame.data)
          if (!event || event.seq <= this.cursor) continue
          this.cursor = event.seq
          this.enqueue(event)
        }
      }
    } finally {
      await reader.cancel().catch(() => undefined)
    }
  }

  private enqueue(event: EventRecord): void {
    this.queue.push(event)
    if (this.batchTimer) return
    this.batchTimer = setTimeout(() => {
      this.batchTimer = null
      const batch = this.queue.splice(0)
      for (const item of batch) this.options.onEvent(item)
    }, this.options.batchWindowMs ?? CONNECTION_DEFAULTS.batchWindowMs)
  }

  private resetIdle(controller: AbortController): void {
    if (this.idleTimer) clearTimeout(this.idleTimer)
    this.idleTimer = setTimeout(() => {
      controller.abort()
    }, this.options.idleTimeoutMs ?? CONNECTION_DEFAULTS.idleTimeoutMs)
  }
}
