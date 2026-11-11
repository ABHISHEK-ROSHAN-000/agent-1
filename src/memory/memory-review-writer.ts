import type { MemoryService } from "./memory-service"
import type { MemoryToolInput } from "./memory-tool-schema"
import { MemoryError } from "./types"

export interface ReviewApplyContext {
  readonly sessionId: string
  readonly turnId?: string | null
}

export interface ReviewApplyResult {
  readonly success: boolean
  readonly applied: number
  readonly staged: number
  readonly pendingIds: readonly string[]
  readonly message: string
  readonly error?: string
  readonly code?: string
  readonly currentEntries?: readonly string[]
  readonly usage?: unknown
  readonly threats?: readonly string[]
}

/**
 * Applies a background review's memory operations under the Hermes write policy:
 * additions are written directly; destructive edits are staged for approval.
 */
export class MemoryReviewWriter {
  constructor(private readonly memory: MemoryService) {}

  async apply(input: MemoryToolInput, context: ReviewApplyContext): Promise<ReviewApplyResult> {
    const additions = input.operations.filter((operation) => operation.action === "add")
    const destructive = input.operations.filter((operation) => operation.action !== "add")

    if (additions.length > 0) {
      try {
        await this.memory.mutate({
          store: input.target,
          operations: additions,
          actor: "background_review",
          sessionId: context.sessionId,
          turnId: context.turnId ?? null,
          note: "background memory review",
        })
      } catch (error) {
        return this.failure(error)
      }
    }

    const pendingIds: string[] = []
    for (const operation of destructive) {
      try {
        const pending = await this.memory.stagePending({
          store: input.target,
          action: operation.action,
          ...(operation.content === undefined ? {} : { content: operation.content }),
          ...(operation.oldText === undefined ? {} : { oldText: operation.oldText }),
          sessionId: context.sessionId,
          turnId: context.turnId ?? null,
          origin: "background_review",
        })
        pendingIds.push(pending.id)
      } catch (error) {
        return this.failure(error, additions.length, pendingIds.length, pendingIds)
      }
    }

    return {
      success: true,
      applied: additions.length,
      staged: pendingIds.length,
      pendingIds,
      message:
        pendingIds.length > 0
          ? `Applied ${additions.length} addition(s); staged ${pendingIds.length} destructive change(s) for approval.`
          : `Applied ${additions.length} addition(s).`,
    }
  }

  private failure(
    error: unknown,
    applied = 0,
    staged = 0,
    pendingIds: readonly string[] = [],
  ): ReviewApplyResult {
    if (!(error instanceof MemoryError)) throw error
    return {
      success: false,
      applied,
      staged,
      pendingIds,
      message: error.message,
      error: error.message,
      code: error.code,
      ...(error.details.currentEntries ? { currentEntries: error.details.currentEntries } : {}),
      ...(error.details.usage ? { usage: error.details.usage } : {}),
      ...(error.details.threats ? { threats: error.details.threats } : {}),
    }
  }
}
