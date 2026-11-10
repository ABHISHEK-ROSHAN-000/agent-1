import { readdirSync, statSync } from "node:fs"
import path from "node:path"
import { z } from "zod"
import type { AppConfig } from "../core/config"
import { PHASE, PRODUCT_NAME } from "../core/config"
import { newRequestId } from "../core/ids"
import type { Logger } from "../core/log"
import { nowPlusSeconds } from "../core/time"
import type { Database } from "../db/database"
import type { EventService } from "../events/service"
import type { ApprovalStatus, AuthContext } from "../shared/types"
import { AuthService, SESSION_TTL_SECONDS } from "../auth/auth-service"
import type { ModelService } from "../models/model-service"
import { ModelProfileError } from "../models/model-service"
import type { TurnService } from "../agent/turn-service"
import type { TurnBus } from "../agent/turn-bus"
import type { PermissionService } from "../permissions/permission-service"
import { PermissionError } from "../permissions/permission-service"
import type { ToolService } from "../tools/tool-service"
import type { WorkspaceService } from "../tools/workspace-service"
import { WorkspaceError } from "../tools/workspace-service"
import type { JournalService } from "../tools/journal-service"
import { JournalError } from "../tools/journal-service"
import { createTurnStream } from "./turn-stream"
import { serveWeb } from "./static"
import {
  clearSessionCookie,
  errorResponse,
  htmlResponse,
  HttpError,
  isHostAllowed,
  isOriginAllowed,
  jsonResponse,
  parseCookies,
  readJson,
  sessionCookie,
} from "./http"
import { openApiDocument } from "./openapi"
import { createEventStream } from "./sse"

const loginSchema = z.object({
  password: z.string().min(1).max(4096),
})

const createSessionSchema = z.object({
  title: z.string().trim().min(1).max(200).optional(),
})

const createMessageSchema = z.object({
  content: z.string().min(1).max(100_000),
  modelProfileId: z.string().optional(),
})

const modelProfileSchema = z.object({
  name: z.string().min(1).max(80),
  kind: z.enum(["cloud", "local"]),
  baseUrl: z.string().min(1).max(2_000),
  modelId: z.string().min(1).max(200),
  contextWindow: z.number().int().positive().optional(),
  maxOutputTokens: z.number().int().positive().optional(),
  costInputPerMillion: z.number().min(0).optional(),
  costOutputPerMillion: z.number().min(0).optional(),
  apiKey: z.string().max(10_000).optional(),
})

const updateModelProfileSchema = modelProfileSchema.partial().extend({
  supportsTools: z.boolean().optional(),
})

const ruleSchema = z.object({
  action: z.string().min(1).max(200),
  resource: z.string().min(1).max(500),
  effect: z.enum(["allow", "ask", "deny"]),
  position: z.number().int().min(0).max(1_000_000).optional(),
  ttlSeconds: z.number().int().positive().nullable().optional(),
  note: z.string().max(500).nullable().optional(),
})

const approvalDecisionSchema = z.object({
  decision: z.enum(["approve", "reject"]),
  reason: z.string().max(2_000).optional(),
  arguments: z.unknown().optional(),
})

const workspaceSchema = z.object({
  path: z.string().min(1).max(4_000),
  label: z.string().min(1).max(100).optional(),
  access: z.enum(["read", "write"]).optional(),
})

const journalUndoSchema = z.object({ batchId: z.string().min(1).optional() })

const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60

function workspaceFilePaths(root: string, limit = 5_000, maxDepth = 12): string[] {
  const files: string[] = []
  const walk = (directory: string, depth: number) => {
    if (files.length >= limit || depth > maxDepth) return
    let entries
    try {
      entries = readdirSync(directory, { withFileTypes: true }).sort((left, right) => left.name.localeCompare(right.name))
    } catch {
      return
    }
    for (const entry of entries) {
      if (files.length >= limit) return
      if (entry.name === ".git" || entry.name === "node_modules") continue
      const full = path.join(directory, entry.name)
      if (entry.isSymbolicLink()) continue
      if (entry.isDirectory()) {
        walk(full, depth + 1)
        continue
      }
      if (!entry.isFile()) continue
      try {
        if (!statSync(full).isFile()) continue
      } catch {
        continue
      }
      files.push(path.relative(root, full).split(path.sep).join("/"))
    }
  }
  walk(root, 0)
  return files
}

export interface AppDependencies {
  readonly config: AppConfig
  readonly db: Database
  readonly auth: AuthService
  readonly events: EventService
  readonly models: ModelService
  readonly turns: TurnService
  readonly turnBus: TurnBus
  readonly permissions: PermissionService
  readonly workspace: WorkspaceService
  readonly journal: JournalService
  readonly tools: ToolService
  readonly logger: Logger
  readonly startedAt: number
  readonly shutdown: (reason: string) => void | Promise<void>
}

function pairingPage(message: string): string {
  return `<!doctype html>
<html lang="en">
<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Agent-1 pairing</title></head>
<body style="font-family: system-ui, sans-serif; max-width: 42rem; margin: 4rem auto; padding: 0 1rem;">
<h1>Agent-1 pairing</h1>
<p>${message}</p>
</body>
</html>`
}

function issueHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) return error
  if (error instanceof ModelProfileError) {
    return new HttpError(400, "model_profile_error", error.message)
  }
  if (error instanceof PermissionError) {
    return new HttpError(error.status, error.code, error.message)
  }
  if (error instanceof WorkspaceError) {
    return new HttpError(400, "workspace_error", error.message)
  }
  if (error instanceof JournalError) {
    return new HttpError(409, "journal_error", error.message)
  }
  return new HttpError(500, "internal_error", "Internal server error")
}

function validationMessage(result: z.ZodSafeParseResult<unknown>): string {
  if (result.success) return ""
  return result.error.issues.map((issue) => issue.message).join("; ")
}

export class App {
  private readonly config: AppConfig
  private readonly db: Database
  private readonly auth: AuthService
  private readonly events: EventService
  private readonly models: ModelService
  private readonly turns: TurnService
  private readonly turnBus: TurnBus
  private readonly permissions: PermissionService
  private readonly workspace: WorkspaceService
  private readonly journal: JournalService
  private readonly tools: ToolService
  private readonly logger: Logger
  private readonly startedAt: number
  private readonly shutdown: (reason: string) => void | Promise<void>

  constructor(dependencies: AppDependencies) {
    this.config = dependencies.config
    this.db = dependencies.db
    this.auth = dependencies.auth
    this.events = dependencies.events
    this.models = dependencies.models
    this.turns = dependencies.turns
    this.turnBus = dependencies.turnBus
    this.permissions = dependencies.permissions
    this.workspace = dependencies.workspace
    this.journal = dependencies.journal
    this.tools = dependencies.tools
    this.logger = dependencies.logger
    this.startedAt = dependencies.startedAt
    this.shutdown = dependencies.shutdown
  }

  readonly fetch = async (request: Request): Promise<Response> => {
    const requestId = newRequestId()
    const started = performance.now()
    const url = new URL(request.url)
    let response: Response
    try {
      if (!isHostAllowed(request.headers.get("host"), this.config.allowedHosts)) {
        throw new HttpError(403, "host_not_allowed", "Host header is not allowed")
      }
      response = await this.route(request, url, requestId)
    } catch (error) {
      const httpError = issueHttpError(error)
      if (httpError.status >= 500) {
        this.logger.error("http.failed", {
          requestId,
          method: request.method,
          path: url.pathname,
          error: error instanceof Error ? error.message : String(error),
        })
      }
      response = errorResponse(
        httpError.status,
        httpError.code,
        httpError.message,
        requestId,
        httpError.headers,
      )
    }

    response.headers.set("x-request-id", requestId)
    this.logger.info("http.request", {
      requestId,
      method: request.method,
      path: url.pathname,
      status: response.status,
      durationMs: Math.round(performance.now() - started),
    })
    return response
  }

  private async route(request: Request, url: URL, requestId: string): Promise<Response> {
    const path = url.pathname
    const method = request.method.toUpperCase()

    if (path === "/v1/health" && method === "GET") {
      const eventSeq = await this.events.latestSeq()
      return jsonResponse({
        status: "ok",
        product: PRODUCT_NAME,
        version: this.config.version,
        phase: PHASE,
        uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
        eventSeq,
      })
    }

    if (path === "/v1/info" && method === "GET") {
      await this.requireAuth(request)
      const eventSeq = await this.events.latestSeq()
      return jsonResponse({
        status: "ok",
        product: PRODUCT_NAME,
        version: this.config.version,
        phase: PHASE,
        uptimeSeconds: Math.floor((Date.now() - this.startedAt) / 1000),
        eventSeq,
        dataDir: this.config.dataDir,
        capabilities: [
          "auth",
          "sessions",
          "events",
          "pairing",
          "openapi",
          "model-profiles",
          "turns",
          "streaming",
          "permissions",
          "approvals",
          "audit",
          "workspaces",
          "journal",
          "tools",
        ],
      })
    }

    if (path === "/v1/auth/login" && method === "POST") {
      return this.login(request, requestId)
    }

    if (path === "/v1/auth/logout" && method === "POST") {
      const auth = await this.requireAuth(request)
      await this.auth.logout(auth.sessionId)
      await this.events.append("auth.logout", null, {})
      return jsonResponse(
        { ok: true },
        200,
        { "set-cookie": clearSessionCookie(this.config.secureCookies) },
      )
    }

    if (path === "/v1/auth/pair" && method === "POST") {
      await this.requireAuth(request)
      const pairing = await this.auth.createPairingToken()
      const pairUrl = `${url.origin}/pair?token=${encodeURIComponent(pairing.token)}`
      await this.events.append("auth.pair_created", null, { expiresAt: pairing.expiresAt })
      return jsonResponse({ url: pairUrl, expiresAt: pairing.expiresAt })
    }

    if (path === "/v1/auth/rotate" && method === "POST") {
      await this.requireAuth(request)
      const password = await this.auth.rotatePassword()
      await this.events.append("auth.password_rotated", null, {})
      return jsonResponse(
        { password },
        200,
        { "set-cookie": clearSessionCookie(this.config.secureCookies) },
      )
    }

    if (path === "/pair" && method === "GET") {
      return this.pair(request, url)
    }

    if (path === "/v1/tools" && method === "GET") {
      await this.requireAuth(request)
      return jsonResponse({ tools: this.tools.list() })
    }

    if (path === "/v1/workspaces" && method === "GET") {
      await this.requireAuth(request)
      return jsonResponse({ workspaces: await this.workspace.list() })
    }

    if (path === "/v1/workspaces" && method === "POST") {
      await this.requireAuth(request)
      const parsed = workspaceSchema.safeParse(await readJson(request))
      if (!parsed.success) throw new HttpError(400, "invalid_body", validationMessage(parsed))
      return jsonResponse({ workspace: await this.workspace.add(parsed.data) }, 201)
    }

    const workspaceMatch = /^\/v1\/workspaces\/([^/]+)$/.exec(path)
    if (workspaceMatch && method === "DELETE") {
      await this.requireAuth(request)
      const removed = await this.workspace.remove(decodeURIComponent(workspaceMatch[1] ?? ""))
      if (!removed) throw new HttpError(404, "workspace_not_found", "Workspace not found")
      return jsonResponse({ ok: true })
    }

    const workspaceFileMatch = /^\/v1\/workspaces\/([^/]+)\/(tree|file)$/.exec(path)
    if (workspaceFileMatch && method === "GET") {
      await this.requireAuth(request)
      const id = decodeURIComponent(workspaceFileMatch[1] ?? "")
      const kind = workspaceFileMatch[2]
      const workspace = await this.db.getWorkspace(id)
      if (!workspace) throw new HttpError(404, "workspace_not_found", "Workspace not found")
      const requested = url.searchParams.get("path") ?? workspace.path
      const resolved = await this.workspace.requireInsideGrant(requested, workspace.path)
      if (kind === "tree" && url.searchParams.get("recursive") === "1") {
        return jsonResponse({
          root: workspace.path,
          paths: workspaceFilePaths(workspace.path),
        })
      }
      if (kind === "tree") {
        return jsonResponse(await this.tools.execute("fs_list", { path: resolved }, {}))
      }
      if (!url.searchParams.get("path")) {
        throw new HttpError(400, "path_required", "A file path is required")
      }
      return jsonResponse(await this.tools.execute("fs_read", { path: resolved }, {}))
    }

    const contextMatch = /^\/v1\/sessions\/([^/]+)\/context$/.exec(path)
    if (contextMatch && method === "GET") {
      await this.requireAuth(request)
      const id = decodeURIComponent(contextMatch[1] ?? "")
      const session = await this.db.getSession(id)
      if (!session) throw new HttpError(404, "session_not_found", "Session not found")
      const [turns, messages, model] = await Promise.all([
        this.db.listTurns(id, 100),
        this.db.getSessionMessages(id, 500),
        session.modelProfileId ? this.models.get(session.modelProfileId) : Promise.resolve(null),
      ])
      return jsonResponse({
        session,
        model,
        messages: messages.length,
        turns: turns.length,
        inputTokens: turns.reduce((sum, turn) => sum + turn.inputTokens, 0),
        outputTokens: turns.reduce((sum, turn) => sum + turn.outputTokens, 0),
        costUsd: turns.reduce((sum, turn) => sum + turn.costUsd, 0),
        lastActivity: turns[0]?.updatedAt ?? session.updatedAt,
        contextWindow: model?.contextWindow ?? null,
      })
    }

    if (path === "/v1/journal" && method === "GET") {
      await this.requireAuth(request)
      const limitRaw = url.searchParams.get("limit")
      const limit = limitRaw ? Math.min(500, Math.max(1, Number(limitRaw) || 100)) : 100
      return jsonResponse({ entries: await this.journal.list(limit) })
    }

    if (path === "/v1/journal/undo" && method === "POST") {
      await this.requireAuth(request)
      const parsed = journalUndoSchema.safeParse(await readJson(request))
      if (!parsed.success) throw new HttpError(400, "invalid_body", validationMessage(parsed))
      const batchId = parsed.data.batchId ?? (await this.journal.latestBatchId())
      if (!batchId) throw new HttpError(404, "journal_empty", "No journal batch to undo")
      return jsonResponse(await this.journal.undoBatch(batchId))
    }

    const journalMatch = /^\/v1\/journal\/([^/]+)$/.exec(path)
    if (journalMatch && method === "GET") {
      await this.requireAuth(request)
      const entry = await this.journal.get(decodeURIComponent(journalMatch[1] ?? ""))
      if (!entry) throw new HttpError(404, "journal_not_found", "Journal entry not found")
      return jsonResponse({ entry })
    }

    if (path === "/v1/rules" && method === "GET") {
      await this.requireAuth(request)
      return jsonResponse({ rules: await this.permissions.listRules() })
    }

    if (path === "/v1/rules" && method === "POST") {
      await this.requireAuth(request)
      const parsed = ruleSchema.safeParse(await readJson(request))
      if (!parsed.success) throw new HttpError(400, "invalid_body", validationMessage(parsed))
      return jsonResponse({ rule: await this.permissions.createRule(parsed.data) }, 201)
    }

    const ruleMatch = /^\/v1\/rules\/([^/]+)$/.exec(path)
    if (ruleMatch) {
      await this.requireAuth(request)
      const id = decodeURIComponent(ruleMatch[1] ?? "")
      if (method === "PATCH") {
        const parsed = ruleSchema.partial().safeParse(await readJson(request))
        if (!parsed.success) throw new HttpError(400, "invalid_body", validationMessage(parsed))
        const rule = await this.permissions.updateRule(id, parsed.data)
        if (!rule) throw new HttpError(404, "rule_not_found", "Rule not found")
        return jsonResponse({ rule })
      }
      if (method === "DELETE") {
        const removed = await this.permissions.deleteRule(id)
        if (!removed) throw new HttpError(404, "rule_not_found", "Rule not found")
        return jsonResponse({ ok: true })
      }
      throw new HttpError(405, "method_not_allowed", "Method not allowed")
    }

    if (path === "/v1/approvals" && method === "GET") {
      await this.requireAuth(request)
      const rawStatus = url.searchParams.get("status")
      if (
        rawStatus &&
        rawStatus !== "pending" &&
        rawStatus !== "approved" &&
        rawStatus !== "rejected" &&
        rawStatus !== "expired" &&
        rawStatus !== "invalidated"
      ) {
        throw new HttpError(400, "invalid_status", "Invalid approval status")
      }
      const limitRaw = url.searchParams.get("limit")
      const limit = limitRaw ? Math.min(500, Math.max(1, Number(limitRaw) || 100)) : 100
      return jsonResponse({
        approvals: await this.permissions.listApprovals(
          (rawStatus as ApprovalStatus | null) ?? undefined,
          limit,
        ),
      })
    }

    const approvalMatch = /^\/v1\/approvals\/([^/]+)(?:\/decision)?$/.exec(path)
    if (approvalMatch) {
      await this.requireAuth(request)
      const id = decodeURIComponent(approvalMatch[1] ?? "")
      const isDecision = path.endsWith("/decision")
      if (!isDecision && method === "GET") {
        const approval = await this.permissions.getApproval(id)
        if (!approval) throw new HttpError(404, "approval_not_found", "Approval not found")
        return jsonResponse({ approval })
      }
      if (isDecision && method === "POST") {
        const parsed = approvalDecisionSchema.safeParse(await readJson(request))
        if (!parsed.success) throw new HttpError(400, "invalid_body", validationMessage(parsed))
        let approval
        try {
          approval = await this.permissions.decideApproval(id, parsed.data.decision, {
            decidedBy: "user",
            ...(parsed.data.reason ? { reason: parsed.data.reason } : {}),
            ...(parsed.data.arguments !== undefined ? { arguments: parsed.data.arguments } : {}),
          })
        } catch (error) {
          if (error instanceof PermissionError && error.code === "approval_expired") {
            const expired = await this.permissions.getApproval(id)
            if (expired?.status === "expired") void this.turns.resumeWaiting(expired.turnId)
          }
          throw error
        }
        void this.turns.resumeWaiting(approval.turnId).catch((error) => {
          this.logger.error("approval.resume_failed", {
            approvalId: approval.id,
            turnId: approval.turnId,
            error: error instanceof Error ? error.message : String(error),
          })
        })
        return jsonResponse({ approval })
      }
      throw new HttpError(405, "method_not_allowed", "Method not allowed")
    }

    if (path === "/v1/audit" && method === "GET") {
      await this.requireAuth(request)
      const limitRaw = url.searchParams.get("limit")
      const limit = limitRaw ? Math.min(500, Math.max(1, Number(limitRaw) || 100)) : 100
      return jsonResponse({ entries: await this.permissions.listAudit(limit) })
    }

    if (path === "/v1/model-profiles" && method === "GET") {
      await this.requireAuth(request)
      return jsonResponse({ profiles: await this.models.list() })
    }

    if (path === "/v1/model-profiles" && method === "POST") {
      await this.requireAuth(request)
      const parsed = modelProfileSchema.safeParse(await readJson(request))
      if (!parsed.success) throw new HttpError(400, "invalid_body", validationMessage(parsed))
      const profile = await this.models.create(parsed.data)
      return jsonResponse({ profile }, 201)
    }

    const modelProfileMatch = /^\/v1\/model-profiles\/([^/]+)(?:\/(test|default))?$/.exec(path)
    if (modelProfileMatch) {
      await this.requireAuth(request)
      const id = decodeURIComponent(modelProfileMatch[1] ?? "")
      const action = modelProfileMatch[2]
      if (action === "test" && method === "POST") {
        if (!(await this.models.get(id))) throw new HttpError(404, "model_not_found", "Model profile not found")
        const result = await this.models.test(id)
        return jsonResponse(result)
      }
      if (action === "default" && method === "POST") {
        await this.models.setDefault(id)
        const profile = await this.models.get(id)
        return jsonResponse({ ok: true, profile })
      }
      if (method === "PATCH" && !action) {
        const parsed = updateModelProfileSchema.safeParse(await readJson(request))
        if (!parsed.success) throw new HttpError(400, "invalid_body", validationMessage(parsed))
        const profile = await this.models.update(id, parsed.data)
        if (!profile) throw new HttpError(404, "model_not_found", "Model profile not found")
        return jsonResponse({ profile })
      }
      if (method === "DELETE" && !action) {
        const removed = await this.models.remove(id)
        if (!removed) throw new HttpError(404, "model_not_found", "Model profile not found")
        return jsonResponse({ ok: true })
      }
      throw new HttpError(405, "method_not_allowed", "Method not allowed")
    }

    const sessionMessagesMatch = /^\/v1\/sessions\/([^/]+)\/messages$/.exec(path)
    if (sessionMessagesMatch) {
      await this.requireAuth(request)
      const sessionId = decodeURIComponent(sessionMessagesMatch[1] ?? "")
      const session = await this.db.getSession(sessionId)
      if (!session) throw new HttpError(404, "session_not_found", "Session not found")
      if (method === "GET") {
        const limitRaw = new URL(request.url).searchParams.get("limit")
        const limit = limitRaw ? Math.min(500, Math.max(1, Number(limitRaw) || 100)) : 100
        return jsonResponse({ messages: await this.turns.listMessages(sessionId, limit) })
      }
      if (method === "POST") {
        const parsed = createMessageSchema.safeParse(await readJson(request))
        if (!parsed.success) throw new HttpError(400, "invalid_body", validationMessage(parsed))
        const result = await this.turns.startTurn(
          sessionId,
          parsed.data.content,
          parsed.data.modelProfileId,
        )
        return jsonResponse(
          {
            turn: result.turn,
            streamUrl: `/v1/turns/${encodeURIComponent(result.turn.id)}/stream`,
          },
          202,
        )
      }
      throw new HttpError(405, "method_not_allowed", "Method not allowed")
    }

    const turnMatch = /^\/v1\/turns\/([^/]+)(?:\/(stream|cancel))?$/.exec(path)
    if (turnMatch) {
      await this.requireAuth(request)
      const turnId = decodeURIComponent(turnMatch[1] ?? "")
      const action = turnMatch[2]
      if (action === "stream" && method === "GET") {
        const turn = await this.db.getTurn(turnId)
        if (!turn) throw new HttpError(404, "turn_not_found", "Turn not found")
        return createTurnStream(request, turnId, this.db, this.turnBus, this.logger)
      }
      if (action === "cancel" && method === "POST") {
        const turn = await this.turns.cancel(turnId)
        if (!turn) throw new HttpError(404, "turn_not_found", "Turn not found")
        return jsonResponse({ turn })
      }
      if (method === "GET" && !action) {
        const turn = await this.db.getTurn(turnId)
        if (!turn) throw new HttpError(404, "turn_not_found", "Turn not found")
        const messages = await this.turns.listMessages(turn.sessionId, 100)
        return jsonResponse({ turn, messages })
      }
      throw new HttpError(405, "method_not_allowed", "Method not allowed")
    }

    if (path === "/v1/sessions" && method === "GET") {
      await this.requireAuth(request)
      return jsonResponse({ sessions: await this.db.listSessions() })
    }

    if (path === "/v1/sessions" && method === "POST") {
      await this.requireAuth(request)
      return this.createSession(request, requestId)
    }

    if (path.startsWith("/v1/sessions/") && method === "GET") {
      await this.requireAuth(request)
      const id = decodeURIComponent(path.slice("/v1/sessions/".length))
      const session = await this.db.getSession(id)
      if (!session) throw new HttpError(404, "session_not_found", "Session not found")
      return jsonResponse({ session })
    }

    if (path === "/v1/events" && method === "GET") {
      await this.requireAuth(request)
      return createEventStream(request, this.events, this.logger)
    }

    if (path === "/v1/system/stop" && method === "POST") {
      await this.requireAuth(request)
      setTimeout(() => void this.shutdown("api"), 25)
      return jsonResponse({ ok: true })
    }

    if (path === "/v1/openapi.json" && method === "GET") {
      await this.requireAuth(request)
      return jsonResponse(openApiDocument)
    }

    if ((method === "GET" || method === "HEAD") && !path.startsWith("/v1/")) {
      return serveWeb(this.config.webRoot, path)
    }

    throw new HttpError(404, "not_found", "Not found")
  }

  private async login(request: Request, requestId: string): Promise<Response> {
    const body = await readJson(request)
    const parsed = loginSchema.safeParse(body)
    if (!parsed.success) {
      throw new HttpError(400, "invalid_body", validationMessage(parsed))
    }

    let token: { token: string; expiresAt: string } | null
    try {
      token = await this.auth.login(parsed.data.password)
    } catch (error) {
      if (error instanceof Error && error.message.startsWith("Too many login attempts")) {
        throw new HttpError(429, "rate_limited", error.message)
      }
      throw error
    }
    if (!token) {
      this.logger.warn("auth.login_failed", { requestId })
      throw new HttpError(401, "invalid_password", "Invalid password")
    }

    await this.events.append("auth.login", null, {})
    return jsonResponse(
      { ok: true, expiresAt: token.expiresAt },
      200,
      { "set-cookie": sessionCookie(token.token, SESSION_TTL_SECONDS, this.config.secureCookies) },
    )
  }

  private async pair(request: Request, url: URL): Promise<Response> {
    const token = url.searchParams.get("token")
    if (!token) return htmlResponse(pairingPage("Missing pairing token."), 400)
    const session = await this.auth.consumePairingToken(token)
    if (!session) return htmlResponse(pairingPage("This pairing link is invalid, expired, or already used."), 400)
    await this.events.append("auth.paired", null, {})
    return new Response(null, {
      status: 303,
      headers: {
        location: "/",
        "set-cookie": sessionCookie(session.token, SESSION_TTL_SECONDS, this.config.secureCookies),
      },
    })
  }

  private async createSession(request: Request, requestId: string): Promise<Response> {
    const idempotencyKey = request.headers.get("idempotency-key")
    if (idempotencyKey) {
      const existing = await this.db.getIdempotency(idempotencyKey)
      if (existing) {
        if (existing.expiresAt <= new Date().toISOString()) {
          // Expired entries are treated as absent.
        } else if (
          existing.method !== request.method ||
          existing.path !== new URL(request.url).pathname
        ) {
          throw new HttpError(409, "idempotency_conflict", "Idempotency key was used for another request")
        } else {
          return new Response(existing.response, {
            status: existing.status,
            headers: { "content-type": "application/json; charset=utf-8" },
          })
        }
      }
    }

    const body = await readJson(request)
    const parsed = createSessionSchema.safeParse(body)
    if (!parsed.success) {
      throw new HttpError(400, "invalid_body", validationMessage(parsed))
    }
    const created = await this.db.createSession(parsed.data.title ?? "New session")
    this.events.publish(created.event)
    const payload = JSON.stringify({ session: created.session })
    if (idempotencyKey) {
      await this.db.setIdempotency(
        idempotencyKey,
        request.method,
        new URL(request.url).pathname,
        201,
        payload,
        nowPlusSeconds(IDEMPOTENCY_TTL_SECONDS),
      )
    }
    this.logger.info("session.created", { requestId, sessionId: created.session.id })
    return new Response(payload, {
      status: 201,
      headers: {
        "content-type": "application/json; charset=utf-8",
        "cache-control": "no-store",
      },
    })
  }

  private async requireAuth(request: Request): Promise<AuthContext> {
    const auth = await this.authenticate(request)
    if (!auth) {
      throw new HttpError(401, "unauthorized", "Authentication required", {
        "www-authenticate": 'Basic realm="Agent-1"',
      })
    }
    if (
      auth.kind === "cookie" &&
      request.method.toUpperCase() !== "GET" &&
      !isOriginAllowed(request.headers.get("origin"), this.config.allowedHosts)
    ) {
      throw new HttpError(403, "origin_not_allowed", "Origin is not allowed")
    }
    return auth
  }

  private async authenticate(request: Request): Promise<AuthContext | null> {
    const authorization = request.headers.get("authorization")
    if (authorization?.startsWith("Basic ")) {
      try {
        const decoded = Buffer.from(authorization.slice(6), "base64").toString("utf8")
        const separator = decoded.indexOf(":")
        if (separator > 0) {
          const username = decoded.slice(0, separator)
          const password = decoded.slice(separator + 1)
          if (username === this.config.authUsername && (await this.auth.verifyPassword(password))) {
            return { kind: "basic", sessionId: null }
          }
        }
      } catch {
        return null
      }
    }

    const cookies = parseCookies(request.headers.get("cookie"))
    const token = cookies.agent1_session
    if (token) {
      const session = await this.auth.verifySessionToken(token)
      if (session) return { kind: "cookie", sessionId: session.sessionId }
    }
    return null
  }
}
