import type { Logger } from "../../core/log"
import type { Database, InboxAdmissionResult, InboxMutationResult, InboxStepResult } from "../../db/database"
import type { EventService } from "../../events/service"
import type { InboxDelivery, InboxItem } from "../../shared/types"
import { KeyedMutex } from "./mutex"

export type Promotable = "input" | "steer"

export type InboxDeliveryCallback = (
  items: readonly InboxItem[],
) => Promise<InboxStepResult>

/**
 * Durable, pending-only session input. The service mirrors OpenCode's inbox
 * semantics: one serialized mutation stream per session, ordered by enqueue
 * sequence, with steer-first promotion at step boundaries.
 */
export class SessionInboxService {
  private readonly mutex = new KeyedMutex()

  constructor(
    private readonly db: Database,
    private readonly events: EventService,
    private readonly logger: Logger,
  ) {}

  serialized<T>(sessionId: string, operation: () => Promise<T>): Promise<T> {
    return this.mutex.run(sessionId, operation)
  }

  async admit(input: {
    id: string
    sessionId: string
    text: string
    delivery: InboxDelivery
    metadata?: Readonly<Record<string, unknown>>
  }): Promise<InboxAdmissionResult> {
    return this.serialized(input.sessionId, () => this.admitWithinLock(input))
  }

  async admitWithinLock(input: {
    id: string
    sessionId: string
    text: string
    delivery: InboxDelivery
    metadata?: Readonly<Record<string, unknown>>
  }): Promise<InboxAdmissionResult> {
    const result = await this.db.admitInbox(input)
    this.publish(result.event)
    return result
  }

  list(sessionId: string): Promise<InboxItem[]> {
    return this.db.listInbox(sessionId)
  }

  find(sessionId: string, id: string): Promise<InboxItem | null> {
    return this.db.findInbox(sessionId, id)
  }

  async cancel(sessionId: string, id: string): Promise<InboxMutationResult> {
    return this.serialized(sessionId, async () => {
      const result = await this.db.cancelInbox(sessionId, id)
      this.publish(result.event)
      return result
    })
  }

  async setDelivery(
    sessionId: string,
    id: string,
    delivery: InboxDelivery,
  ): Promise<InboxMutationResult> {
    return this.serialized(sessionId, () => this.setDeliveryWithinLock(sessionId, id, delivery))
  }

  async setDeliveryWithinLock(
    sessionId: string,
    id: string,
    delivery: InboxDelivery,
  ): Promise<InboxMutationResult> {
    const result = await this.db.setInboxDelivery(sessionId, id, delivery)
    this.publish(result.event)
    return result
  }

  /**
   * Promotes the next eligible pending input. Mid-step boundaries consume
   * steers only; idle boundaries consume one queued prompt when no steer is
   * waiting. The callback delivers and persists the selected items atomically.
   */
  async promote(
    sessionId: string,
    scope: Promotable,
    deliver: InboxDeliveryCallback,
  ): Promise<InboxStepResult | null> {
    return this.serialized(sessionId, async () => {
      const pending = await this.db.listInbox(sessionId)
      const selected = selectPromotable(pending, scope)
      if (selected.length === 0) return null
      return deliver(selected)
    })
  }

  async nextPromotable(sessionId: string, scope: Promotable): Promise<InboxItem | null> {
    const pending = await this.db.listInbox(sessionId)
    return selectPromotable(pending, scope)[0] ?? null
  }

  private publish(event: Parameters<EventService["publish"]>[0] | null): void {
    if (!event) return
    try {
      this.events.publish(event)
    } catch (error) {
      this.logger.warn("session.inbox.publish_failed", {
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }
}

export function selectPromotable(
  pending: readonly InboxItem[],
  scope: Promotable,
): InboxItem[] {
  const steers = pending.filter((item) => item.delivery === "steer")
  if (scope === "steer" || steers.length > 0) return steers
  const queued = pending.find((item) => item.delivery === "queue")
  return queued ? [queued] : []
}
