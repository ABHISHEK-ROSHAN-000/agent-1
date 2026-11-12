import {
  generateText,
  stepCountIs,
  streamText,
  type ModelMessage,
} from "ai"
import type { Logger } from "../core/log"
import type { ModelService, ResolvedModel } from "../models/model-service"
import type { ProviderService } from "../models/provider-service"
import {
  ProviderTurnError,
  isOneShotRetryable,
  isRetryableProviderError,
  providerErrorInfo,
  retryDelayMs,
} from "./provider-error"
import { outputLimit } from "./token-budget"
import type { Database, InboxStepResult, NewMessage } from "../db/database"
import type { EventService } from "../events/service"
import type { MemoryReviewService } from "../memory/memory-review-service"
import type { MemoryService } from "../memory/memory-service"
import type { MemorySnapshot } from "../memory/types"
import type { Message, ModelSelection, Session, TokenUsage, Turn, TurnStatus } from "../shared/types"
import { argumentsHash, type PermissionService } from "../permissions/permission-service"
import { ToolContentResult, type ToolService } from "../tools/tool-service"
import { newId } from "../core/ids"
import { AttachmentService } from "../attachments/service"
import { sanitizeModelMessages, userContent } from "../attachments/model-content"
import { SessionInboxService, type Promotable } from "../sessions/inbox"
import type { InboxDelivery, InboxItem, PromptFileInput, StoredFile } from "../shared/types"
import type { TurnBus } from "./turn-bus"

interface PendingToolCall {
  readonly toolCallId: string
  readonly toolName: string
  readonly input: unknown
}

interface CheckpointState {
  readonly step: number
  readonly messages: ModelMessage[]
  readonly usage: TokenUsage
  readonly pendingToolCalls?: PendingToolCall[]
}

interface StepResult {
  readonly responseMessages: ModelMessage[]
  readonly toolCalls: ReadonlyArray<{
    readonly toolCallId: string
    readonly toolName: string
    readonly input: unknown
  }>
  readonly text: string
  readonly usage: TokenUsage
}

export interface TurnServiceOptions {
  readonly maxSteps?: number
  readonly maxWallMs?: number
  readonly maxCostUsd?: number
  readonly maxRetries?: number
  readonly retryBaseMs?: number
}

function textFromContent(content: unknown): string {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content
    .filter((part): part is { type: "text"; text: string } => {
      return Boolean(part) && typeof part === "object" && (part as { type?: unknown }).type === "text"
    })
    .map((part) => part.text)
    .join("")
}

function textFromMessage(message: ModelMessage): string {
  return textFromContent((message as { content?: unknown }).content)
}

function tokenEstimate(messages: readonly ModelMessage[]): number {
  return Math.ceil(JSON.stringify(messages).length / 4)
}

function costFor(model: { costInputPerMillion: number; costOutputPerMillion: number }, inputTokens: number, outputTokens: number): number {
  return (
    (inputTokens / 1_000_000) * model.costInputPerMillion +
    (outputTokens / 1_000_000) * model.costOutputPerMillion
  )
}

export class TurnBusyError extends Error {
  constructor(readonly activeTurn: Turn) {
    super(`Session already has an active turn: ${activeTurn.id}`)
    this.name = "TurnBusyError"
  }
}

export class EmptyPromptError extends Error {
  constructor() {
    super("Prompt text is required")
    this.name = "EmptyPromptError"
  }
}

export interface PromptResult {
  readonly inbox: InboxItem
  readonly turn: Turn | null
  readonly userMessage: Message | null
  readonly pending: boolean
}

export class SessionDeletingError extends Error {
  constructor() {
    super("Session is being deleted")
    this.name = "SessionDeletingError"
  }
}

export class TurnService {
  readonly inbox: SessionInboxService
  readonly attachments: AttachmentService
  private readonly active = new Map<string, AbortController>()
  private readonly running = new Map<string, Promise<void>>()
  private readonly deletingSessions = new Set<string>()
  private readonly wakes = new Map<string, Promotable>()
  private readonly maxSteps: number
  private readonly maxWallMs: number
  private readonly maxCostUsd: number
  private readonly maxRetries: number
  private readonly retryBaseMs: number

  constructor(
    private readonly db: Database,
    private readonly events: EventService,
    private readonly models: ModelService,
    private readonly providers: ProviderService,
    private readonly permissions: PermissionService,
    private readonly tools: ToolService,
    private readonly bus: TurnBus,
    private readonly logger: Logger,
    private readonly memory?: MemoryService,
    private readonly memoryReview?: MemoryReviewService,
    options: TurnServiceOptions = {},
  ) {
    this.maxSteps = options.maxSteps ?? Number(process.env.AGENT1_TURN_MAX_STEPS ?? "8")
    this.maxWallMs = options.maxWallMs ?? Number(process.env.AGENT1_TURN_MAX_WALL_MS ?? "120000")
    this.maxCostUsd = options.maxCostUsd ?? Number(process.env.AGENT1_TURN_MAX_COST_USD ?? "0")
    this.maxRetries = options.maxRetries ?? Number(process.env.AGENT1_TURN_MAX_RETRIES ?? "10")
    this.retryBaseMs = options.retryBaseMs ?? Number(process.env.AGENT1_TURN_RETRY_BASE_MS ?? "2000")
    this.inbox = new SessionInboxService(db, events, logger)
    this.attachments = new AttachmentService(db, logger)
  }

  async startTurn(
    sessionId: string,
    content: string,
    selection?: ModelSelection,
    files?: readonly StoredFile[],
  ): Promise<{ turn: Turn; userMessage: Message }> {
    if (this.deletingSessions.has(sessionId)) throw new SessionDeletingError()
    const session = await this.db.getSession(sessionId)
    if (!session) throw new Error("Session not found")
    const activeTurn = await this.db.getActiveTurn(sessionId)
    if (activeTurn) throw new TurnBusyError(activeTurn)
    this.memoryReview?.cancel(sessionId)
    const resolved = await this.models.resolve(
      selection ??
        (session.providerId && session.modelId
          ? { providerId: session.providerId, modelId: session.modelId }
          : undefined),
    )
    const reasoningEffort = this.models.reasoningEffortFor(
      resolved.model,
      selection ? selection.reasoningEffort : session.reasoningEffort,
    )
    await this.db.setSessionModel(
      sessionId,
      resolved.provider.id,
      resolved.model.modelId,
      reasoningEffort ?? null,
    )
    let created: Awaited<ReturnType<Database["createTurnWithUserMessage"]>>
    try {
      created = await this.db.createTurnWithUserMessage(
        sessionId,
        resolved.provider.id,
        resolved.model.modelId,
        content,
        reasoningEffort ?? null,
        files,
      )
    } catch (error) {
      const raced = await this.db.getActiveTurn(sessionId)
      if (raced) throw new TurnBusyError(raced)
      throw error
    }
    this.bus.publish(created.turn.id, { type: "status", status: "queued" })
    await this.events.append("turn.started", sessionId, {
      turnId: created.turn.id,
      providerId: resolved.provider.id,
      modelId: resolved.model.modelId,
      reasoningEffort: reasoningEffort ?? null,
    })
    await this.providers.touchModel(resolved.provider.id, resolved.model.modelId)
    this.launchRun(created.turn.id, false)
    return created
  }

  /**
   * Durable prompt admission. A busy session admits work instead of failing:
   * steer wakes the active execution, queue waits for the idle boundary.
   */
  async prompt(
    sessionId: string,
    content: string,
    options: {
      readonly delivery?: InboxDelivery
      readonly selection?: ModelSelection
      readonly id?: string
      readonly files?: readonly PromptFileInput[]
    } = {},
  ): Promise<PromptResult> {
    if (this.deletingSessions.has(sessionId)) throw new SessionDeletingError()
    if (!content.trim() && (!options.files || options.files.length === 0)) throw new EmptyPromptError()
    const delivery = options.delivery ?? "steer"
    return this.inbox.serialized(sessionId, async () => {
      const session = await this.db.getSession(sessionId)
      if (!session) throw new Error("Session not found")
      const materialized = await this.attachments.materialize(options.files)
      const admitted = await this.inbox.admitWithinLock({
        id: options.id ?? newId("msg"),
        sessionId,
        text: content,
        delivery,
        ...(materialized.files.length > 0 ? { files: materialized.files } : {}),
      })

      const active = await this.db.getActiveTurn(sessionId)
      if (active) {
        if (delivery === "steer") this.wakeSession(sessionId, "steer")
        return {
          inbox: admitted.item,
          turn: active,
          userMessage: null,
          pending: admitted.pending,
        }
      }
      if (delivery === "queue" || admitted.item.delivery !== "steer") {
        return { inbox: admitted.item, turn: null, userMessage: null, pending: admitted.pending }
      }
      if (!admitted.pending) {
        return { inbox: admitted.item, turn: null, userMessage: null, pending: false }
      }
      const started = await this.startTurnFromInboxLocked(sessionId, admitted.item, options.selection)
      if (!started) {
        const current = await this.db.getActiveTurn(sessionId)
        return { inbox: admitted.item, turn: current, userMessage: null, pending: false }
      }
      return {
        inbox: admitted.item,
        turn: started.turn,
        userMessage: started.userMessage,
        pending: false,
      }
    })
  }

  listInbox(sessionId: string): Promise<InboxItem[]> {
    return this.inbox.list(sessionId)
  }

  async cancelInbox(sessionId: string, id: string): Promise<InboxItem | null> {
    const result = await this.inbox.cancel(sessionId, id)
    return result.item
  }

  async setInboxDelivery(
    sessionId: string,
    id: string,
    delivery: InboxDelivery,
  ): Promise<{ readonly inbox: InboxItem | null; readonly turn: Turn | null }> {
    return this.inbox.serialized(sessionId, async () => {
      const result = await this.inbox.setDeliveryWithinLock(sessionId, id, delivery)
      if (!result.item) return { inbox: null, turn: null }
      if (delivery === "queue") return { inbox: result.item, turn: null }
      const active = await this.db.getActiveTurn(sessionId)
      if (active) {
        this.wakeSession(sessionId, "steer")
        return { inbox: result.item, turn: active }
      }
      const started = await this.startTurnFromInboxLocked(sessionId, result.item)
      return { inbox: result.item, turn: started?.turn ?? null }
    })
  }

  async interruptSession(
    sessionId: string,
    options: { readonly resume?: boolean } = {},
  ): Promise<{ readonly interrupted: boolean; readonly turn: Turn | null }> {
    const active = await this.db.getActiveTurn(sessionId)
    if (!active) return { interrupted: false, turn: null }
    await this.cancel(active.id)
    const running = this.running.get(active.id)
    if (running) {
      await Promise.race([
        running,
        new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
      ])
    }
    if (options.resume === false) return { interrupted: true, turn: null }
    const next = await this.inbox.nextPromotable(sessionId, "steer")
    if (!next) return { interrupted: true, turn: null }
    const started = await this.inbox.serialized(sessionId, () =>
      this.startTurnFromInboxLocked(sessionId, next),
    )
    return { interrupted: true, turn: started?.turn ?? null }
  }

  private wakeSession(sessionId: string, scope: Promotable): void {
    const current = this.wakes.get(sessionId)
    if (current === "input" || scope === "steer") this.wakes.set(sessionId, scope)
  }

  private async startTurnFromInboxLocked(
    sessionId: string,
    item: InboxItem,
    selection?: ModelSelection,
  ): Promise<{ turn: Turn; userMessage: Message } | null> {
    if (this.deletingSessions.has(sessionId)) throw new SessionDeletingError()
    const session = await this.db.getSession(sessionId)
    if (!session) throw new Error("Session not found")
    this.memoryReview?.cancel(sessionId)
    const resolved = await this.models.resolve(
      selection ??
        (session.providerId && session.modelId
          ? { providerId: session.providerId, modelId: session.modelId }
          : undefined),
    )
    const reasoningEffort = this.models.reasoningEffortFor(
      resolved.model,
      selection ? selection.reasoningEffort : session.reasoningEffort,
    )
    await this.db.setSessionModel(
      sessionId,
      resolved.provider.id,
      resolved.model.modelId,
      reasoningEffort ?? null,
    )
    const created = await this.db.createTurnFromInbox({
      sessionId,
      inboxId: item.id,
      providerId: resolved.provider.id,
      modelId: resolved.model.modelId,
      reasoningEffort: reasoningEffort ?? null,
    })
    if (!created) return null
    this.events.publish(created.event)
    this.bus.publish(created.turn.id, { type: "status", status: "queued" })
    await this.events.append("turn.started", sessionId, {
      turnId: created.turn.id,
      providerId: resolved.provider.id,
      modelId: resolved.model.modelId,
      reasoningEffort: reasoningEffort ?? null,
    })
    await this.providers.touchModel(resolved.provider.id, resolved.model.modelId)
    this.launchRun(created.turn.id, false)
    return { turn: created.turn, userMessage: created.userMessage }
  }

  beginSessionDelete(sessionId: string): void {
    this.deletingSessions.add(sessionId)
  }

  endSessionDelete(sessionId: string): void {
    this.deletingSessions.delete(sessionId)
  }

  async cancelSession(sessionId: string): Promise<Turn | null> {
    const active = await this.db.getActiveTurn(sessionId)
    if (!active) return null
    const cancelled = await this.cancel(active.id)
    const running = this.running.get(active.id)
    if (running) {
      await Promise.race([
        running,
        new Promise<void>((resolve) => setTimeout(resolve, 5_000)),
      ])
    }
    return cancelled
  }

  private launchRun(turnId: string, resumed: boolean): void {
    if (this.running.has(turnId)) return
    const promise = this.runTurn(turnId, resumed)
      .catch((error) => {
        this.logger.error("turn.run_failed", {
          turnId,
          error: error instanceof Error ? error.message : String(error),
        })
      })
      .finally(() => {
        this.running.delete(turnId)
      })
    this.running.set(turnId, promise)
  }

  async cancel(turnId: string): Promise<Turn | null> {
    const turn = await this.db.getTurn(turnId)
    if (!turn) return null
    if (turn.status === "completed" || turn.status === "failed" || turn.status === "cancelled") {
      return turn
    }
    this.active.get(turnId)?.abort()
    const cancelled = await this.db.cancelTurn(turnId)
    this.bus.publish(turnId, { type: "done", status: "cancelled" })
    await this.events.append("turn.cancelled", turn.sessionId, { turnId })
    return cancelled
  }

  async recoverAll(): Promise<void> {
    const turns = await this.db.recoverableTurns()
    for (const turn of turns) {
      await this.db.setTurnStatus(turn.id, "resuming")
      this.bus.publish(turn.id, { type: "status", status: "resuming" })
      await this.events.append("turn.resumed", turn.sessionId, { turnId: turn.id })
      this.launchRun(turn.id, true)
    }
  }

  async listMessages(sessionId: string, limit = 500): Promise<Message[]> {
    return this.db.getSessionMessages(sessionId, limit)
  }

  async resumeWaiting(turnId: string): Promise<void> {
    const turn = await this.db.getTurn(turnId)
    if (!turn || turn.status !== "waiting_approval") return
    this.launchRun(turnId, true)
  }

  private async saveBoundary(
    turn: Turn,
    state: CheckpointState,
    newMessages: readonly NewMessage[],
    scope: Promotable,
    requestedStatus: TurnStatus,
  ): Promise<{
    state: CheckpointState
    messages: Message[]
    status: TurnStatus
    promoted: number
  }> {
    let nextState = state
    const result = await this.inbox.promote(turn.sessionId, scope, async (items) => {
      nextState = {
        ...state,
        messages: [
          ...state.messages,
          ...items.map((item): ModelMessage => ({ role: "user", content: item.payload.text })),
        ],
      }
      const saved = await this.db.saveTurnStepWithInbox({
        turnId: turn.id,
        step: state.step,
        sessionId: turn.sessionId,
        messages: newMessages,
        checkpoint: nextState,
        usage: nextState.usage,
        status: requestedStatus,
        inboxIds: items.map((item) => item.id),
      })
      for (const event of saved.events) this.events.publish(event)
      return saved
    })

    if (!result) {
      const messages = await this.db.saveTurnStep(turn.id, {
        step: state.step,
        sessionId: turn.sessionId,
        messages: newMessages,
        checkpoint: state,
        usage: state.usage,
        status: requestedStatus,
      })
      return { state, messages, status: requestedStatus, promoted: 0 }
    }

    return {
      state: nextState,
      messages: result.messages,
      status: result.status,
      promoted: result.delivered.length,
    }
  }

  private async runTurn(turnId: string, resumed: boolean): Promise<void> {
    if (this.active.has(turnId)) return
    const controller = new AbortController()
    this.active.set(turnId, controller)
    try {
      let turn = await this.db.getTurn(turnId)
      if (!turn) return
      if (turn.status === "cancelled" || turn.status === "completed" || turn.status === "failed") {
        return
      }
      const resolved = await this.models.resolve({ providerId: turn.providerId, modelId: turn.modelId })
      let session = await this.db.getSession(turn.sessionId)
      if (!session) throw new Error("Session not found")
      session = await this.ensureMemorySnapshot(session)

      const checkpoint = await this.db.getLatestCheckpoint(turnId)
      let state: CheckpointState
      if (checkpoint && this.isCheckpointState(checkpoint.state)) {
        state = checkpoint.state
      } else {
        const history = await this.buildHistory(session, resolved.model)
        session = (await this.db.getSession(session.id)) ?? session
        state = {
          step: 0,
          messages: history,
          usage: {
            inputTokens: turn.inputTokens,
            outputTokens: turn.outputTokens,
            costUsd: turn.costUsd,
          },
        }
      }

      await this.db.setTurnStatus(turnId, "running")
      this.bus.publish(turnId, { type: "status", status: "running" })
      if (resumed) {
        this.logger.info("turn.resumed", { turnId })
      }

      const started = Date.now()
      while (true) {
        turn = await this.db.getTurn(turnId)
        if (!turn) return
        if (turn.status === "cancelled") {
          this.bus.publish(turnId, { type: "done", status: "cancelled" })
          return
        }

        if (state.pendingToolCalls && state.pendingToolCalls.length > 0) {
          const pending = await this.resolvePending(turn, state)
          state = pending.state
          if (pending.waiting) {
            await this.db.saveTurnStep(turnId, {
              step: state.step,
              sessionId: turn.sessionId,
              messages: pending.newMessages,
              checkpoint: state,
              usage: state.usage,
              status: "waiting_approval",
            })
            this.bus.publish(turnId, { type: "status", status: "waiting_approval" })
            return
          }
          const saved = await this.saveBoundary(turn, state, pending.newMessages, "steer", "running")
          state = saved.state
          this.bus.publish(turnId, { type: "status", status: "running" })
        }

        if (state.step >= this.maxSteps) {
          await this.fail(turn, `budget_exceeded: maximum steps (${this.maxSteps})`)
          return
        }
        if (Date.now() - started > this.maxWallMs) {
          await this.fail(turn, `budget_exceeded: maximum wall time (${this.maxWallMs}ms)`)
          return
        }
        if (this.maxCostUsd > 0 && state.usage.costUsd >= this.maxCostUsd) {
          await this.fail(turn, `budget_exceeded: maximum cost ($${this.maxCostUsd})`)
          return
        }

        await this.db.saveTurnCheckpoint(
          turnId,
          session.id,
          state.step,
          state,
          state.usage,
          "running",
        )

        const step = await this.streamStep(
          turnId,
          session,
          resolved,
          state.messages,
          controller.signal,
          turn.reasoningEffort,
        )

        state = {
          step: state.step + 1,
          messages: [...state.messages, ...step.responseMessages],
          usage: {
            inputTokens: state.usage.inputTokens + step.usage.inputTokens,
            outputTokens: state.usage.outputTokens + step.usage.outputTokens,
            costUsd: costFor(
              resolved.model,
              state.usage.inputTokens + step.usage.inputTokens,
              state.usage.outputTokens + step.usage.outputTokens,
            ),
          },
        }

        const newMessages: NewMessage[] = step.responseMessages.map((message) => ({
          role: message.role === "assistant" ? "assistant" : message.role === "tool" ? "tool" : "assistant",
          text: textFromMessage(message),
          content: message,
        }))

        if (step.toolCalls.length === 0) {
          if (newMessages.length === 0 && step.text) {
            const message: ModelMessage = { role: "assistant", content: step.text }
            state = { ...state, messages: [...state.messages, message] }
            newMessages.push({ role: "assistant", text: step.text, content: message })
          }
          const saved = await this.saveBoundary(turn, state, newMessages, "input", "completed")
          state = saved.state
          if (saved.status !== "completed") {
            this.bus.publish(turnId, { type: "status", status: "running" })
            continue
          }
          this.bus.publish(turnId, { type: "done", status: "completed" })
          await this.events.append("turn.completed", session.id, {
            turnId,
            inputTokens: state.usage.inputTokens,
            outputTokens: state.usage.outputTokens,
            costUsd: state.usage.costUsd,
          })
          void this.memoryReview?.maybeReview(session.id).catch((error) => {
            this.logger.warn("memory.review.trigger_failed", {
              sessionId: session.id,
              error: error instanceof Error ? error.message : String(error),
            })
          })
          return
        }

        const pendingCalls: PendingToolCall[] = []
        for (const call of step.toolCalls) {
          const permissionContext = await this.tools.permissionContext(call.toolName, call.input)
          const decision = await this.permissions.evaluate(call.toolName, call.input, {
            action: this.tools.action(call.toolName),
            risk: this.tools.risk(call.toolName),
            sessionId: session.id,
            ...permissionContext,
          })
          await this.permissions.audit({
            actor: "agent",
            action: "permission.decision",
            resource: decision.ruleId ? permissionContext.resource : this.tools.action(call.toolName),
            decision: decision.effect,
            ruleId: decision.ruleId,
            turnId,
            details: { toolCallId: call.toolCallId, risk: decision.risk },
          })

          if (decision.effect === "deny") {
            const message = this.toolResultMessage(call, null, decision.reason)
            state = { ...state, messages: [...state.messages, message] }
            newMessages.push(
              this.newToolMessage(call, decision.reason, message),
            )
            await this.events.append("tool.denied", session.id, {
              turnId,
              toolName: call.toolName,
              toolCallId: call.toolCallId,
              reason: decision.reason,
            })
            continue
          }

          if (decision.effect === "ask") {
            const approval = await this.permissions.requestApproval({
              turnId,
              sessionId: session.id,
              toolCallId: call.toolCallId,
              toolName: call.toolName,
              action: decision.action,
              resource: decision.resource,
              patternKey: decision.patternKey,
              displayCommand: decision.displayCommand ?? null,
              arguments: call.input,
              ruleId: decision.ruleId,
            })
            pendingCalls.push(call)
            await this.events.append("approval.created", session.id, {
              turnId,
              approvalId: approval.id,
              toolName: call.toolName,
              toolCallId: call.toolCallId,
            })
            continue
          }

          const execution = await this.executeToolCall(turnId, session.id, call)
          state = {
            ...state,
            messages: [
              ...state.messages,
              execution.message,
              ...(execution.followUp ? [execution.followUp] : []),
            ],
          }
          newMessages.push(this.newToolMessage(call, execution.text, execution.message))
          if (execution.followUp) {
            newMessages.push({
              role: "tool",
              text: execution.followUpText ?? "Tool attachment",
              content: {
                role: "user",
                content: [{ type: "text", text: execution.followUpText ?? "Tool attachment" }],
              },
              ...(execution.followUpFiles ? { files: execution.followUpFiles } : {}),
            })
          }
        }

        if (pendingCalls.length > 0) {
          state = { ...state, pendingToolCalls: pendingCalls }
          await this.db.saveTurnStep(turnId, {
            step: state.step,
            sessionId: session.id,
            messages: newMessages,
            checkpoint: state,
            usage: state.usage,
            status: "waiting_approval",
          })
          this.bus.publish(turnId, { type: "status", status: "waiting_approval" })
          await this.events.append("turn.waiting_approval", session.id, {
            turnId,
            approvals: pendingCalls.length,
          })
          return
        }

        const saved = await this.saveBoundary(turn, state, newMessages, "steer", "running")
        state = saved.state
        this.bus.publish(turnId, { type: "status", status: "running" })
      }
    } catch (error) {
      const info = providerErrorInfo(error)
      const message = info.message
      const turn = await this.db.getTurn(turnId).catch(() => null)
      if (controller.signal.aborted || turn?.status === "cancelled") {
        await this.db.setTurnStatus(turnId, "cancelled").catch(() => {})
        this.bus.publish(turnId, { type: "done", status: "cancelled" })
      } else {
        this.logger.error("turn.failed", {
          turnId,
          error: message,
          kind: info.kind,
          status: info.status,
        })
        if (turn) {
          await this.db.setTurnStatus(turnId, "failed", message, info).catch(() => {})
          await this.events.append("turn.failed", turn.sessionId, {
            turnId,
            error: message,
            kind: info.kind,
            status: info.status,
            providerMessage: info.providerMessage,
            retryAfterMs: info.retryAfterMs,
          }).catch(() => {})
        }
        this.bus.publish(turnId, {
          type: "error",
          message,
          kind: info.kind,
          status: info.status,
          retryAfterMs: info.retryAfterMs,
        })
        this.bus.publish(turnId, { type: "done", status: "failed" })
      }
    } finally {
      this.active.delete(turnId)
    }
  }

  private async resolvePending(
    turn: Turn,
    state: CheckpointState,
  ): Promise<{ state: CheckpointState; newMessages: NewMessage[]; waiting: boolean }> {
    const pending = state.pendingToolCalls ?? []
    const stillPending: PendingToolCall[] = []
    const newMessages: NewMessage[] = []
    let messages = [...state.messages]

    for (const call of pending) {
      const approval = await this.permissions.findApproval(turn.id, call.toolCallId)
      if (!approval || approval.status === "pending") {
        if (!approval) {
          const permissionContext = await this.tools.permissionContext(call.toolName, call.input)
          const command =
            call.input && typeof call.input === "object"
              ? (call.input as Record<string, unknown>).command
              : undefined
          await this.permissions.requestApproval({
            turnId: turn.id,
            sessionId: turn.sessionId,
            toolCallId: call.toolCallId,
            toolName: call.toolName,
            action: this.tools.action(call.toolName),
            resource: permissionContext.resource,
            patternKey:
              typeof command === "string"
                ? `${typeof (call.input as Record<string, unknown>).cwd === "string" ? (call.input as Record<string, unknown>).cwd : ""}\u0000${command}`
                : permissionContext.resource,
            displayCommand: typeof command === "string" ? command : null,
            arguments: call.input,
          })
        }
        stillPending.push(call)
        continue
      }

      if (approval.status === "approved") {
        if (argumentsHash(call.input) !== approval.argumentsHash) {
          const message = this.toolResultMessage(call, null, "Approval arguments changed")
          messages = [...messages, message]
          newMessages.push(this.newToolMessage(call, "Approval arguments changed", message))
          await this.permissions.audit({
            actor: "system",
            action: "tool.denied",
            resource: `tool.${call.toolName}`,
            decision: "deny",
            approvalId: approval.id,
            turnId: turn.id,
            details: { reason: "arguments_changed" },
          })
        } else {
          const execution = await this.executeToolCall(turn.id, turn.sessionId, call)
          messages = [
            ...messages,
            execution.message,
            ...(execution.followUp ? [execution.followUp] : []),
          ]
          newMessages.push(this.newToolMessage(call, execution.text, execution.message))
          if (execution.followUp) {
            newMessages.push({
              role: "tool",
              text: execution.followUpText ?? "Tool attachment",
              content: {
                role: "user",
                content: [{ type: "text", text: execution.followUpText ?? "Tool attachment" }],
              },
              ...(execution.followUpFiles ? { files: execution.followUpFiles } : {}),
            })
          }
        }
        continue
      }

      const reason =
        approval.status === "rejected"
          ? approval.reason ?? "Approval rejected"
          : approval.status === "expired"
            ? "Approval expired"
            : "Approval invalidated"
      const message = this.toolResultMessage(call, null, reason)
      messages = [...messages, message]
      newMessages.push(this.newToolMessage(call, reason, message))
      await this.permissions.audit({
        actor: "system",
        action: "tool.denied",
        resource: `tool.${call.toolName}`,
        decision: "deny",
        approvalId: approval.id,
        turnId: turn.id,
        details: { reason },
      })
    }

    return {
      state: {
        ...state,
        messages,
        pendingToolCalls: stillPending.length > 0 ? stillPending : undefined,
      },
      newMessages,
      waiting: stillPending.length > 0,
    }
  }

  private async executeToolCall(
    turnId: string,
    sessionId: string,
    call: PendingToolCall,
  ): Promise<{
    message: ModelMessage
    followUp?: ModelMessage
    followUpFiles?: StoredFile[]
    followUpText?: string
    text: string
  }> {
    this.bus.publish(turnId, {
      type: "tool",
      phase: "start",
      toolName: call.toolName,
      toolCallId: call.toolCallId,
    })
    await this.events.append("tool.started", sessionId, {
      turnId,
      toolName: call.toolName,
      toolCallId: call.toolCallId,
    })
    let output: unknown
    let failed = false
    try {
      output = await this.tools.execute(call.toolName, call.input, {
        turnId,
        sessionId,
        toolCallId: call.toolCallId,
      })
    } catch (error) {
      failed = true
      output = { error: error instanceof Error ? error.message : String(error) }
    }
    this.bus.publish(turnId, {
      type: "tool",
      phase: "done",
      toolName: call.toolName,
      toolCallId: call.toolCallId,
    })
    await this.events.append("tool.completed", sessionId, {
      turnId,
      toolName: call.toolName,
      toolCallId: call.toolCallId,
      ok: !failed,
    })
    await this.permissions.audit({
      actor: "agent",
      action: "tool.executed",
      resource: `tool.${call.toolName}`,
      decision: failed ? "error" : "allow",
      turnId,
      details: { toolCallId: call.toolCallId, failed },
    })
    if (output instanceof ToolContentResult) {
      const text = output.content
        .filter((item): item is { type: "text"; text: string } => item.type === "text")
        .map((item) => item.text)
        .join("\n") || "Tool completed"
      const files = output.content.filter(
        (item): item is { type: "file"; uri: string; mime: string; name?: string } => item.type === "file",
      )
      const message = this.toolTextMessage(call, text)
      if (files.length === 0) return { message, text }
      const followUpText = `Attached tool output: ${files.map((file) => file.name ?? file.mime).join(", ")}`
      const stored = await this.attachments.materialize(
        files.map((file) => ({
          uri: file.uri,
          name: file.name,
          source: { type: "inline" as const },
        })),
      )
      const hydrated = await this.attachments.hydrate(stored.files)
      const followUp: ModelMessage = {
        role: "user",
        content: [
          { type: "text", text: followUpText },
          ...hydrated.map((file) => ({
            type: "file" as const,
            data: { type: "data" as const, data: file.data },
            mediaType: file.mime,
            ...(file.name ? { filename: file.name } : {}),
          })),
        ],
      }
      return {
        message,
        followUp,
        followUpFiles: [...stored.files],
        followUpText,
        text,
      }
    }
    const message = this.toolResultMessage(call, output)
    return { message, text: textFromMessage(message) }
  }

  private toolTextMessage(call: PendingToolCall, text: string): ModelMessage {
    return {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          output: { type: "text", value: text },
        },
      ],
    }
  }

  private toolResultMessage(
    call: PendingToolCall,
    output: unknown,
    deniedReason?: string,
  ): ModelMessage {
    const result = deniedReason
      ? { type: "execution-denied" as const, reason: deniedReason }
      : output instanceof ToolContentResult
        ? {
            type: "content" as const,
            value: output.content.map((item) =>
              item.type === "text"
                ? { type: "text" as const, text: item.text }
                : {
                    type: "file" as const,
                    data: { type: "data" as const, data: item.uri.slice(item.uri.indexOf(",") + 1) },
                    mediaType: item.mime,
                    ...(item.name ? { filename: item.name } : {}),
                  },
            ),
          }
        : { type: "json" as const, value: output as never }
    return {
      role: "tool",
      content: [
        {
          type: "tool-result",
          toolCallId: call.toolCallId,
          toolName: call.toolName,
          output: result,
        },
      ],
    }
  }

  private newToolMessage(call: PendingToolCall, text: string, content: ModelMessage): NewMessage {
    return {
      role: "tool",
      text,
      content,
    }
  }

  private async streamStep(
    turnId: string,
    session: Session,
    resolved: ResolvedModel,
    messages: ModelMessage[],
    signal: AbortSignal,
    reasoningEffort?: string | null,
  ): Promise<StepResult> {
    const model = this.models.createModel(resolved, reasoningEffort)
    const system = this.systemPrompt(session, resolved.model)
    const maxOutputTokens = outputLimit(
      resolved.model,
      { estimated: tokenEstimate(messages) + Math.ceil(system.length / 4) },
      0.01,
    )
    let attempt = 0
    while (true) {
      let outputStarted = false
      try {
        const requestMessages = sanitizeModelMessages(messages, resolved.model)
        const result = streamText({
          model,
          system,
          messages: requestMessages,
          ...(resolved.model.supportsTools ? { tools: this.tools.definitions() } : {}),
          stopWhen: stepCountIs(1),
          maxOutputTokens,
          ...(resolved.model.supportsTemperature ? { temperature: 0 } : {}),
          maxRetries: 0,
          abortSignal: signal,
        })

        for await (const part of result.fullStream) {
          if (part.type === "text-delta" && part.text.length > 0) {
            outputStarted = true
            this.bus.publish(turnId, { type: "delta", text: part.text })
          } else if (part.type === "tool-call" || part.type === "tool-input-start") {
            outputStarted = true
          } else if (part.type === "error") {
            throw part.error instanceof Error ? part.error : new Error(String(part.error))
          }
        }

        const [responseMessages, toolCalls, usage, text] = await Promise.all([
          result.responseMessages,
          result.toolCalls,
          result.usage,
          result.text,
        ])
        return {
          responseMessages: responseMessages as ModelMessage[],
          toolCalls: toolCalls.map((call) => ({
            toolCallId: call.toolCallId,
            toolName: call.toolName,
            input: call.input,
          })),
          text,
          usage: {
            inputTokens: usage.inputTokens ?? 0,
            outputTokens: usage.outputTokens ?? 0,
            costUsd: 0,
          },
        }
      } catch (error) {
        const info = providerErrorInfo(error)
        if (
          signal.aborted ||
          outputStarted ||
          !isRetryableProviderError(error) ||
          attempt >= this.maxRetries
        ) {
          throw new ProviderTurnError(info, error)
        }
        attempt++
        const delayMs = retryDelayMs(attempt, info, this.retryBaseMs)
        this.logger.warn("turn.retry_scheduled", {
          turnId,
          attempt,
          delayMs,
          kind: info.kind,
          status: info.status,
        })
        this.bus.publish(turnId, {
          type: "retry",
          attempt,
          delayMs,
          message: info.message,
          kind: info.kind,
          ...(info.status === undefined ? {} : { status: info.status }),
        })
        await this.waitRetry(delayMs, signal)
      }
    }
  }

  private async waitRetry(delayMs: number, signal: AbortSignal): Promise<void> {
    if (signal.aborted) throw signal.reason instanceof Error ? signal.reason : new Error("Aborted")
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        signal.removeEventListener("abort", onAbort)
        resolve()
      }, delayMs)
      const onAbort = () => {
        clearTimeout(timer)
        reject(signal.reason instanceof Error ? signal.reason : new Error("Aborted"))
      }
      signal.addEventListener("abort", onAbort, { once: true })
    })
  }

  private async buildHistory(session: Session, model: ResolvedModel["model"]): Promise<ModelMessage[]> {
    const stored = await this.db.getSessionMessages(session.id, 500)
    const visible = stored.filter(
      (message) => !session.summaryThroughSeq || message.seq > session.summaryThroughSeq,
    )
    let messages = await Promise.all(visible.map((message) => this.toModelMessage(message, model)))
    if (tokenEstimate(messages) > Math.floor(model.contextWindow * 0.7) && messages.length > 8) {
      const oldMessages = stored.slice(0, -6)
      const recentMessages = stored.slice(-6)
      const throughSeq = oldMessages[oldMessages.length - 1]?.seq
      if (throughSeq !== undefined) {
        const summary = await this.summarize(
          oldMessages.map((message) => message.text).filter(Boolean),
          await this.models.resolve({ providerId: model.providerId, modelId: model.modelId }),
        )
        await this.db.setSessionSummary(session.id, summary, throughSeq)
        messages = await Promise.all(recentMessages.map((message) => this.toModelMessage(message, model)))
      }
    }
    return messages
  }

  private async summarize(
    texts: string[],
    resolved: ResolvedModel,
  ): Promise<string> {
    const fallback = `Earlier conversation was compacted (${texts.length} messages).`
    const model = this.models.createModel(resolved)
    for (let attempt = 0; attempt <= 3; attempt++) {
      try {
        const result = await generateText({
          model,
          system:
            "Summarize the earlier conversation for use as context. Keep decisions, user preferences, open tasks, and facts. Be concise.",
          prompt: texts.join("\n\n").slice(0, 24_000),
          maxOutputTokens: 400,
          ...(resolved.model.supportsTemperature ? { temperature: 0 } : {}),
          maxRetries: 0,
          abortSignal: AbortSignal.timeout(20_000),
        })
        return result.text.trim() || fallback
      } catch (error) {
        if (attempt >= 3 || !isOneShotRetryable(error)) return fallback
        const info = providerErrorInfo(error)
        const delayMs = retryDelayMs(attempt + 1, info, this.retryBaseMs)
        this.logger.warn("turn.summary_retry", { attempt: attempt + 1, delayMs, kind: info.kind })
        await new Promise((resolve) => setTimeout(resolve, delayMs))
      }
    }
    return fallback
  }

  private async ensureMemorySnapshot(session: Session): Promise<Session> {
    if (!this.memory || session.memorySnapshotJson) return session
    try {
      const snapshot = await this.memory.snapshot()
      const snapshotJson = JSON.stringify(snapshot)
      const snapshotAt = new Date().toISOString()
      await this.db.setSessionMemorySnapshot(session.id, snapshotJson, snapshotAt)
      return { ...session, memorySnapshotJson: snapshotJson, memorySnapshotAt: snapshotAt }
    } catch (error) {
      this.logger.warn("memory.snapshot_failed", {
        sessionId: session.id,
        error: error instanceof Error ? error.message : String(error),
      })
      return session
    }
  }

  private memoryPrompt(session: Session): string {
    if (!session.memorySnapshotJson) return ""
    try {
      const snapshot = JSON.parse(session.memorySnapshotJson) as Partial<MemorySnapshot>
      const blocks = [snapshot.user?.block, snapshot.memory?.block].filter(
        (block): block is string => typeof block === "string" && block.trim().length > 0,
      )
      if (blocks.length === 0) return ""
      return [
        "Persistent memory snapshot (frozen at session start; changes apply in a future session):",
        ...blocks,
      ].join("\n\n")
    } catch (error) {
      this.logger.warn("memory.snapshot_invalid", {
        sessionId: session.id,
        error: error instanceof Error ? error.message : String(error),
      })
      return ""
    }
  }

  private systemPrompt(session: Session, model: ResolvedModel["model"]): string {
    const summary = session.summary ? `Earlier conversation summary:\n${session.summary}` : ""
    const memory = this.memoryPrompt(session)
    return [
      "You are Agent-1, a local personal assistant running on the user's Windows laptop.",
      model.supportsTools
        ? "You can use the available tools. Writes and shell commands require explicit user approval."
        : "This model is running without tool access.",
      model.supportsTools ? `Available tools: ${this.tools.names().join(", ")}.` : "",
      memory,
      "Use tools when they help. Do not claim a side effect or a tool result you did not receive.",
      "Be direct, concrete, and concise. Ask one clarifying question only when necessary.",
      summary,
    ]
      .filter(Boolean)
      .join("\n\n")
  }

  private async toModelMessage(
    message: Message,
    model: ResolvedModel["model"],
  ): Promise<ModelMessage> {
    if ((message.role === "user" || message.role === "tool") && message.files && message.files.length > 0) {
      const files = await this.attachments.hydrate(message.files)
      const content = userContent(message.text, files, model)
      return content.length > 0
        ? { role: "user", content }
        : { role: "user", content: message.text }
    }
    if (message.content && typeof message.content === "object") {
      return message.content as ModelMessage
    }
    if (message.role === "assistant") return { role: "assistant", content: message.text }
    if (message.role === "user") return { role: "user", content: message.text }
    return { role: "assistant", content: message.text }
  }

  private isCheckpointState(value: unknown): value is CheckpointState {
    if (!value || typeof value !== "object") return false
    const candidate = value as Partial<CheckpointState>
    return (
      typeof candidate.step === "number" &&
      Array.isArray(candidate.messages) &&
      Boolean(candidate.usage) &&
      typeof candidate.usage === "object"
    )
  }

  private async fail(turn: Turn, message: string): Promise<void> {
    const details = { kind: "budget", message }
    await this.db.setTurnStatus(turn.id, "failed", message, details)
    await this.events.append("turn.failed", turn.sessionId, {
      turnId: turn.id,
      error: message,
      kind: details.kind,
    })
    this.bus.publish(turn.id, { type: "error", message, kind: details.kind })
    this.bus.publish(turn.id, { type: "done", status: "failed" })
  }
}
