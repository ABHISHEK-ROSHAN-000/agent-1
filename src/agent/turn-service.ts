import {
  generateText,
  stepCountIs,
  streamText,
  type ModelMessage,
} from "ai"
import type { Logger } from "../core/log"
import type { ModelService } from "../models/model-service"
import type { Database, NewMessage } from "../db/database"
import type { EventService } from "../events/service"
import type { Message, ModelProfile, Session, TokenUsage, Turn } from "../shared/types"
import { argumentsHash, type PermissionService } from "../permissions/permission-service"
import type { ToolService } from "../tools/tool-service"
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

function costFor(profile: ModelProfile, inputTokens: number, outputTokens: number): number {
  return (
    (inputTokens / 1_000_000) * profile.costInputPerMillion +
    (outputTokens / 1_000_000) * profile.costOutputPerMillion
  )
}

export class TurnService {
  private readonly active = new Map<string, AbortController>()
  private readonly maxSteps: number
  private readonly maxWallMs: number
  private readonly maxCostUsd: number

  constructor(
    private readonly db: Database,
    private readonly events: EventService,
    private readonly models: ModelService,
    private readonly permissions: PermissionService,
    private readonly tools: ToolService,
    private readonly bus: TurnBus,
    private readonly logger: Logger,
    options: TurnServiceOptions = {},
  ) {
    this.maxSteps = options.maxSteps ?? Number(process.env.AGENT1_TURN_MAX_STEPS ?? "8")
    this.maxWallMs = options.maxWallMs ?? Number(process.env.AGENT1_TURN_MAX_WALL_MS ?? "120000")
    this.maxCostUsd = options.maxCostUsd ?? Number(process.env.AGENT1_TURN_MAX_COST_USD ?? "0")
  }

  async startTurn(
    sessionId: string,
    content: string,
    modelProfileId?: string,
  ): Promise<{ turn: Turn; userMessage: Message }> {
    const session = await this.db.getSession(sessionId)
    if (!session) throw new Error("Session not found")
    const resolved = await this.models.resolve(modelProfileId ?? session.modelProfileId ?? undefined)
    if (!session.modelProfileId) {
      await this.db.setSessionModelProfile(sessionId, resolved.profile.id)
    }
    const created = await this.db.createTurnWithUserMessage(
      sessionId,
      resolved.profile.id,
      content,
    )
    this.bus.publish(created.turn.id, { type: "status", status: "queued" })
    await this.events.append("turn.started", sessionId, {
      turnId: created.turn.id,
      modelProfileId: resolved.profile.id,
    })
    void this.runTurn(created.turn.id, false)
    return created
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
      void this.runTurn(turn.id, true)
    }
  }

  async listMessages(sessionId: string, limit = 500): Promise<Message[]> {
    return this.db.getSessionMessages(sessionId, limit)
  }

  async resumeWaiting(turnId: string): Promise<void> {
    const turn = await this.db.getTurn(turnId)
    if (!turn || turn.status !== "waiting_approval") return
    await this.runTurn(turnId, true)
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
      const resolved = await this.models.resolve(turn.modelProfileId)
      let session = await this.db.getSession(turn.sessionId)
      if (!session) throw new Error("Session not found")

      const checkpoint = await this.db.getLatestCheckpoint(turnId)
      let state: CheckpointState
      if (checkpoint && this.isCheckpointState(checkpoint.state)) {
        state = checkpoint.state
      } else {
        const history = await this.buildHistory(session, resolved.profile)
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
          await this.db.saveTurnStep(turnId, {
            step: state.step,
            sessionId: turn.sessionId,
            messages: pending.newMessages,
            checkpoint: state,
            usage: state.usage,
            status: "running",
          })
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
          resolved.profile,
          resolved.apiKey,
          state.messages,
          controller.signal,
        )

        state = {
          step: state.step + 1,
          messages: [...state.messages, ...step.responseMessages],
          usage: {
            inputTokens: state.usage.inputTokens + step.usage.inputTokens,
            outputTokens: state.usage.outputTokens + step.usage.outputTokens,
            costUsd: costFor(
              resolved.profile,
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
          await this.db.saveTurnStep(turnId, {
            step: state.step,
            sessionId: session.id,
            messages: newMessages,
            checkpoint: state,
            usage: state.usage,
            status: "completed",
          })
          this.bus.publish(turnId, { type: "done", status: "completed" })
          await this.events.append("turn.completed", session.id, {
            turnId,
            inputTokens: state.usage.inputTokens,
            outputTokens: state.usage.outputTokens,
            costUsd: state.usage.costUsd,
          })
          return
        }

        const pendingCalls: PendingToolCall[] = []
        for (const call of step.toolCalls) {
          const permissionContext = await this.tools.permissionContext(call.toolName, call.input)
          const decision = await this.permissions.evaluate(call.toolName, call.input, {
            action: this.tools.action(call.toolName),
            risk: this.tools.risk(call.toolName),
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
              arguments: call.input,
              ruleId: decision.ruleId,
              resource: permissionContext.resource,
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

          const message = await this.executeToolCall(turnId, session.id, call)
          state = { ...state, messages: [...state.messages, message] }
          newMessages.push(this.newToolMessage(call, textFromMessage(message), message))
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

        await this.db.saveTurnStep(turnId, {
          step: state.step,
          sessionId: session.id,
          messages: newMessages,
          checkpoint: state,
          usage: state.usage,
          status: "running",
        })
        this.bus.publish(turnId, { type: "status", status: "running" })
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      const turn = await this.db.getTurn(turnId).catch(() => null)
      if (controller.signal.aborted || turn?.status === "cancelled") {
        await this.db.setTurnStatus(turnId, "cancelled").catch(() => {})
        this.bus.publish(turnId, { type: "done", status: "cancelled" })
      } else {
        this.logger.error("turn.failed", { turnId, error: message })
        if (turn) {
          await this.db.setTurnStatus(turnId, "failed", message).catch(() => {})
          await this.events.append("turn.failed", turn.sessionId, {
            turnId,
            error: message,
          }).catch(() => {})
        }
        this.bus.publish(turnId, { type: "error", message })
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
          await this.permissions.requestApproval({
            turnId: turn.id,
            sessionId: turn.sessionId,
            toolCallId: call.toolCallId,
            toolName: call.toolName,
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
          const message = await this.executeToolCall(turn.id, turn.sessionId, call)
          messages = [...messages, message]
          newMessages.push(this.newToolMessage(call, textFromMessage(message), message))
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
  ): Promise<ModelMessage> {
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
    return this.toolResultMessage(call, output)
  }

  private toolResultMessage(
    call: PendingToolCall,
    output: unknown,
    deniedReason?: string,
  ): ModelMessage {
    const result = deniedReason
      ? { type: "execution-denied" as const, reason: deniedReason }
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
    profile: ModelProfile,
    apiKey: string | undefined,
    messages: ModelMessage[],
    signal: AbortSignal,
  ): Promise<StepResult> {
    const model = this.models.createModel(profile, apiKey)
    const result = streamText({
      model,
      system: this.systemPrompt(session),
      messages,
      tools: this.tools.definitions(),
      stopWhen: stepCountIs(1),
      maxOutputTokens: profile.maxOutputTokens,
      temperature: 0,
      maxRetries: 0,
      abortSignal: signal,
    })

    for await (const part of result.fullStream) {
      if (part.type === "text-delta") {
        this.bus.publish(turnId, { type: "delta", text: part.text })
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
  }

  private async buildHistory(session: Session, profile: ModelProfile): Promise<ModelMessage[]> {
    const stored = await this.db.getSessionMessages(session.id, 500)
    const visible = stored.filter(
      (message) => !session.summaryThroughSeq || message.seq > session.summaryThroughSeq,
    )
    let messages = visible.map((message) => this.toModelMessage(message))
    if (tokenEstimate(messages) > Math.floor(profile.contextWindow * 0.7) && messages.length > 8) {
      const oldMessages = stored.slice(0, -6)
      const recentMessages = stored.slice(-6)
      const throughSeq = oldMessages[oldMessages.length - 1]?.seq
      if (throughSeq !== undefined) {
        const summary = await this.summarize(
          oldMessages.map((message) => message.text).filter(Boolean),
          profile,
          await this.models.resolve(profile.id),
        )
        await this.db.setSessionSummary(session.id, summary, throughSeq)
        messages = recentMessages.map((message) => this.toModelMessage(message))
      }
    }
    return messages
  }

  private async summarize(
    texts: string[],
    profile: ModelProfile,
    resolved: Awaited<ReturnType<ModelService["resolve"]>>,
  ): Promise<string> {
    const fallback = `Earlier conversation was compacted (${texts.length} messages).`
    try {
      const model = this.models.createModel(profile, resolved.apiKey)
      const result = await generateText({
        model,
        system:
          "Summarize the earlier conversation for use as context. Keep decisions, user preferences, open tasks, and facts. Be concise.",
        prompt: texts.join("\n\n").slice(0, 24_000),
        maxOutputTokens: 400,
        temperature: 0,
        maxRetries: 0,
        abortSignal: AbortSignal.timeout(20_000),
      })
      return result.text.trim() || fallback
    } catch {
      return fallback
    }
  }

  private systemPrompt(session: Session): string {
    const summary = session.summary ? `\n\nEarlier conversation summary:\n${session.summary}` : ""
    return [
      "You are Agent-1, a local personal assistant running on the user's Windows laptop.",
      "You can use the available tools. Writes and shell commands require explicit user approval.",
      `Available tools: ${this.tools.names().join(", ")}.`,
      "Use tools when they help. Do not claim a side effect or a tool result you did not receive.",
      "Be direct, concrete, and concise. Ask one clarifying question only when necessary.",
      summary,
    ].join(" ")
  }

  private toModelMessage(message: Message): ModelMessage {
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
    await this.db.setTurnStatus(turn.id, "failed", message)
    await this.events.append("turn.failed", turn.sessionId, { turnId: turn.id, error: message })
    this.bus.publish(turn.id, { type: "error", message })
    this.bus.publish(turn.id, { type: "done", status: "failed" })
  }
}
