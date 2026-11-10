import type { Database } from "../db/database"
import { ENTRY_DELIMITER, MemoryStore, codePointLength } from "./memory-store"
import {
  MemoryError,
  type MemoryHistoryRecord,
  type MemoryMutation,
  type MemoryOperation,
  type MemoryPendingRecord,
  type MemoryPendingStatus,
  type MemorySnapshot,
  type MemoryStoreName,
} from "./types"

export interface MemoryServiceOptions {
  readonly userLimit?: number
  readonly memoryLimit?: number
}

export interface MutateMemoryInput {
  readonly store: MemoryStoreName
  readonly operations: readonly MemoryOperation[]
  readonly actor?: string
  readonly sessionId?: string | null
  readonly turnId?: string | null
  readonly note?: string | null
}

export interface StageMemoryInput {
  readonly store: MemoryStoreName
  readonly action: "add" | "patch" | "remove"
  readonly content?: string
  readonly oldText?: string
  readonly sessionId?: string | null
  readonly turnId?: string | null
  readonly origin: string
  readonly summary?: string
}

const DEFAULT_USER_LIMIT = 1_375
const DEFAULT_MEMORY_LIMIT = 2_200

function positiveLimit(value: number, label: string): number {
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${label} must be a positive integer`)
  return value
}

export class MemoryService {
  private readonly userLimit: number
  private readonly memoryLimit: number
  private tail: Promise<void> = Promise.resolve()

  constructor(
    private readonly db: Database,
    options: MemoryServiceOptions = {},
  ) {
    this.userLimit = positiveLimit(options.userLimit ?? DEFAULT_USER_LIMIT, "userLimit")
    this.memoryLimit = positiveLimit(options.memoryLimit ?? DEFAULT_MEMORY_LIMIT, "memoryLimit")
  }

  async load(store: MemoryStoreName): Promise<MemoryStore> {
    const rows = await this.db.listMemoryEntries(store)
    return new MemoryStore(store, this.limitFor(store), rows.map((row) => row.content))
  }

  async mutate(input: MutateMemoryInput): Promise<MemoryMutation> {
    return this.exclusive(async () => {
      const store = await this.load(input.store)
      const result = store.apply(input.operations)
      if (!result.changed) return this.toMutation(result, null)
      const history = await this.db.commitMemoryMutation({
        store: input.store,
        entries: result.entries,
        before: store.entries,
        after: result.entries,
        action: result.actions.length > 1 ? "batch" : (result.actions[0] ?? "batch"),
        actor: input.actor ?? "agent",
        note: input.note ?? null,
      })
      return this.toMutation(result, history)
    })
  }

  async stagePending(input: StageMemoryInput): Promise<MemoryPendingRecord> {
    return this.exclusive(async () => {
      const store = await this.load(input.store)
      let matchedEntry: string | null = null
      if (input.action === "add") {
        if (!(input.content ?? "").trim()) {
          throw new MemoryError("missing_content", "Content is required for the 'add' action.")
        }
        store.apply([{ action: "add", content: input.content }])
      } else {
        const match = store.resolveEntry(input.oldText ?? "")
        matchedEntry = match.entry
        store.apply([
          {
            action: input.action,
            ...(input.content === undefined ? {} : { content: input.content }),
            oldText: input.oldText,
          },
        ])
      }
      const summary = (
        input.summary ??
        (input.action === "add"
          ? `add to ${input.store}: ${input.content ?? ""}`
          : `${input.action} in ${input.store}: ${input.oldText ?? ""}`)
      ).slice(0, 200)
      return this.db.createMemoryPending({
        sessionId: input.sessionId ?? null,
        turnId: input.turnId ?? null,
        store: input.store,
        action: input.action,
        payload: {
          action: input.action,
          ...(input.content === undefined ? {} : { content: input.content }),
          ...(input.oldText === undefined ? {} : { oldText: input.oldText }),
        },
        summary,
        origin: input.origin,
        matchedEntry,
      })
    })
  }

  async approvePending(id: string, actor = "user", note: string | null = null): Promise<MemoryMutation> {
    return this.exclusive(async () => {
      const pending = await this.db.getMemoryPending(id)
      if (!pending) throw new MemoryError("not_available", `Pending memory change not found: ${id}`)
      if (pending.status !== "pending") {
        throw new MemoryError("already_decided", `Pending memory change is already ${pending.status}.`)
      }

      const store = await this.load(pending.store)
      const result =
        pending.action === "add"
          ? store.apply([{ action: "add", content: pending.payload.content }])
          : store.applyPinned(
              pending.action,
              pending.matchedEntry ?? "",
              pending.payload.content,
              pending.payload.oldText,
            )

      if (!result.changed) {
        await this.db.decideMemoryPending(id, "approved", actor, note)
        return this.toMutation(result, null)
      }

      const history = await this.db.commitMemoryMutation({
        store: pending.store,
        entries: result.entries,
        before: store.entries,
        after: result.entries,
        action: pending.action,
        actor,
        note,
        pendingId: pending.id,
        pendingDecision: "approved",
        pendingDecidedBy: actor,
      })
      return this.toMutation(result, history)
    })
  }

  async rejectPending(
    id: string,
    reason: string | null = null,
    actor = "user",
  ): Promise<MemoryPendingRecord> {
    return this.exclusive(async () => {
      const pending = await this.db.getMemoryPending(id)
      if (!pending) throw new MemoryError("not_available", `Pending memory change not found: ${id}`)
      if (pending.status !== "pending") {
        throw new MemoryError("already_decided", `Pending memory change is already ${pending.status}.`)
      }
      const updated = await this.db.decideMemoryPending(id, "rejected", actor, reason)
      if (!updated) throw new MemoryError("not_available", `Pending memory change not found: ${id}`)
      return updated
    })
  }

  async listPending(status?: MemoryPendingStatus, limit = 100): Promise<MemoryPendingRecord[]> {
    return this.db.listMemoryPending(status, limit)
  }

  async listHistory(limit = 100): Promise<MemoryHistoryRecord[]> {
    return this.db.listMemoryHistory(limit)
  }

  async undo(historyId?: string, actor = "user"): Promise<MemoryMutation> {
    return this.exclusive(async () => {
      const history = historyId
        ? await this.db.getMemoryHistory(historyId)
        : (await this.db.listMemoryHistory(100)).find((entry) => entry.undoneAt === null) ?? null
      if (!history) throw new MemoryError("nothing_to_undo", "No memory change is available to undo.")
      if (history.undoneAt) throw new MemoryError("already_undone", "That memory change was already undone.")

      const store = await this.load(history.store)
      const restored = new MemoryStore(history.store, this.limitFor(history.store), history.before)
      if (restored.usage.chars > this.limitFor(history.store)) {
        throw new MemoryError(
          "over_limit",
          `Undoing this change would put memory at ${restored.usage.chars}/${this.limitFor(history.store)} chars.`,
          { usage: restored.usage, requiredFree: restored.usage.chars - this.limitFor(history.store) },
        )
      }
      if (sameEntries(store.entries, restored.entries)) {
        throw new MemoryError("no_op", "The memory store already matches that history state.")
      }

      const historyRecord = await this.db.commitMemoryMutation({
        store: history.store,
        entries: restored.entries,
        before: store.entries,
        after: restored.entries,
        action: "undo",
        actor,
        note: `undo ${history.id}`,
        undoHistoryId: history.id,
      })

      return {
        store: history.store,
        actions: [],
        changed: true,
        message: "Memory change undone.",
        entries: restored.entries,
        usage: restored.usage,
        history: historyRecord,
      }
    })
  }

  async snapshot(): Promise<MemorySnapshot> {
    const [user, memory] = await Promise.all([this.load("user"), this.load("memory")])
    return {
      user: { store: "user", entries: user.entries, usage: user.usage, block: user.renderBlock() },
      memory: { store: "memory", entries: memory.entries, usage: memory.usage, block: memory.renderBlock() },
      generatedAt: new Date().toISOString(),
    }
  }

  async exportMarkdown(): Promise<string> {
    const [user, memory] = await Promise.all([this.load("user"), this.load("memory")])
    return `${user.renderMarkdown()}\n${memory.renderMarkdown()}`
  }

  async characterCount(store: MemoryStoreName): Promise<number> {
    return codePointLength((await this.load(store)).entries.join(ENTRY_DELIMITER))
  }

  private limitFor(store: MemoryStoreName): number {
    return store === "user" ? this.userLimit : this.memoryLimit
  }

  private toMutation(result: ReturnType<MemoryStore["apply"]>, history: MemoryHistoryRecord | null): MemoryMutation {
    return {
      store: result.store,
      actions: result.actions,
      changed: result.changed,
      message: result.message,
      entries: result.entries,
      usage: result.usage,
      history,
    }
  }

  private async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    const previous = this.tail
    let release!: () => void
    this.tail = new Promise<void>((resolve) => {
      release = resolve
    })
    await previous
    try {
      return await fn()
    } finally {
      release()
    }
  }
}

function sameEntries(left: readonly string[], right: readonly string[]): boolean {
  return left.length === right.length && left.every((entry, index) => entry === right[index])
}
