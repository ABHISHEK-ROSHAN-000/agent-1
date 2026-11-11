import { generateText, stepCountIs, tool } from "ai"
import type { Logger } from "../core/log"
import type { Database } from "../db/database"
import type { EventService } from "../events/service"
import type { ModelService } from "../models/model-service"
import type { Session } from "../shared/types"
import type { MemoryService } from "./memory-service"
import { memoryToolInputSchema, type MemoryToolInput } from "./memory-tool-schema"
import { MemoryReviewWriter } from "./memory-review-writer"
import type { MemoryReviewRun, MemoryReviewTrigger } from "./types"

export const MEMORY_REVIEW_INTERVAL_SETTING = "memory.review.interval"
export const MEMORY_REVIEW_ENABLED_SETTING = "memory.review.enabled"
export const DEFAULT_MEMORY_REVIEW_INTERVAL = 10

const MAX_REVIEW_MESSAGES = 40
const MAX_REVIEW_MESSAGE_CHARS = 2_000
const MAX_REVIEW_TRANSCRIPT_CHARS = 30_000
const MAX_REVIEW_OUTPUT_TOKENS = 800
const MAX_REVIEW_STEPS = 6

export interface MemoryReviewServiceOptions {
  readonly defaultInterval?: number
}

export class MemoryReviewService {
  private readonly controllers = new Map<string, AbortController>()
  private readonly runningSessions = new Set<string>()
  private readonly writer: MemoryReviewWriter
  private readonly defaultInterval: number

  constructor(
    private readonly db: Database,
    private readonly events: EventService,
    private readonly models: ModelService,
    private readonly memory: MemoryService,
    private readonly logger: Logger,
    options: MemoryReviewServiceOptions = {},
  ) {
    this.writer = new MemoryReviewWriter(memory)
    this.defaultInterval = positiveInt(options.defaultInterval ?? DEFAULT_MEMORY_REVIEW_INTERVAL, 10)
  }

  async initialize(): Promise<void> {
    await this.db.failRunningMemoryReviews()
  }

  async maybeReview(sessionId: string): Promise<MemoryReviewRun | null> {
    try {
      if (this.runningSessions.has(sessionId)) return null
      if (await this.db.hasActiveTurn(sessionId)) return null
      if (!(await this.enabled())) return null
      const interval = await this.interval()
      const last = await this.db.latestTerminalMemoryReview(sessionId)
      const turns = await this.db.countUserMessagesSince(sessionId, last?.completedAt ?? null)
      if (turns < interval) return null
      return await this.reviewNow(sessionId, "nudge")
    } catch (error) {
      this.logger.warn("memory.review.maybe_failed", {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      })
      return null
    }
  }

  async reviewNow(
    sessionId: string,
    trigger: MemoryReviewTrigger = "manual",
  ): Promise<MemoryReviewRun | null> {
    if (this.runningSessions.has(sessionId)) return null
    if (await this.db.hasActiveTurn(sessionId)) return null
    const session = await this.db.getSession(sessionId)
    if (!session) return null

    let resolved
    try {
      resolved = await this.models.resolve(
        session.providerId && session.modelId
          ? { providerId: session.providerId, modelId: session.modelId }
          : undefined,
      )
    } catch (error) {
      this.logger.warn("memory.review.model_unavailable", {
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      })
      return null
    }
    if (!resolved.model.supportsTools) return null

    const turnsSinceMemory = await this.db.countUserMessagesSince(
      sessionId,
      (await this.db.latestTerminalMemoryReview(sessionId))?.completedAt ?? null,
    )
    const run = await this.db.createMemoryReviewRun({
      sessionId,
      trigger,
      providerId: resolved.provider.id,
      modelId: resolved.model.modelId,
      turnsSinceMemory,
    })

    const controller = new AbortController()
    this.controllers.set(sessionId, controller)
    this.runningSessions.add(sessionId)
    let applied = 0
    let staged = 0
    let pendingIds: string[] = []

    try {
      await this.events.append("memory.review.started", sessionId, {
        reviewId: run.id,
        trigger,
        turnsSinceMemory,
        providerId: resolved.provider.id,
        modelId: resolved.model.modelId,
      })

      const reviewTool = tool({
        description:
          "Update durable memory. Additions apply immediately. Patch and remove operations from this background review are staged for user approval.",
        inputSchema: memoryToolInputSchema,
        execute: async (input: MemoryToolInput) => {
          const result = await this.writer.apply(input, { sessionId })
          applied += result.applied
          staged += result.staged
          pendingIds = [...pendingIds, ...result.pendingIds]
          return result
        },
      })

      const result = await generateText({
        model: this.models.createModel(
          resolved,
          this.models.reasoningEffortFor(resolved.model, session.reasoningEffort),
        ),
        system: this.reviewSystemPrompt(),
        prompt: await this.reviewPrompt(session),
        tools: { memory: reviewTool },
        stopWhen: stepCountIs(MAX_REVIEW_STEPS),
        maxOutputTokens: MAX_REVIEW_OUTPUT_TOKENS,
        ...(resolved.model.supportsTemperature ? { temperature: 0 } : {}),
        maxRetries: 1,
        abortSignal: controller.signal,
      })

      const completed = await this.db.completeMemoryReviewRun(run.id, "completed", {
        inputTokens: result.usage?.inputTokens ?? 0,
        outputTokens: result.usage?.outputTokens ?? 0,
      })
      await this.events.append("memory.review.completed", sessionId, {
        reviewId: run.id,
        trigger,
        applied,
        staged,
        pendingIds,
        inputTokens: result.usage?.inputTokens ?? 0,
        outputTokens: result.usage?.outputTokens ?? 0,
      })
      return completed ?? run
    } catch (error) {
      const cancelled = controller.signal.aborted
      if (cancelled) {
        const completed = await this.db.completeMemoryReviewRun(run.id, "cancelled", undefined, null)
        await this.events
          .append("memory.review.cancelled", sessionId, { reviewId: run.id, trigger })
          .catch(() => {})
        return completed ?? run
      }
      const message = error instanceof Error ? error.message : String(error)
      this.logger.warn("memory.review.failed", { sessionId, reviewId: run.id, error: message })
      const completed = await this.db.completeMemoryReviewRun(
        run.id,
        "failed",
        { inputTokens: 0, outputTokens: 0 },
        message,
      )
      await this.events
        .append("memory.review.failed", sessionId, { reviewId: run.id, trigger, error: message })
        .catch(() => {})
      return completed ?? run
    } finally {
      this.controllers.delete(sessionId)
      this.runningSessions.delete(sessionId)
    }
  }

  cancel(sessionId: string): void {
    this.controllers.get(sessionId)?.abort()
  }

  private async enabled(): Promise<boolean> {
    const value = await this.db.getSetting(MEMORY_REVIEW_ENABLED_SETTING)
    return value === null ? true : !["false", "0", "no", "off"].includes(value.trim().toLowerCase())
  }

  private async interval(): Promise<number> {
    const value = Number(await this.db.getSetting(MEMORY_REVIEW_INTERVAL_SETTING))
    return Number.isInteger(value) && value > 0 ? value : this.defaultInterval
  }

  private reviewSystemPrompt(): string {
    return [
      "You are Agent-1's background memory reviewer.",
      "Review the conversation and decide whether any durable facts belong in persistent memory.",
      "You may call only the memory tool. Do not call, request, or describe any other tool.",
      "Use the user store for identity, preferences, and communication style.",
      "Use the memory store for environment facts, conventions, and durable lessons.",
      "Save only facts grounded in a user message or an assistant conclusion backed by this conversation.",
      "Do not infer traits from tone. Do not turn one-off requests into standing preferences.",
      "Skip task progress, temporary paths, raw data dumps, and completed-work logs.",
      "Do not duplicate an existing memory entry. Prefer compact, information-dense entries.",
      "If nothing is worth saving, return 'Nothing to save' without calling a tool.",
      "Use one atomic memory call per target.",
    ].join("\n")
  }

  private async reviewPrompt(session: Session): Promise<string> {
    const stored = await this.db.getSessionMessages(session.id, 120)
    const recent = stored
      .filter((message) => message.role === "user" || message.role === "assistant")
      .slice(-MAX_REVIEW_MESSAGES)
    const transcript = recent
      .map((message) => {
        const text = message.text.trim().slice(0, MAX_REVIEW_MESSAGE_CHARS)
        return text ? `${message.role.toUpperCase()}: ${text}` : ""
      })
      .filter(Boolean)
      .join("\n\n")
      .slice(-MAX_REVIEW_TRANSCRIPT_CHARS)
    const snapshot = await this.memory.snapshot()
    const memoryText = [snapshot.user.block, snapshot.memory.block].filter(Boolean).join("\n\n")
    return [
      "Review the conversation below for durable memory.",
      memoryText ? `CURRENT MEMORY:\n${memoryText}` : "CURRENT MEMORY: (empty)",
      "CONVERSATION:",
      transcript || "(no user or assistant messages)",
    ].join("\n\n")
  }
}

function positiveInt(value: number, fallback: number): number {
  return Number.isInteger(value) && value > 0 ? value : fallback
}
