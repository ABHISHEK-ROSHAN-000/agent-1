import { sha256 } from "../core/ids"
import { nowIso } from "../core/time"
import type { Logger } from "../core/log"
import type { Database, NewPermissionRule } from "../db/database"
import type {
  Approval,
  ApprovalStatus,
  AuditEntry,
  PermissionRule,
  RuleEffect,
  ToolRisk,
} from "../shared/types"
import { toolRisk } from "../agent/tools"

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
}

export interface PermissionContext {
  readonly action?: string
  readonly risk?: ToolRisk
  readonly resource?: string
  readonly inGrant?: boolean
  readonly sensitive?: boolean
}

export interface ApprovalRequest {
  readonly turnId: string
  readonly sessionId: string
  readonly toolCallId: string
  readonly toolName: string
  readonly arguments: unknown
  readonly ruleId?: string | null
  readonly resource?: string
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
  constructor(
    private readonly db: Database,
    private readonly logger: Logger,
  ) {}

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

  async evaluate(
    toolName: string,
    toolArguments: unknown,
    context: PermissionContext = {},
  ): Promise<PermissionDecision> {
    const action = context.action ?? (toolName.includes(".") ? toolName : `tool.${toolName}`)
    const resource = context.resource ?? "*"
    const risk = context.risk ?? toolRisk(toolName)
    if (context.sensitive) {
      return { effect: "deny", ruleId: null, risk, reason: "Protected path" }
    }
    if (risk === "unknown") {
      return { effect: "deny", ruleId: null, risk, reason: "Unknown tool default" }
    }
    const rules = (await this.db.listPermissionRules()).filter((rule) => active(rule))
    const matching = rules.filter(
      (rule) => globMatches(rule.action, action) && globMatches(rule.resource, resource),
    )
    const deny = matching.find((rule) => rule.effect === "deny")
    const allow = matching.find((rule) => rule.effect === "allow")
    const ask = matching.find((rule) => rule.effect === "ask")
    if (deny) {
      return { effect: "deny", ruleId: deny.id, risk, reason: deny.note ?? "Denied by rule" }
    }
    if (allow) {
      return { effect: "allow", ruleId: allow.id, risk, reason: allow.note ?? "Allowed by rule" }
    }
    if (ask) {
      return { effect: "ask", ruleId: ask.id, risk, reason: ask.note ?? "Approval required" }
    }
    if (risk === "read" && context.inGrant) {
      return { effect: "allow", ruleId: null, risk, reason: "Read inside granted workspace" }
    }
    if (risk === "external") {
      return { effect: "allow", ruleId: null, risk, reason: "External read default" }
    }
    void toolArguments
    return { effect: "ask", ruleId: null, risk, reason: "Risk-class default" }
  }

  async requestApproval(input: ApprovalRequest): Promise<Approval> {
    const existing = await this.db.findApproval(input.turnId, input.toolCallId)
    if (existing) return existing
    const ttlRaw = await this.db.getSetting(APPROVAL_TTL_SETTING)
    const ttl = Number(ttlRaw ?? process.env.AGENT1_APPROVAL_TTL_SECONDS ?? "900")
    const seconds = Number.isFinite(ttl) && ttl > 0 ? ttl : 900
    const expiresAt = new Date(Date.now() + seconds * 1000).toISOString()
    const approval = await this.db.createApproval({
      turnId: input.turnId,
      sessionId: input.sessionId,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      arguments: input.arguments,
      argumentsHash: argumentsHash(input.arguments),
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
    } = {},
  ): Promise<Approval> {
    const approval = await this.db.getApproval(id)
    if (!approval) throw new PermissionError(404, "approval_not_found", "Approval not found")
    if (approval.status !== "pending") {
      throw new PermissionError(409, "approval_not_pending", `Approval is already ${approval.status}`)
    }
    if (Date.parse(approval.expiresAt) <= Date.now()) {
      await this.db.decideApproval(id, "expired", "system", "Approval expired")
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
    const updated = await this.db.decideApproval(
      id,
      nextStatus,
      options.decidedBy ?? "user",
      options.reason ?? null,
    )
    if (!updated) throw new PermissionError(409, "approval_not_pending", "Approval was already decided")
    await this.audit({
      actor: options.decidedBy ?? "user",
      action: decision === "approve" ? "approval.approved" : "approval.rejected",
      resource: `tool.${approval.toolName}`,
      decision: nextStatus,
      approvalId: id,
      turnId: approval.turnId,
      details: options.reason ? { reason: options.reason } : {},
    })
    this.logger.info("approval.decided", { approvalId: id, status: nextStatus })
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
    const ids = await this.db.expireApprovals()
    for (const id of ids) {
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
