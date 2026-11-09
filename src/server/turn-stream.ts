import type { Database } from "../db/database"
import type { Logger } from "../core/log"
import type { TurnBus, TurnStreamEvent } from "../agent/turn-bus"
import type { TurnStatus } from "../shared/types"

const HEARTBEAT_MS = 15_000

function encode(event: TurnStreamEvent): Uint8Array {
  return new TextEncoder().encode(`data: ${JSON.stringify(event)}\n\n`)
}

export async function createTurnStream(
  request: Request,
  turnId: string,
  db: Database,
  bus: TurnBus,
  logger: Logger,
): Promise<Response> {
  const initial = await db.getTurn(turnId)
  if (!initial) {
    return new Response(JSON.stringify({ error: { code: "turn_not_found", message: "Turn not found" } }), {
      status: 404,
      headers: { "content-type": "application/json" },
    })
  }

  let closed = false
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
      // Client already gone.
    }
  }

  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      controllerRef = controller
      controller.enqueue(new TextEncoder().encode("retry: 1000\n\n"))

      const send = (event: TurnStreamEvent) => {
        if (closed) return
        try {
          controller.enqueue(encode(event))
          if (event.type === "done") {
            setTimeout(cleanup, 25)
          }
        } catch {
          cleanup()
        }
      }

      unsubscribe = bus.subscribe(turnId, send)
      send({ type: "status", status: initial.status as TurnStatus })
      if (initial.status === "completed" || initial.status === "failed" || initial.status === "cancelled") {
        send({ type: "done", status: initial.status as TurnStatus })
        return
      }

      void db
        .getTurn(turnId)
        .then((current) => {
          if (!current) return
          if (
            current.status === "completed" ||
            current.status === "failed" ||
            current.status === "cancelled"
          ) {
            send({ type: "done", status: current.status as TurnStatus })
          }
        })
        .catch((error) => {
          logger.error("turn.stream_status_failed", {
            turnId,
            error: error instanceof Error ? error.message : String(error),
          })
        })

      heartbeat = setInterval(() => {
        if (closed) return
        try {
          controller.enqueue(new TextEncoder().encode(": heartbeat\n\n"))
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
