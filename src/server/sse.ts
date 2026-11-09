import type { EventRecord } from "../shared/types"
import type { EventService } from "../events/service"
import type { Logger } from "../core/log"

const HEARTBEAT_MS = 15_000

function parseAfter(request: Request): number {
  const header = request.headers.get("last-event-id")
  if (header) {
    const value = Number(header)
    if (Number.isInteger(value) && value >= 0) return value
  }
  const query = new URL(request.url).searchParams.get("after")
  if (query) {
    const value = Number(query)
    if (Number.isInteger(value) && value >= 0) return value
  }
  return 0
}

function formatEvent(event: EventRecord): string {
  return `id: ${event.seq}\ndata: ${JSON.stringify(event)}\n\n`
}

export function createEventStream(
  request: Request,
  events: EventService,
  logger: Logger,
): Response {
  const after = parseAfter(request)
  const encoder = new TextEncoder()
  let closed = false
  let lastSent = after
  let replaying = true
  const pending: EventRecord[] = []
  let unsubscribe: (() => void) | undefined
  let heartbeat: ReturnType<typeof setInterval> | undefined
  let controllerRef: ReadableStreamDefaultController<Uint8Array> | undefined

  const cleanup = () => {
    if (closed) return
    closed = true
    if (heartbeat) clearInterval(heartbeat)
    unsubscribe?.()
    try {
      controllerRef?.close()
    } catch {
      // The client may already be gone.
    }
  }

  const send = (controller: ReadableStreamDefaultController<Uint8Array>, event: EventRecord) => {
    if (closed || event.seq <= lastSent) return
    lastSent = event.seq
    controller.enqueue(encoder.encode(formatEvent(event)))
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller
      controller.enqueue(encoder.encode("retry: 1000\n\n"))

      unsubscribe = events.subscribe((event) => {
        if (closed) return
        if (replaying) {
          pending.push(event)
          return
        }
        try {
          send(controller, event)
        } catch {
          cleanup()
        }
      })

      void (async () => {
        try {
          let cursor = after
          while (!closed) {
            const batch = await events.after(cursor)
            if (batch.length === 0) break
            for (const event of batch) send(controller, event)
            cursor = batch[batch.length - 1]?.seq ?? cursor
            if (batch.length < 1000) break
          }
          replaying = false
          pending.sort((a, b) => a.seq - b.seq)
          for (const event of pending.splice(0)) send(controller, event)
        } catch (error) {
          logger.error("events.replay_failed", {
            error: error instanceof Error ? error.message : String(error),
          })
          cleanup()
        }
      })()

      heartbeat = setInterval(() => {
        if (closed) return
        try {
          controller.enqueue(encoder.encode(": heartbeat\n\n"))
        } catch {
          cleanup()
        }
      }, HEARTBEAT_MS)

      request.signal.addEventListener("abort", cleanup, { once: true })
    },
    cancel() {
      cleanup()
    },
  })

  return new Response(stream, {
    status: 200,
    headers: {
      "content-type": "text/event-stream; charset=utf-8",
      "cache-control": "no-cache, no-transform",
      connection: "keep-alive",
      "x-accel-buffering": "no",
    },
  })
}
