import type { Database } from "../db/database"
import type { Logger } from "../core/log"
import type { EventRecord } from "../shared/types"

type Listener = (event: EventRecord) => void

export class EventService {
  private readonly listeners = new Set<Listener>()

  constructor(
    private readonly db: Database,
    private readonly logger: Logger,
  ) {}

  async append(type: string, sessionId: string | null, payload: unknown): Promise<EventRecord> {
    const event = await this.db.appendEvent(type, sessionId, payload)
    this.publish(event)
    return event
  }

  publish(event: EventRecord): void {
    for (const listener of this.listeners) {
      try {
        listener(event)
      } catch (error) {
        this.logger.warn("events.listener_failed", {
          error: error instanceof Error ? error.message : String(error),
        })
      }
    }
  }

  subscribe(listener: Listener): () => void {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  async after(seq: number): Promise<EventRecord[]> {
    return this.db.eventsAfter(seq)
  }

  async latestSeq(): Promise<number> {
    return this.db.latestEventSeq()
  }
}
