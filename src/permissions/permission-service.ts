import { sha256 } from "../core/ids"
import { nowIso } from "../core/time"
import type { Logger } from "../core/log"
import type { Database, NewPermissionRule } from "../db/database"
import type { EventService } from "../events/service"
import type {
  Approval,
  ApprovalMode,
  ApprovalScope,
  ApprovalStatus,
  AuditEntry,
  PermissionRule,
  RuleEffect,
  ToolRisk,
} from "../shared/types"
import { toolRisk } from "../agent/tools"
import {
  commandPatternKey,
  dangerousCommand,
  hardlineCommand,
  matchesAllowlist,
  parseStringList,
} from "../approvals/command-safety"
import type { SmartJudgeFunction, SmartVerdict } from "../approvals/smart-judge"
import { redactCommand, redactForDisplay } from "../approvals/redaction"

export const APPROVAL_TTL_SETTING = "approval.default_ttl_seconds"

export class PermissionError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = "PermissionError"
  }
}

export interface PermissionDecision {
  readonly effect: RuleEffect
  readonly ruleId: string | null
  readonly risk: ToolRisk
  readonly reason: string
  readonly action: string
  readonly resource: string
  readonly patternKey: string
  readonly displayCommand?: string | null
  readonly smart?: SmartVerdict
}

export interface PermissionContext {
  readonly action?: string
  readonly risk?: ToolRisk
  readonly resource?: string
  readonly sensitive?: boolean
  readonly protectedInstruction?: boolean
  readonly sessionId?: string
  readonly command?: string
  readonly cwd?: string
}

export interface ApprovalRequest {
  readonly turnId: string
  readonly sessionId: string
  readonly toolCallId: string
  readonly toolName: string
  readonly action: string
  readonly resource: string
  readonly patternKey: string
  readonly displayCommand?: string | null
  readonly arguments: unknown
  readonly ruleId?: string | null
}

export interface ApprovalConfig {
  readonly mode: ApprovalMode
  readonly timeoutSeconds: number
  readonly deny: readonly string[]
  readonly allowlist: readonly string[]
  readonly writeSafeRoot: string | null
  readonly smartModel: string | null
}

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null"
  if (Array.isArray(value)) return `[${value.map((entry) => canonicalJson(entry)).join(",")}]`
  const record = value as Record<string, unknown>
  return `{${Object.keys(record)
    .sort()
    .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
    .join(",")}}`
}

export function argumentsHash(value: unknown): string {
  return sha256(canonicalJson(value))
}

function globMatches(pattern: string, value: string): boolean {
  const expression = pattern
    .replace(/[.+^${}()|[\]\\]/g, "\\$&")
    .replace(/\*/g, ".*")
    .replace(/\?/g, ".")
  return new RegExp(`^${expression}$`, "i").test(value)
}

function active(rule: PermissionRule, now = Date.now()): boolean {
  return !rule.expiresAt || Date.parse(rule.expiresAt) > now
}

export class PermissionService {
  private smartJudge?: SmartJudgeFunction

  constructor(
    private readonly db: Database,
    private readonly logger: Logger,
    private readonly events?: EventService,
  ) {}

  setSmartJudge(judge: SmartJudgeFunction): void {
    this.smartJudge = judge
  }

  async listRules(): Promise<PermissionRule[]> {
    return this.db.listPermissionRules()
  }

  async createRule(input: NewPermissionRule): Promise<PermissionRule> {
    if (!input.action.trim()) throw new PermissionError(400, "invalid_rule", "Action is required")
    if (!input.resource.trim()) throw new PermissionError(400, "invalid_rule", "Resource is required")
    if (input.ttlSeconds !== undefined && input.ttlSeconds !== null && input.ttlSeconds <= 0) {
      throw new PermissionError(400, "invalid_rule", "TTL must be positive")
    }
    const rule = await this.db.createPermissionRule(input)
    await this.audit({
      actor: "user",
      action: "rule.created",
      resource: `${rule.action} ${rule.resource}`,
      decision: rule.effect,
      ruleId: rule.id,
      details: { position: rule.position },
    })
    return rule
  }

  async updateRule(id: string, input: Partial<NewPermissionRule>): Promise<PermissionRule | null> {
    const rule = await this.db.updatePermissionRule(id, input)
    if (!rule) return null
    await this.audit({
      actor: "user",
      action: "rule.updated",
      resource: `${rule.action} ${rule.resource}`,
      decision: rule.effect,
      ruleId: rule.id,
      details: { position: rule.position },
    })
    return rule
  }

  async deleteRule(id: string): Promise<boolean> {
    const rule = await this.db.getPermissionRule(id)
    if (!rule) return false
    await this.db.deletePermissionRule(id)
    await this.audit({
      actor: "user",
      action: "rule.deleted",
      resource: `${rule.action} ${rule.resource}`,
      decision: rule.effect,
      ruleId: rule.id,
    })
    return true
  }

  async config(): Promise<ApprovalConfig> {
    const modeRaw = await this.db.getSetting("approval.mode")
    const mode: ApprovalMode =
      modeRaw === "manual" || modeRaw === "off" || modeRaw === "smart" ? modeRaw : "smart"
    const timeoutRaw = Number(await this.db.getSetting("approval.timeout_seconds"))
    const timeoutSeconds =
      Number.isFinite(timeoutRaw) && timeoutRaw > 0 ? Math.floor(timeoutRaw) : 300
    const deny = parseStringList(await this.db.getSetting("approval.deny"))
    const allowlist = parseStringList(await this.db.getSetting("approval.allowlist"))
    const writeSafeRoot = (await this.db.getSetting("approval.write_safe_root"))?.trim() || null
    const smartModel = (await this.db.getSetting("approval.smart_model"))?.trim() || null
    return { mode, timeoutSeconds, deny, allowlist, writeSafeRoot, smartModel }
  }

  async setConfig(input: Partial<ApprovalConfig>): Promise<ApprovalConfig> {
    if (input.mode !== undefined) {
      if (input.mode !== "smart" && input.mode !== "manual" && input.mode !== "off") {
        throw new PermissionError(400, "invalid_approval_mode", "Approval mode must be smart, manual, or off")
      }
      await this.db.setSetting("approval.mode", input.mode)
    }
    if (input.timeoutSeconds !== undefined) {
      if (!Number.isFinite(input.timeoutSeconds) || input.timeoutSeconds <= 0) {
        throw new PermissionError(400, "invalid_approval_timeout", "Approval timeout must be positive")
      }
      await this.db.setSetting("approval.timeout_seconds", String(Math.floor(input.timeoutSeconds)))
    }
    if (input.deny !== undefined) await this.db.setSetting("approval.deny", JSON.stringify(input.deny))
    if (input.allowlist !== undefined) {
      await this.db.setSetting("approval.allowlist", JSON.stringify(input.allowlist))
    }
    if (input.writeSafeRoot !== undefined) {
      await this.db.setSetting("approval.write_safe_root", input.writeSafeRoot ?? "")
    }
    if (input.smartModel !== undefined) {
      await this.db.setSetting("approval.smart_model", input.smartModel ?? "")
    }
    return this.config()
  }

  async evaluate(
    toolName: string,
    toolArguments: unknown,
    context: PermissionContext = {},
  ): Promise<PermissionDecision> {
    const action = context.action ?? (toolName.includes(".") ? toolName : `tool.${toolName}`)
    const resource = context.resource ?? "*"
    const risk = context.risk ?? toolRisk(toolName)
    const config = await this.config()
    const record = toolArguments && typeof toolArguments === "object" ? (toolArguments as Record<string, unknown>) : {}
    const command = context.command ?? (typeof record.command === "string" ? record.command : undefined)
    const cwd = context.cwd ?? (typeof record.cwd === "string" ? record.cwd : undefined)
    const patternKey = command ? commandPatternKey(command, cwd) : resource
    const displayCommand = command ? redactCommand(command) : null
    const result = (effect: RuleEffect, reason: string, ruleId: string | null = null, smart?: SmartVerdict): PermissionDecision => ({
      effect,
      ruleId,
      risk,
      reason,
      action,
      resource,
      patternKey,
      displayCommand,
      ...(smart ? { smart } : {}),
    })

    if (context.sensitive) return result("deny", "Protected path")
    if (risk === "unknown") return result("deny", "Unknown tool default")

    const fileWrite = action === "fs.write" || action === "fs.mkdir" || action === "fs.apply_moves"

    const rules = (await this.db.listPermissionRules()).filter((rule) => active(rule))
    const matching = rules.filter(
      (rule) => globMatches(rule.action, action) && globMatches(rule.resource, resource),
    )
    const denyRule = matching.find((rule) => rule.effect === "deny")
    const allowRule = matching.find((rule) => rule.effect === "allow")
    const askRule = matching.find((rule) => rule.effect === "ask")
    if (denyRule) return result("deny", denyRule.note ?? "Denied by rule", denyRule.id)
    if (risk === "shell" || action === "shell.exec") {
      if (command) {
        const hardline = hardlineCommand(command)
        if (hardline) return result("deny", `Hardline block: ${hardline}`)
        const denied = matchesAllowlist(command, config.deny)
        if (denied) return result("deny", `Denied by approvals.deny: ${denied}`)
      }
    }
    const grant = await this.db.findApprovalGrant(context.sessionId ?? null, action, patternKey)
    if (grant) return result("allow", "Allowed by saved approval")
    if (fileWrite && context.protectedInstruction) {
      return result("ask", "Protected agent-instruction file")
    }
    if (allowRule) return result("allow", allowRule.note ?? "Allowed by rule", allowRule.id)

    // Reads run freely; path policy still blocks protected data.
    if (risk === "read" && action.startsWith("fs.")) {
      return result("allow", "Filesystem read allowed by Agent-1 path policy")
    }

    // File writes are checkpoint-first, not per-write approval prompts.
    if (fileWrite) return result("allow", "File write allowed by Agent-1 path policy")

    if (risk === "shell" || action === "shell.exec") {
      if (!command) return result("ask", "Shell command requires approval")
      const hardline = hardlineCommand(command)
      if (hardline) return result("deny", `Hardline block: ${hardline}`)
      const denied = matchesAllowlist(command, config.deny)
      if (denied) return result("deny", `Denied by approvals.deny: ${denied}`)
      const grant = await this.db.findApprovalGrant(context.sessionId ?? null, action, patternKey)
      if (grant) return result("allow", "Allowed by saved approval")
      const allowed = matchesAllowlist(command, config.allowlist)
      if (allowed) return result("allow", `Allowed by allowlist: ${allowed}`)
      if (config.mode === "off") return result("allow", "Approval mode off")
      const dangerous = dangerousCommand(command)
      if (!dangerous) return result("allow", "No dangerous command pattern matched")
      if (config.mode === "manual" || !this.smartJudge) {
        return result("ask", dangerous, askRule?.id ?? null)
      }
      const verdict = await this.smartJudge({ command, cwd, description: dangerous })
      if (verdict === "approve") return result("allow", `Smart approval: ${dangerous}`, null, verdict)
      if (verdict === "deny") return result("deny", `Smart denial: ${dangerous}`, null, verdict)
      return result("ask", `Smart approval escalated: ${dangerous}`, askRule?.id ?? null, verdict)
    }

    if (askRule) return result("ask", askRule.note ?? "Approval required", askRule.id)
    if (risk === "external") return result("allow", "External read default")
    return result("ask", "Risk-class default")
  }

  async requestApproval(input: ApprovalRequest): Promise<Approval> {
    const existing = await this.db.findApproval(input.turnId, input.toolCallId)
    if (existing) return existing
    const config = await this.config()
    const ttlRaw = await this.db.getSetting(APPROVAL_TTL_SETTING)
    const ttl = Number(ttlRaw ?? config.timeoutSeconds)
    const seconds = Number.isFinite(ttl) && ttl > 0 ? ttl : config.timeoutSeconds
    const expiresAt = new Date(Date.now() + seconds * 1000).toISOString()
    const approval = await this.db.createApproval({
      turnId: input.turnId,
      sessionId: input.sessionId,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      action: input.action,
      resource: input.resource,
      patternKey: input.patternKey,
      arguments: redactForDisplay(input.arguments),
      argumentsHash: argumentsHash(input.arguments),
      displayCommand: input.displayCommand ? redactCommand(input.displayCommand) : null,
      expiresAt,
    })
    await this.audit({
      actor: "agent",
      action: "approval.requested",
      resource: input.resource ?? `tool.${input.toolName}`,
      decision: "pending",
      ruleId: input.ruleId ?? null,
      approvalId: approval.id,
      turnId: input.turnId,
      details: { argumentsHash: approval.argumentsHash, expiresAt },
    })
    this.logger.info("approval.requested", {
      approvalId: approval.id,
      turnId: input.turnId,
      toolName: input.toolName,
    })
    return approval
  }

  async decideApproval(
    id: string,
    decision: "approve" | "reject",
    options: {
      readonly decidedBy?: string
      readonly reason?: string
      readonly arguments?: unknown
      readonly scope?: ApprovalScope
    } = {},
  ): Promise<Approval> {
    const approval = await this.db.getApproval(id)
    if (!approval) throw new PermissionError(404, "approval_not_found", "Approval not found")
    if (approval.status !== "pending") {
      throw new PermissionError(409, "approval_not_pending", `Approval is already ${approval.status}`)
    }
    if (Date.parse(approval.expiresAt) <= Date.now()) {
      const expired = await this.db.decideApprovalWithEvent(
        id,
        "expired",
        "system",
        "Approval expired",
        null,
        {
          type: "approval.expired",
          sessionId: approval.sessionId,
          payload: {
            approvalId: id,
            turnId: approval.turnId,
            sessionId: approval.sessionId,
            toolCallId: approval.toolCallId,
            expiredAt: nowIso(),
          },
        },
      )
      if (expired) this.events?.publish(expired.event)
      await this.audit({
        actor: "system",
        action: "approval.expired",
        resource: `tool.${approval.toolName}`,
        decision: "expired",
        approvalId: id,
        turnId: approval.turnId,
      })
      throw new PermissionError(410, "approval_expired", "Approval expired")
    }
    if (
      options.arguments !== undefined &&
      argumentsHash(options.arguments) !== approval.argumentsHash
    ) {
      await this.audit({
        actor: options.decidedBy ?? "user",
        action: "approval.decision_rejected",
        resource: `tool.${approval.toolName}`,
        decision: "arguments_changed",
        approvalId: id,
        turnId: approval.turnId,
      })
      throw new PermissionError(
        409,
        "arguments_changed",
        "Approval arguments do not match the requested tool call",
      )
    }
    const nextStatus: ApprovalStatus = decision === "approve" ? "approved" : "rejected"
    const scope = decision === "approve" ? options.scope ?? "once" : null
    const decidedBy = options.decidedBy ?? "user"
    const decided = await this.db.decideApprovalWithEvent(
      id,
      nextStatus,
      decidedBy,
      options.reason ?? null,
      scope,
      {
        type: "approval.decided",
        sessionId: approval.sessionId,
        payload: {
          approvalId: id,
          turnId: approval.turnId,
          sessionId: approval.sessionId,
          toolCallId: approval.toolCallId,
          decision: nextStatus,
          scope,
          decidedBy,
        },
      },
    )
    if (!decided) throw new PermissionError(409, "approval_not_pending", "Approval was already decided")
    const updated = decided.approval
    this.events?.publish(decided.event)
    if (scope === "session" || scope === "always") {
      await this.db.createApprovalGrant({
        sessionId: scope === "session" ? approval.sessionId : null,
        scope,
        action: approval.action,
        resource: approval.resource,
        patternKey: approval.patternKey,
        expiresAt: null,
      })
    }
    await this.audit({
      actor: options.decidedBy ?? "user",
      action: decision === "approve" ? "approval.approved" : "approval.rejected",
      resource: `tool.${approval.toolName}`,
      decision: nextStatus,
      approvalId: id,
      turnId: approval.turnId,
      details: { ...(options.reason ? { reason: options.reason } : {}), scope },
    })
    this.logger.info("approval.decided", { approvalId: id, status: nextStatus, scope })
    return updated
  }

  async getApproval(id: string): Promise<Approval | null> {
    return this.db.getApproval(id)
  }

  async findApproval(turnId: string, toolCallId: string): Promise<Approval | null> {
    return this.db.findApproval(turnId, toolCallId)
  }

  async listApprovals(status?: ApprovalStatus, limit = 100): Promise<Approval[]> {
    return this.db.listApprovals(status, limit)
  }

  async expireApprovals(): Promise<string[]> {
    const events = await this.db.expireApprovalsWithEvents()
    const ids: string[] = []
    for (const event of events) {
      this.events?.publish(event)
      const payload = event.payload as { approvalId?: unknown }
      const id = typeof payload.approvalId === "string" ? payload.approvalId : null
      if (!id) continue
      ids.push(id)
      const approval = await this.db.getApproval(id)
      if (!approval) continue
      await this.audit({
        actor: "system",
        action: "approval.expired",
        resource: `tool.${approval.toolName}`,
        decision: "expired",
        approvalId: id,
        turnId: approval.turnId,
      })
    }
    return ids
  }

  async listApprovalGrants(limit = 200) {
    return this.db.listApprovalGrants(limit)
  }

  async deleteApprovalGrant(id: string): Promise<boolean> {
    return this.db.deleteApprovalGrant(id)
  }

  async listAudit(limit = 100): Promise<AuditEntry[]> {
    return this.db.listAudit(limit)
  }

  async audit(input: {
    actor: string
    action: string
    resource: string
    decision: string
    ruleId?: string | null
    approvalId?: string | null
    turnId?: string | null
    details?: unknown
  }): Promise<void> {
    await this.db.appendAudit(input)
  }

  now(): string {
    return nowIso()
  }
}
