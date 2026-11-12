import { z } from "zod"
import type { AppConfig } from "../core/config"
import { PHASE, PRODUCT_NAME } from "../core/config"
import { newRequestId } from "../core/ids"
import type { Logger } from "../core/log"
import { nowPlusSeconds } from "../core/time"
import { InboxConflictError, type Database } from "../db/database"
import type { EventService } from "../events/service"
import type { ApprovalStatus, AuthContext } from "../shared/types"
import { promptFileInputSchema, sessionRenameRequestSchema, settingsPatchSchema } from "../shared/contracts"
import { AuthService, SESSION_TTL_SECONDS } from "../auth/auth-service"
import type { ModelService } from "../models/model-service"
import type { ProviderService } from "../models/provider-service"
import { ProviderError } from "../models/provider-service"
import { EmptyPromptError, SessionDeletingError, TurnBusyError, type TurnService } from "../agent/turn-service"
import type { TurnBus } from "../agent/turn-bus"
import type { PermissionService } from "../permissions/permission-service"
import { PermissionError } from "../permissions/permission-service"
import type { ToolService } from "../tools/tool-service"
import { PathPolicyError } from "../tools/path-policy"
import type { CheckpointManager } from "../checkpoints/manager"
import { CheckpointError } from "../checkpoints/manager"
import type { SessionSearchService } from "../memory/session-search-service"
import type { MemoryService } from "../memory/memory-service"
import { MemoryError } from "../memory/types"
import type { RemoteService } from "../remote/remote-service"
import type { SettingsService } from "../settings/settings-service"
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
  normalizeHost,
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

const createMessageSchema = z
  .object({
    content: z.string().max(100_000).optional(),
    id: z.string().min(1).max(100).optional(),
    delivery: z.enum(["steer", "queue"]).optional(),
    files: z.array(promptFileInputSchema).max(32).optional(),
    providerId: z.string().min(1).max(100).optional(),
    modelId: z.string().min(1).max(300).optional(),
    reasoningEffort: z.string().min(1).max(50).nullable().optional(),
  })
  .refine((value) => Boolean(value.providerId) === Boolean(value.modelId), {
    message: "providerId and modelId must be provided together",
  })
  .refine((value) => Boolean(value.content?.trim()) || Boolean(value.files?.length), {
    message: "A prompt or attachment is required",
  })

const modelSelectionSchema = z.object({
  providerId: z.string().min(1).max(100),
  modelId: z.string().min(1).max(300),
  reasoningEffort: z.string().min(1).max(50).nullable().optional(),
})

const connectProviderSchema = z.object({
  apiKey: z.string().max(10_000).optional(),
  label: z.string().min(1).max(80).optional(),
})

const modelUpdateSchema = z.object({
  enabled: z.boolean().optional(),
  favorite: z.boolean().optional(),
})

const customProviderSchema = z.object({
  id: z.string().min(1).max(80).optional(),
  name: z.string().min(1).max(100),
  baseUrl: z.string().min(1).max(2_000),
  kind: z.enum(["cloud", "local"]).optional(),
  env: z.array(z.string().min(1).max(100)).max(20).optional(),
  apiKey: z.string().max(10_000).optional(),
  models: z
    .array(
      z.object({
        id: z.string().min(1).max(300),
        name: z.string().min(1).max(200).optional(),
        contextWindow: z.number().int().positive().optional(),
        maxOutputTokens: z.number().int().positive().optional(),
        supportsTools: z.boolean().optional(),
        supportsTemperature: z.boolean().optional(),
        reasoning: z.boolean().optional(),
        reasoningOptions: z
          .array(
            z.union([
              z.object({ type: z.literal("effort"), values: z.array(z.string().min(1).max(50)).max(50) }),
              z.object({ type: z.literal("toggle") }),
              z.object({
                type: z.literal("budget_tokens"),
                min: z.number().int().positive().optional(),
                max: z.number().int().positive().optional(),
              }),
            ]),
          )
          .max(10)
          .optional(),
        inputModalities: z.array(z.string()).optional(),
        outputModalities: z.array(z.string()).optional(),
        costInputPerMillion: z.number().min(0).optional(),
        costOutputPerMillion: z.number().min(0).optional(),
      }),
    )
    .max(1_000)
    .optional(),
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
  scope: z.enum(["once", "session", "always"]).optional(),
  reason: z.string().max(2_000).optional(),
  arguments: z.unknown().optional(),
})

const approvalConfigSchema = z.object({
  mode: z.enum(["smart", "manual", "off"]).optional(),
  timeoutSeconds: z.number().int().positive().max(86_400).optional(),
  deny: z.array(z.string().min(1).max(4_000)).max(500).optional(),
  allowlist: z.array(z.string().min(1).max(4_000)).max(500).optional(),
  writeSafeRoot: z.string().max(4_000).nullable().optional(),
  smartModel: z.string().max(500).nullable().optional(),
})

const checkpointRestoreSchema = z.object({
  filePath: z.string().min(1).max(4_000).optional(),
  safe: z.boolean().optional(),
})

const memoryOperationSchema = z.object({
  action: z.enum(["add", "patch", "remove"]),
  content: z.string().min(1).max(20_000).optional(),
  oldText: z.string().min(1).max(20_000).optional(),
})

const memoryUpdateSchema = z.object({
  store: z.enum(["user", "memory"]),
  operations: z.array(memoryOperationSchema).min(1).max(50),
})

const memoryPendingDecisionSchema = z.object({
  decision: z.enum(["approve", "reject"]),
  reason: z.string().max(2_000).optional(),
})

const memoryUndoSchema = z.object({
  historyId: z.string().min(1).max(100).optional(),
})

const IDEMPOTENCY_TTL_SECONDS = 24 * 60 * 60

export interface AppDependencies {
  readonly config: AppConfig
  readonly db: Database
  readonly auth: AuthService
  readonly events: EventService
  readonly models: ModelService
  readonly providers: ProviderService
  readonly turns: TurnService
  readonly turnBus: TurnBus
  readonly permissions: PermissionService
  readonly checkpoints: CheckpointManager
  readonly settings: SettingsService
  readonly tools: ToolService
  readonly memory: MemoryService
  readonly sessionSearch: SessionSearchService
  readonly remote: RemoteService
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

export function loggedPath(pathname: string): string {
  return pathname.startsWith("/auth/connect/") ? "/auth/connect/[redacted]" : pathname
}

function issueHttpError(error: unknown): HttpError {
  if (error instanceof HttpError) return error
  if (error instanceof TurnBusyError) {
    return new HttpError(409, "session_busy", error.message)
  }
  if (error instanceof SessionDeletingError) {
    return new HttpError(409, "session_deleting", error.message)
  }
  if (error instanceof InboxConflictError) {
    return new HttpError(409, "inbox_conflict", error.message)
  }
  if (error instanceof EmptyPromptError) {
    return new HttpError(400, "invalid_prompt", error.message)
  }
  if (error instanceof ProviderError) {
    return new HttpError(400, "provider_error", error.message)
  }
  if (error instanceof PermissionError) {
    return new HttpError(error.status, error.code, error.message)
  }
  if (error instanceof PathPolicyError) {
    return new HttpError(400, "path_policy_error", error.message)
  }
  if (error instanceof CheckpointError) {
    return new HttpError(409, "checkpoint_error", error.message)
  }
  if (error instanceof MemoryError) {
    return new HttpError(
      error.code === "stale_entry" || error.code === "already_decided" ? 409 : 400,
      error.code,
      error.message,
    )
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
  private readonly providers: ProviderService
  private readonly turns: TurnService
  private readonly turnBus: TurnBus
  private readonly permissions: PermissionService
  private readonly checkpoints: CheckpointManager
  private readonly settings: SettingsService
  private readonly tools: ToolService
  private readonly memory: MemoryService
  private readonly sessionSearch: SessionSearchService
  private readonly remote: RemoteService
  private readonly logger: Logger
  private readonly startedAt: number
  private readonly shutdown: (reason: string) => void | Promise<void>

  constructor(dependencies: AppDependencies) {
    this.config = dependencies.config
    this.db = dependencies.db
    this.auth = dependencies.auth
    this.events = dependencies.events
    this.models = dependencies.models
    this.providers = dependencies.providers
    this.turns = dependencies.turns
    this.turnBus = dependencies.turnBus
    this.permissions = dependencies.permissions
    this.checkpoints = dependencies.checkpoints
    this.settings = dependencies.settings
    this.tools = dependencies.tools
    this.memory = dependencies.memory
    this.sessionSearch = dependencies.sessionSearch
    this.remote = dependencies.remote
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
      if (!isHostAllowed(request.headers.get("host"), this.allowedHosts())) {
        throw new HttpError(403, "host_not_allowed", "Host header is not allowed")
      }
      response = await this.route(request, url, requestId)
    } catch (error) {
      const httpError = issueHttpError(error)
      if (httpError.status >= 500) {
        this.logger.error("http.failed", {
          requestId,
          method: request.method,
          path: loggedPath(url.pathname),
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
      path: loggedPath(url.pathname),
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
        urls: this.pairingUrls(this.requestOrigin(request, url.origin)),
        remote: await this.remote.status(),
        capabilities: [
          "auth",
          "sessions",
          "events",
          "pairing",
          "openapi",
          "providers",
          "models",
          "turns",
          "streaming",
          "permissions",
          "approvals",
          "approval_policy",
          "approval_grants",
          "active_sessions",
          "session_mutation",
          "settings",
          "sse_contract",
          "audit",
          "checkpoints",
          "tools",
          "memory",
          "session_search",
          "remote",
        ],
      })
    }

    if (path === "/v1/remote" && method === "GET") {
      await this.requireAuth(request)
      return jsonResponse(await this.remote.status())
    }

    if (path === "/v1/remote/accept" && method === "POST") {
      await this.requireAuth(request)
      await this.remote.accept()
      return jsonResponse(await this.remote.status())
    }

    if (path === "/v1/remote/enable" && method === "POST") {
      await this.requireAuth(request)
      return jsonResponse(await this.remote.enable())
    }

    if (path === "/v1/remote/disable" && method === "POST") {
      await this.requireAuth(request)
      return jsonResponse(await this.remote.disable())
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
        { "set-cookie": clearSessionCookie(this.secureFor(request)) },
      )
    }

    if (path === "/v1/auth/pair" && method === "POST") {
      await this.requireAuth(request)
      const pairing = await this.auth.createPairingToken()
      const urls = this.pairingUrls(this.requestOrigin(request, url.origin))
      const primary = urls[0] ?? url.origin
      const pairUrl = `${primary}/pair?token=${encodeURIComponent(pairing.token)}`
      await this.events.append("auth.pair_created", null, { expiresAt: pairing.expiresAt })
      return jsonResponse({
        code: pairing.token,
        url: pairUrl,
        urls,
        expiresAt: pairing.expiresAt,
        expiresIn: Math.max(1, Math.ceil((Date.parse(pairing.expiresAt) - Date.now()) / 1000)),
      })
    }

    if (path === "/v1/auth/rotate" && method === "POST") {
      await this.requireAuth(request)
      const password = await this.auth.rotatePassword()
      await this.events.append("auth.password_rotated", null, {})
      return jsonResponse(
        { password },
        200,
        { "set-cookie": clearSessionCookie(this.secureFor(request)) },
      )
    }

    if (path === "/pair" && method === "GET") {
      return this.pair(request, url)
    }

    const connectMatch = /^\/auth\/connect\/([^/]+)$/.exec(path)
    if (connectMatch && method === "GET") {
      let code: string
      try {
        code = decodeURIComponent(connectMatch[1] ?? "")
      } catch {
        throw new HttpError(400, "invalid_pairing_link", "Invalid pairing link")
      }
      return this.connectPairing(request, code)
    }

    if (path === "/v1/tools" && method === "GET") {
      await this.requireAuth(request)
      return jsonResponse({ tools: this.tools.list() })
    }

    if (path === "/v1/memory" && method === "GET") {
      await this.requireAuth(request)
      const snapshot = await this.memory.snapshot()
      return jsonResponse({
        generatedAt: snapshot.generatedAt,
        user: snapshot.user,
        memory: snapshot.memory,
        pending: await this.memory.listPending("pending"),
        history: await this.memory.listHistory(50),
      })
    }

    if (path === "/v1/memory" && method === "PATCH") {
      await this.requireAuth(request)
      const parsed = memoryUpdateSchema.safeParse(await readJson(request))
      if (!parsed.success) throw new HttpError(400, "invalid_body", validationMessage(parsed))
      return jsonResponse({
        mutation: await this.memory.mutate({
          store: parsed.data.store,
          operations: parsed.data.operations,
          actor: "user",
        }),
      })
    }

    if (path === "/v1/memory/pending" && method === "GET") {
      await this.requireAuth(request)
      return jsonResponse({ pending: await this.memory.listPending("pending") })
    }

    const memoryPendingMatch = /^\/v1\/memory\/pending\/([^/]+)\/decision$/.exec(path)
    if (memoryPendingMatch && method === "POST") {
      await this.requireAuth(request)
      const parsed = memoryPendingDecisionSchema.safeParse(await readJson(request))
      if (!parsed.success) throw new HttpError(400, "invalid_body", validationMessage(parsed))
      const id = decodeURIComponent(memoryPendingMatch[1] ?? "")
      if (parsed.data.decision === "approve") {
        const mutation = await this.memory.approvePending(id, "user", parsed.data.reason ?? null)
        return jsonResponse({ mutation, pending: await this.memory.listPending("pending") })
      }
      await this.memory.rejectPending(id, parsed.data.reason ?? null, "user")
      return jsonResponse({ pending: await this.memory.listPending("pending") })
    }

    if (path === "/v1/memory/undo" && method === "POST") {
      await this.requireAuth(request)
      const parsed = memoryUndoSchema.safeParse(await readJson(request))
      if (!parsed.success) throw new HttpError(400, "invalid_body", validationMessage(parsed))
      return jsonResponse({
        mutation: await this.memory.undo(parsed.data.historyId, "user"),
      })
    }

    if (path === "/v1/memory/export" && method === "GET") {
      await this.requireAuth(request)
      return new Response(await this.memory.exportMarkdown(), {
        headers: {
          "content-type": "text/markdown; charset=utf-8",
          "content-disposition": 'attachment; filename="agent-1-memory.md"',
        },
      })
    }

    if (path === "/v1/sessions/search" && method === "GET") {
      await this.requireAuth(request)
      const sortRaw = url.searchParams.get("sort")
      const sort =
        sortRaw === "newest" || sortRaw === "oldest" || sortRaw === "relevance" ? sortRaw : undefined
      const windowRaw = Number(url.searchParams.get("window") ?? "")
      const limitRaw = Number(url.searchParams.get("limit") ?? "")
      return jsonResponse(
        await this.sessionSearch.search({
          query: url.searchParams.get("query") ?? undefined,
          sessionId: url.searchParams.get("sessionId") ?? undefined,
          aroundMessageId: url.searchParams.get("aroundMessageId") ?? undefined,
          ...(Number.isInteger(windowRaw) ? { window: windowRaw } : {}),
          ...(Number.isInteger(limitRaw) ? { limit: limitRaw } : {}),
          ...(sort ? { sort } : {}),
          roleFilter: url.searchParams.get("roleFilter") ?? undefined,
        }),
      )
    }

    if (path === "/v1/sessions/active" && method === "GET") {
      await this.requireAuth(request)
      const activeTurns = await this.db.listActiveTurns()
      const active = Object.fromEntries(
        activeTurns.map((turn) => [turn.sessionId, { status: turn.status, turnId: turn.id }]),
      )
      return jsonResponse({ active })
    }

    const contextMatch = /^\/v1\/sessions\/([^/]+)\/context$/.exec(path)
    if (contextMatch && method === "GET") {
      await this.requireAuth(request)
      const id = decodeURIComponent(contextMatch[1] ?? "")
      const session = await this.db.getSession(id)
      if (!session) throw new HttpError(404, "session_not_found", "Session not found")
      const [turns, messages, model, activeTurn, inbox] = await Promise.all([
        this.db.listTurns(id, 100),
        this.db.getSessionMessages(id, 500),
        session.providerId && session.modelId
          ? this.providers.selected({ providerId: session.providerId, modelId: session.modelId }).catch(() => null)
          : Promise.resolve(null),
        this.db.getActiveTurn(id),
        this.turns.listInbox(id),
      ])
      return jsonResponse({
        session,
        activeTurn: activeTurn
          ? {
              id: activeTurn.id,
              status: activeTurn.status,
              startedAt: activeTurn.startedAt,
              updatedAt: activeTurn.updatedAt,
            }
          : null,
        inbox,
        model,
        messages: messages.length,
        turns: turns.length,
        inputTokens: turns.reduce((sum, turn) => sum + turn.inputTokens, 0),
        outputTokens: turns.reduce((sum, turn) => sum + turn.outputTokens, 0),
        contextTokens: turns[0] ? turns[0].inputTokens + turns[0].outputTokens : 0,
        costUsd: turns.reduce((sum, turn) => sum + turn.costUsd, 0),
        lastActivity: turns[0]?.updatedAt ?? session.updatedAt,
        contextWindow: model?.contextWindow ?? null,
        supportsTools: model?.supportsTools ?? false,
      })
    }

    if (path === "/v1/checkpoints" && method === "GET") {
      await this.requireAuth(request)
      const limitRaw = url.searchParams.get("limit")
      const limit = limitRaw ? Math.min(500, Math.max(1, Number(limitRaw) || 100)) : 100
      const sessionId = url.searchParams.get("sessionId") ?? undefined
      return jsonResponse({ checkpoints: await this.checkpoints.list(limit, sessionId) })
    }

    const checkpointMatch = /^\/v1\/checkpoints\/([^/]+)(?:\/(diff|restore))?$/.exec(path)
    if (checkpointMatch) {
      await this.requireAuth(request)
      const id = decodeURIComponent(checkpointMatch[1] ?? "")
      const action = checkpointMatch[2]
      if (!action && method === "GET") {
        const checkpoint = await this.checkpoints.get(id)
        if (!checkpoint) throw new HttpError(404, "checkpoint_not_found", "Checkpoint not found")
        return jsonResponse({ checkpoint })
      }
      if (action === "diff" && method === "GET") {
        return jsonResponse({ diff: await this.checkpoints.diff(id) })
      }
      if (action === "restore" && method === "POST") {
        const parsed = checkpointRestoreSchema.safeParse(await readJson(request))
        if (!parsed.success) throw new HttpError(400, "invalid_body", validationMessage(parsed))
        const checkpoint = await this.checkpoints.get(id)
        if (!checkpoint) throw new HttpError(404, "checkpoint_not_found", "Checkpoint not found")
        const result = await this.checkpoints.restore(id, parsed.data)
        return jsonResponse({ result })
      }
      throw new HttpError(405, "method_not_allowed", "Method not allowed")
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

    if (path === "/v1/approval-config" && method === "GET") {
      await this.requireAuth(request)
      return jsonResponse({ config: await this.permissions.config() })
    }

    if (path === "/v1/approval-config" && method === "PATCH") {
      await this.requireAuth(request)
      const parsed = approvalConfigSchema.safeParse(await readJson(request))
      if (!parsed.success) throw new HttpError(400, "invalid_body", validationMessage(parsed))
      return jsonResponse({ config: await this.permissions.setConfig(parsed.data) })
    }

    if (path === "/v1/settings" && method === "GET") {
      await this.requireAuth(request)
      return jsonResponse({ settings: await this.settings.get() })
    }

    if (path === "/v1/settings" && method === "PATCH") {
      await this.requireAuth(request)
      const parsed = settingsPatchSchema.safeParse(await readJson(request))
      if (!parsed.success) throw new HttpError(400, "invalid_body", validationMessage(parsed))
      return jsonResponse({ settings: await this.settings.patch(parsed.data) })
    }

    if (path === "/v1/approval-grants" && method === "GET") {
      await this.requireAuth(request)
      return jsonResponse({ grants: await this.permissions.listApprovalGrants() })
    }

    const approvalGrantMatch = /^\/v1\/approval-grants\/([^/]+)$/.exec(path)
    if (approvalGrantMatch && method === "DELETE") {
      await this.requireAuth(request)
      const removed = await this.permissions.deleteApprovalGrant(
        decodeURIComponent(approvalGrantMatch[1] ?? ""),
      )
      if (!removed) throw new HttpError(404, "approval_grant_not_found", "Approval grant not found")
      return jsonResponse({ ok: true })
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
            ...(parsed.data.scope ? { scope: parsed.data.scope } : {}),
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

    if (path === "/v1/providers" && method === "GET") {
      await this.requireAuth(request)
      return jsonResponse({ providers: await this.providers.listProviders() })
    }

    if (path === "/v1/providers" && method === "POST") {
      await this.requireAuth(request)
      const parsed = customProviderSchema.safeParse(await readJson(request))
      if (!parsed.success) throw new HttpError(400, "invalid_body", validationMessage(parsed))
      return jsonResponse({ provider: await this.providers.createCustom(parsed.data) }, 201)
    }

    const providerActionMatch = /^\/v1\/providers\/([^/]+)\/(connect|refresh|connect-env)$/.exec(path)
    if (providerActionMatch) {
      await this.requireAuth(request)
      const providerId = decodeURIComponent(providerActionMatch[1] ?? "")
      const action = providerActionMatch[2]
      if (method !== "POST") throw new HttpError(405, "method_not_allowed", "Method not allowed")
      if (action === "refresh") {
        await this.providers.refresh(providerId)
        return jsonResponse({ provider: await this.providers.getProvider(providerId) })
      }
      if (action === "connect-env") {
        return jsonResponse({ provider: await this.providers.connectFromEnvironment(providerId) })
      }
      const parsed = connectProviderSchema.safeParse(await readJson(request))
      if (!parsed.success) throw new HttpError(400, "invalid_body", validationMessage(parsed))
      return jsonResponse({
        provider: await this.providers.connect(providerId, parsed.data.apiKey ?? "", parsed.data.label),
      })
    }

    const credentialActionMatch = /^\/v1\/providers\/([^/]+)\/credentials\/([^/]+)(?:\/(activate))?$/.exec(path)
    if (credentialActionMatch) {
      await this.requireAuth(request)
      const providerId = decodeURIComponent(credentialActionMatch[1] ?? "")
      const credentialId = decodeURIComponent(credentialActionMatch[2] ?? "")
      if (credentialActionMatch[3] === "activate" && method === "POST") {
        return jsonResponse({ provider: await this.providers.switchCredential(providerId, credentialId) })
      }
      if (method === "DELETE") {
        return jsonResponse({ provider: await this.providers.logout(providerId, credentialId) })
      }
      throw new HttpError(405, "method_not_allowed", "Method not allowed")
    }

    const mediaMatch = /^\/v1\/media\/([0-9a-f]{64})$/.exec(path)
    if (mediaMatch && method === "GET") {
      await this.requireAuth(request)
      const blob = await this.db.getReferencedBlob(mediaMatch[1]!)
      if (!blob) throw new HttpError(404, "media_not_found", "Media not found")
      return new Response(blob.data as unknown as BodyInit, {
        status: 200,
        headers: {
          "content-type": blob.mime,
          "content-length": String(blob.data.byteLength),
          "cache-control": "private, max-age=86400",
          "x-content-type-options": "nosniff",
        },
      })
    }

    if (path === "/v1/models" && method === "GET") {
      await this.requireAuth(request)
      const providerId = url.searchParams.get("provider") ?? undefined
      const includeDisabled = url.searchParams.get("all") === "1"
      return jsonResponse({ models: await this.providers.listModels(providerId, includeDisabled) })
    }

    if (path === "/v1/models/default" && method === "GET") {
      await this.requireAuth(request)
      return jsonResponse({ model: await this.providers.defaultModel() })
    }

    if (path === "/v1/models/default" && method === "PUT") {
      await this.requireAuth(request)
      const parsed = modelSelectionSchema.safeParse(await readJson(request))
      if (!parsed.success) throw new HttpError(400, "invalid_body", validationMessage(parsed))
      return jsonResponse({ model: await this.providers.setDefault(parsed.data) })
    }

    const modelActionMatch = /^\/v1\/models\/([^/]+)\/(.+)$/.exec(path)
    if (modelActionMatch) {
      await this.requireAuth(request)
      const providerId = decodeURIComponent(modelActionMatch[1] ?? "")
      const modelId = decodeURIComponent(modelActionMatch[2] ?? "")
      if (method === "PATCH") {
        const parsed = modelUpdateSchema.safeParse(await readJson(request))
        if (!parsed.success) throw new HttpError(400, "invalid_body", validationMessage(parsed))
        return jsonResponse({ model: await this.providers.updateModel(providerId, modelId, parsed.data) })
      }
      throw new HttpError(405, "method_not_allowed", "Method not allowed")
    }

    const sessionModelMatch = /^\/v1\/sessions\/([^/]+)\/model$/.exec(path)
    if (sessionModelMatch && method === "PATCH") {
      await this.requireAuth(request)
      const sessionId = decodeURIComponent(sessionModelMatch[1] ?? "")
      const session = await this.db.getSession(sessionId)
      if (!session) throw new HttpError(404, "session_not_found", "Session not found")
      const parsed = modelSelectionSchema.safeParse(await readJson(request))
      if (!parsed.success) throw new HttpError(400, "invalid_body", validationMessage(parsed))
      const selected = await this.providers.selected(parsed.data)
      const model = await this.providers.getModel(parsed.data.providerId, parsed.data.modelId)
      if (!model) throw new HttpError(404, "model_not_found", "Model not found")
      const effort = this.models.reasoningEffortFor(model, parsed.data.reasoningEffort)
      await this.db.setSessionModel(sessionId, parsed.data.providerId, parsed.data.modelId, effort ?? null)
      return jsonResponse({ model: selected })
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
        const contentLength = Number(request.headers.get("content-length") ?? "0")
        if (Number.isFinite(contentLength) && contentLength > 64 * 1024 * 1024) {
          throw new HttpError(413, "payload_too_large", "Message payload exceeds the 64 MB request limit")
        }
        const parsed = createMessageSchema.safeParse(await readJson(request))
        if (!parsed.success) throw new HttpError(400, "invalid_body", validationMessage(parsed))
        const result = await this.turns.prompt(
          sessionId,
          parsed.data.content ?? "",
          {
            delivery: parsed.data.delivery ?? "steer",
            ...(parsed.data.id ? { id: parsed.data.id } : {}),
            ...(parsed.data.files ? { files: parsed.data.files } : {}),
            ...(parsed.data.providerId && parsed.data.modelId
              ? {
                  selection: {
                    providerId: parsed.data.providerId,
                    modelId: parsed.data.modelId,
                    reasoningEffort: parsed.data.reasoningEffort,
                  },
                }
              : {}),
          },
        )
        return jsonResponse(
          {
            inbox: result.inbox,
            turn: result.turn,
            activeTurn: result.turn,
            streamUrl: result.turn
              ? `/v1/turns/${encodeURIComponent(result.turn.id)}/stream`
              : null,
          },
          202,
        )
      }
      throw new HttpError(405, "method_not_allowed", "Method not allowed")
    }

    const inboxMatch = /^\/v1\/sessions\/([^/]+)\/inbox(?:\/([^/]+))?$/.exec(path)
    if (inboxMatch) {
      await this.requireAuth(request)
      const sessionId = decodeURIComponent(inboxMatch[1] ?? "")
      const inboxId = inboxMatch[2] ? decodeURIComponent(inboxMatch[2]) : undefined
      const session = await this.db.getSession(sessionId)
      if (!session) throw new HttpError(404, "session_not_found", "Session not found")
      if (!inboxId && method === "GET") {
        return jsonResponse({ inbox: await this.turns.listInbox(sessionId) })
      }
      if (!inboxId) throw new HttpError(405, "method_not_allowed", "Method not allowed")
      if (method === "DELETE") {
        await this.turns.cancelInbox(sessionId, inboxId)
        return jsonResponse({ ok: true })
      }
      if (method === "PATCH") {
        const parsed = z
          .object({ delivery: z.enum(["steer", "queue"]) })
          .safeParse(await readJson(request))
        if (!parsed.success) throw new HttpError(400, "invalid_body", validationMessage(parsed))
        const result = await this.turns.setInboxDelivery(sessionId, inboxId, parsed.data.delivery)
        if (!result.inbox) throw new HttpError(409, "inbox_conflict", "Inbox item is no longer pending")
        return jsonResponse({
          inbox: result.inbox,
          turn: result.turn,
        })
      }
      throw new HttpError(405, "method_not_allowed", "Method not allowed")
    }

    const interruptMatch = /^\/v1\/sessions\/([^/]+)\/interrupt$/.exec(path)
    if (interruptMatch && method === "POST") {
      await this.requireAuth(request)
      const sessionId = decodeURIComponent(interruptMatch[1] ?? "")
      const session = await this.db.getSession(sessionId)
      if (!session) throw new HttpError(404, "session_not_found", "Session not found")
      const resume = url.searchParams.get("resume") !== "false"
      const result = await this.turns.interruptSession(sessionId, { resume })
      return jsonResponse(result)
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

    const sessionMatch = /^\/v1\/sessions\/([^/]+)$/.exec(path)
    if (sessionMatch && (method === "PATCH" || method === "DELETE")) {
      await this.requireAuth(request)
      const id = decodeURIComponent(sessionMatch[1] ?? "")
      const session = await this.db.getSession(id)
      if (!session) throw new HttpError(404, "session_not_found", "Session not found")
      if (method === "PATCH") {
        const parsed = sessionRenameRequestSchema.safeParse(await readJson(request))
        if (!parsed.success) throw new HttpError(400, "invalid_body", validationMessage(parsed))
        const renamed = await this.db.renameSession(id, parsed.data.title)
        if (!renamed) throw new HttpError(404, "session_not_found", "Session not found")
        this.events.publish(renamed.event)
        return jsonResponse({ session: renamed.session })
      }
      this.turns.beginSessionDelete(id)
      try {
        await this.turns.cancelSession(id)
        const deleted = await this.db.deleteSession(id)
        if (!deleted) throw new HttpError(404, "session_not_found", "Session not found")
        this.events.publish(deleted)
        return jsonResponse({ ok: true })
      } finally {
        this.turns.endSessionDelete(id)
      }
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
      token = await this.auth.login(parsed.data.password, this.loginRateKey(request))
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
      { "set-cookie": sessionCookie(token.token, SESSION_TTL_SECONDS, this.secureFor(request)) },
    )
  }

  private allowedHosts(): string[] {
    return [...this.config.allowedHosts, ...this.remote.allowedHosts()]
  }

  private isRemoteRequest(request: Request): boolean {
    const host = normalizeHost(request.headers.get("host") ?? "")
    if (!host) return false
    if (this.remote.isRemoteHost(host)) return true
    if (!this.config.publicUrl) return false
    try {
      return new URL(this.config.publicUrl).hostname.toLowerCase() === host
    } catch {
      return false
    }
  }

  private secureFor(request: Request): boolean {
    return this.config.secureCookies || this.isRemoteRequest(request)
  }

  private loginRateKey(request: Request): string {
    if (!this.isRemoteRequest(request)) return "local"
    const visitor = request.headers.get("x-agent1-visitor")
    return visitor ? `remote:${visitor}` : `remote:${normalizeHost(request.headers.get("host") ?? "") ?? "unknown"}`
  }

  private requestOrigin(request: Request, fallback: string): string {
    const host = normalizeHost(request.headers.get("host") ?? "")
    if (!host) return fallback
    const remoteUrl = this.remote.publicUrl()
    if (remoteUrl && this.remote.isRemoteHost(host)) return remoteUrl
    if (this.config.publicUrl) {
      try {
        if (new URL(this.config.publicUrl).hostname.toLowerCase() === host) return this.config.publicUrl
      } catch {
        // The config parser already validates public URLs.
      }
    }
    return fallback
  }

  private pairingUrls(origin: string): string[] {
    const urls = new Set<string>([origin])
    if (this.config.publicUrl) urls.add(this.config.publicUrl)
    const remoteUrl = this.remote.publicUrl()
    if (remoteUrl) urls.add(remoteUrl)
    return [...urls]
  }

  private async pair(request: Request, url: URL): Promise<Response> {
    const token = url.searchParams.get("token")
    if (!token) return htmlResponse(pairingPage("Missing pairing token."), 400)
    return this.consumePairing(request, token)
  }

  private async connectPairing(request: Request, code: string): Promise<Response> {
    return this.consumePairing(request, code)
  }

  private async consumePairing(request: Request, token: string): Promise<Response> {
    if (!token) return htmlResponse(pairingPage("Missing pairing token."), 400)
    const session = await this.auth.consumePairingToken(token)
    if (!session) return htmlResponse(pairingPage("This pairing link is invalid, expired, or already used."), 400)
    await this.events.append("auth.paired", null, {})
    return new Response(null, {
      status: 303,
      headers: {
        location: "/",
        "set-cookie": sessionCookie(session.token, SESSION_TTL_SECONDS, this.secureFor(request)),
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
      !isOriginAllowed(request.headers.get("origin"), this.allowedHosts())
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
