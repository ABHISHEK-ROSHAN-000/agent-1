import type {
  ActiveSessionEntry,
  ActiveTurn,
  SettingsContract,
  SettingsPatch,
} from "../shared/contracts"
import type {
  Approval,
  ApprovalConfig,
  ApprovalGrant,
  ApprovalStatus,
  ApprovalScope,
  AuditEntry,
  CatalogModel,
  Checkpoint,
  CheckpointDiff,
  CheckpointRestoreResult,
  InboxDelivery,
  InboxItem,
  ModelSelection,
  PromptFileInput,
  PermissionRule,
  ProviderInfo,
  RemoteStatus,
  SelectedModel,
  Turn,
} from "../shared/types"

export interface ClientOptions {
  readonly baseUrl: string
  readonly password?: string
  readonly cookie?: string
  readonly timeoutMs?: number
}

export class ClientError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = "ClientError"
  }
}

interface ErrorEnvelope {
  readonly error?: { readonly code?: string; readonly message?: string }
}

export interface MemoryUsage {
  readonly chars: number
  readonly limit: number
  readonly percent: number
}

export interface MemoryStoreView {
  readonly store: "user" | "memory"
  readonly entries: readonly string[]
  readonly usage: MemoryUsage
  readonly block: string | null
}

export interface MemoryPendingRecord {
  readonly id: string
  readonly sessionId: string | null
  readonly turnId: string | null
  readonly store: "user" | "memory"
  readonly action: "add" | "patch" | "remove"
  readonly payload: {
    readonly action: "add" | "patch" | "remove"
    readonly content?: string
    readonly oldText?: string
  }
  readonly summary: string
  readonly origin: string
  readonly status: "pending" | "approved" | "rejected" | "expired" | "invalidated"
  readonly matchedEntry: string | null
  readonly createdAt: string
  readonly decidedAt: string | null
  readonly decidedBy: string | null
  readonly reason: string | null
}

export interface MemoryHistoryRecord {
  readonly id: string
  readonly store: "user" | "memory"
  readonly action: string
  readonly before: readonly string[]
  readonly after: readonly string[]
  readonly pendingId: string | null
  readonly actor: string
  readonly note: string | null
  readonly createdAt: string
  readonly undoneAt: string | null
  readonly undoHistoryId: string | null
}

export interface MemoryMutationResult {
  readonly store: "user" | "memory"
  readonly actions: readonly string[]
  readonly changed: boolean
  readonly message: string
  readonly entries: readonly string[]
  readonly usage: MemoryUsage
  readonly history: MemoryHistoryRecord | null
}

export interface SessionSearchResult {
  readonly ok: boolean
  readonly mode?: "discover" | "read" | "browse" | "scroll"
  readonly query?: string
  readonly sessionId?: string
  readonly title?: string
  readonly results?: ReadonlyArray<{
    readonly sessionId: string
    readonly title: string
    readonly updatedAt: string
    readonly matches: ReadonlyArray<{
      readonly messageId: string
      readonly role: string
      readonly snippet: string
      readonly text: string
      readonly createdAt: string
    }>
  }>
  readonly sessions?: ReadonlyArray<{ readonly id: string; readonly title: string; readonly updatedAt: string }>
  readonly messages?: ReadonlyArray<{
    readonly id: string
    readonly seq: number
    readonly role: string
    readonly text: string
    readonly createdAt: string
    readonly sessionId: string
  }>
  readonly count?: number
  readonly total?: number
  readonly truncated?: boolean
  readonly messagesBefore?: number
  readonly messagesAfter?: number
  readonly window?: number
  readonly error?: string
}

export class AgentOneClient {
  readonly baseUrl: string
  private password?: string
  private cookie?: string
  private readonly timeoutMs: number

  constructor(options: ClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, "")
    this.password = options.password
    this.cookie = options.cookie
    this.timeoutMs = options.timeoutMs ?? 15_000
  }

  setCookie(cookie: string | undefined): void {
    this.cookie = cookie
  }

  getCookie(): string | undefined {
    return this.cookie
  }

  private cookieName(): string {
    try {
      const port = new URL(this.baseUrl).port
      return port ? `agent1_session_${port}` : "agent1_session"
    } catch {
      return "agent1_session"
    }
  }

  private authHeaders(): Record<string, string> {
    if (this.cookie) return { cookie: `${this.cookieName()}=${this.cookie}` }
    if (this.password) {
      return {
        authorization: `Basic ${Buffer.from(`agent-1:${this.password}`, "utf8").toString("base64")}`,
      }
    }
    return {}
  }

  private async requestText(path: string): Promise<string> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method: "GET",
        headers: { accept: "text/markdown", ...this.authHeaders() },
        signal: controller.signal,
      })
      const text = await response.text()
      if (!response.ok) {
        let parsed: ErrorEnvelope = {}
        try {
          parsed = JSON.parse(text) as ErrorEnvelope
        } catch {
          // Keep the raw message.
        }
        throw new ClientError(
          response.status,
          parsed.error?.code ?? "request_failed",
          parsed.error?.message ?? (text || response.statusText),
        )
      }
      return text
    } finally {
      clearTimeout(timer)
    }
  }

  private async request<T>(
    method: string,
    path: string,
    body?: unknown,
    extraHeaders: Record<string, string> = {},
  ): Promise<T> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    const headers: Record<string, string> = {
      accept: "application/json",
      ...extraHeaders,
    }
    if (body !== undefined) headers["content-type"] = "application/json"
    Object.assign(headers, this.authHeaders())

    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        signal: controller.signal,
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      })
      const text = await response.text()
      if (!response.ok) {
        let parsed: ErrorEnvelope = {}
        try {
          parsed = JSON.parse(text) as ErrorEnvelope
        } catch {
          // Keep the raw message.
        }
        throw new ClientError(
          response.status,
          parsed.error?.code ?? "request_failed",
          parsed.error?.message ?? (text || response.statusText),
        )
      }
      return (text ? JSON.parse(text) : {}) as T
    } finally {
      clearTimeout(timer)
    }
  }

  health(): Promise<{
    status: "ok"
    product: string
    version: string
    phase: string
    uptimeSeconds: number
    eventSeq: number
  }> {
    return this.request("GET", "/v1/health")
  }

  info(): Promise<{
    status: string
    product: string
    version: string
    phase: string
    uptimeSeconds: number
    eventSeq: number
    urls: string[]
    remote: RemoteStatus
    [key: string]: unknown
  }> {
    return this.request("GET", "/v1/info")
  }

  async login(password: string): Promise<{ expiresAt: string }> {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), this.timeoutMs)
    try {
      const response = await fetch(`${this.baseUrl}/v1/auth/login`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ password }),
        signal: controller.signal,
      })
      const text = await response.text()
      if (!response.ok) {
        throw new ClientError(response.status, "login_failed", text || "Login failed")
      }
      const setCookie = response.headers.get("set-cookie") ?? ""
      const match = /(?:^|,\s*)agent1_session(?:_\d+)?=([^;]+)/.exec(setCookie)
      if (match?.[1]) this.cookie = match[1]
      this.password = password
      return JSON.parse(text) as { expiresAt: string }
    } finally {
      clearTimeout(timer)
    }
  }

  async pair(): Promise<{
    code: string
    url: string
    urls: string[]
    expiresAt: string
    expiresIn: number
  }> {
    return this.request("POST", "/v1/auth/pair", {})
  }

  remote(): Promise<RemoteStatus> {
    return this.request("GET", "/v1/remote")
  }

  acceptRemote(): Promise<RemoteStatus> {
    return this.request("POST", "/v1/remote/accept", {})
  }

  enableRemote(): Promise<RemoteStatus> {
    return this.request("POST", "/v1/remote/enable", {})
  }

  disableRemote(): Promise<RemoteStatus> {
    return this.request("POST", "/v1/remote/disable", {})
  }

  async rotatePassword(): Promise<{ password: string }> {
    return this.request("POST", "/v1/auth/rotate", {})
  }

  async logout(): Promise<void> {
    await this.request("POST", "/v1/auth/logout", {})
    this.cookie = undefined
  }

  listSessions(): Promise<{ sessions: Array<Record<string, unknown>> }> {
    return this.request("GET", "/v1/sessions")
  }

  createSession(title?: string): Promise<{ session: Record<string, unknown> }> {
    return this.request("POST", "/v1/sessions", title === undefined ? {} : { title })
  }

  getSession(id: string): Promise<{ session: Record<string, unknown> }> {
    return this.request("GET", `/v1/sessions/${encodeURIComponent(id)}`)
  }

  activeSessions(): Promise<{ active: Record<string, ActiveSessionEntry> }> {
    return this.request("GET", "/v1/sessions/active")
  }

  sessionContext(id: string): Promise<{
    session: Record<string, unknown>
    activeTurn: ActiveTurn | null
    inbox?: InboxItem[]
  }> {
    return this.request("GET", `/v1/sessions/${encodeURIComponent(id)}/context`)
  }

  renameSession(id: string, title: string): Promise<{ session: Record<string, unknown> }> {
    return this.request("PATCH", `/v1/sessions/${encodeURIComponent(id)}`, { title })
  }

  deleteSession(id: string): Promise<{ ok: true }> {
    return this.request("DELETE", `/v1/sessions/${encodeURIComponent(id)}`)
  }

  listMessages(
    sessionId: string,
    limit = 100,
  ): Promise<{ messages: Array<Record<string, unknown>> }> {
    return this.request(
      "GET",
      `/v1/sessions/${encodeURIComponent(sessionId)}/messages?limit=${limit}`,
    )
  }

  admitMessage(
    sessionId: string,
    content: string,
    options: {
      readonly delivery?: InboxDelivery
      readonly selection?: ModelSelection
      readonly id?: string
      readonly files?: readonly PromptFileInput[]
    } = {},
  ): Promise<{
    inbox: InboxItem
    turn: Turn | null
    streamUrl: string | null
    activeTurn?: Turn | null
  }> {
    return this.request("POST", `/v1/sessions/${encodeURIComponent(sessionId)}/messages`, {
      content,
      ...(options.delivery ? { delivery: options.delivery } : {}),
      ...(options.id ? { id: options.id } : {}),
      ...(options.files && options.files.length > 0 ? { files: options.files } : {}),
      ...(options.selection
        ? {
            providerId: options.selection.providerId,
            modelId: options.selection.modelId,
            ...(options.selection.reasoningEffort !== undefined
              ? { reasoningEffort: options.selection.reasoningEffort }
              : {}),
          }
        : {}),
    })
  }

  async startMessage(
    sessionId: string,
    content: string,
    selection?: ModelSelection,
  ): Promise<{ turn: Turn; streamUrl: string; inbox: InboxItem }> {
    const admitted = await this.admitMessage(sessionId, content, {
      delivery: "steer",
      selection,
    })
    if (!admitted.turn) throw new ClientError(202, "inbox_admitted", "Prompt was queued")
    return {
      turn: admitted.turn,
      streamUrl: admitted.streamUrl ?? `/v1/turns/${encodeURIComponent(admitted.turn.id)}/stream`,
      inbox: admitted.inbox,
    }
  }

  listInbox(sessionId: string): Promise<{ inbox: InboxItem[] }> {
    return this.request("GET", `/v1/sessions/${encodeURIComponent(sessionId)}/inbox`)
  }

  cancelInbox(sessionId: string, inboxId: string): Promise<{ ok: true }> {
    return this.request(
      "DELETE",
      `/v1/sessions/${encodeURIComponent(sessionId)}/inbox/${encodeURIComponent(inboxId)}`,
    )
  }

  setInboxDelivery(
    sessionId: string,
    inboxId: string,
    delivery: InboxDelivery,
  ): Promise<{ inbox: InboxItem | null; turn: Turn | null }> {
    return this.request(
      "PATCH",
      `/v1/sessions/${encodeURIComponent(sessionId)}/inbox/${encodeURIComponent(inboxId)}`,
      { delivery },
    )
  }

  interruptSession(
    sessionId: string,
    options: { readonly resume?: boolean } = {},
  ): Promise<{ interrupted: boolean; turn: Turn | null }> {
    const resume = options.resume === false ? "false" : "true"
    return this.request(
      "POST",
      `/v1/sessions/${encodeURIComponent(sessionId)}/interrupt?resume=${resume}`,
      {},
    )
  }

  setSessionModel(sessionId: string, selection: ModelSelection): Promise<{ model: SelectedModel }> {
    return this.request("PATCH", `/v1/sessions/${encodeURIComponent(sessionId)}/model`, selection)
  }

  getTurn(id: string): Promise<{ turn: Turn; messages: Array<Record<string, unknown>> }> {
    return this.request("GET", `/v1/turns/${encodeURIComponent(id)}`)
  }

  cancelTurn(id: string): Promise<{ turn: Turn }> {
    return this.request("POST", `/v1/turns/${encodeURIComponent(id)}/cancel`, {})
  }

  async turnStreamResponse(turnId: string, signal?: AbortSignal): Promise<Response> {
    const headers: Record<string, string> = { accept: "text/event-stream" }
    if (this.cookie) headers.cookie = `${this.cookieName()}=${this.cookie}`
    else if (this.password) {
      headers.authorization = `Basic ${Buffer.from(`agent-1:${this.password}`, "utf8").toString("base64")}`
    }
    return fetch(`${this.baseUrl}/v1/turns/${encodeURIComponent(turnId)}/stream`, {
      headers,
      signal,
    })
  }

  listProviders(): Promise<{ providers: ProviderInfo[] }> {
    return this.request("GET", "/v1/providers")
  }

  createProvider(input: {
    id?: string
    name: string
    baseUrl: string
    kind?: "cloud" | "local"
    env?: string[]
    apiKey?: string
    models?: Array<Record<string, unknown>>
  }): Promise<{ provider: ProviderInfo }> {
    return this.request("POST", "/v1/providers", input)
  }

  connectProvider(id: string, apiKey?: string, label?: string): Promise<{ provider: ProviderInfo }> {
    return this.request("POST", `/v1/providers/${encodeURIComponent(id)}/connect`, {
      ...(apiKey !== undefined ? { apiKey } : {}),
      ...(label ? { label } : {}),
    })
  }

  connectProviderEnvironment(id: string): Promise<{ provider: ProviderInfo }> {
    return this.request("POST", `/v1/providers/${encodeURIComponent(id)}/connect-env`, {})
  }

  refreshProvider(id: string): Promise<{ provider: ProviderInfo }> {
    return this.request("POST", `/v1/providers/${encodeURIComponent(id)}/refresh`, {})
  }

  activateProviderCredential(id: string, credentialId: string): Promise<{ provider: ProviderInfo }> {
    return this.request(
      "POST",
      `/v1/providers/${encodeURIComponent(id)}/credentials/${encodeURIComponent(credentialId)}/activate`,
      {},
    )
  }

  removeProviderCredential(id: string, credentialId: string): Promise<{ provider: ProviderInfo }> {
    return this.request(
      "DELETE",
      `/v1/providers/${encodeURIComponent(id)}/credentials/${encodeURIComponent(credentialId)}`,
    )
  }

  listModels(providerId?: string, includeDisabled = false): Promise<{ models: CatalogModel[] }> {
    const query = new URLSearchParams()
    if (providerId) query.set("provider", providerId)
    if (includeDisabled) query.set("all", "1")
    const suffix = query.size > 0 ? `?${query.toString()}` : ""
    return this.request("GET", `/v1/models${suffix}`)
  }

  defaultModel(): Promise<{ model: CatalogModel | null }> {
    return this.request("GET", "/v1/models/default")
  }

  setDefaultModel(selection: ModelSelection): Promise<{ model: CatalogModel }> {
    return this.request("PUT", "/v1/models/default", selection)
  }

  updateModel(
    providerId: string,
    modelId: string,
    input: { enabled?: boolean; favorite?: boolean },
  ): Promise<{ model: CatalogModel }> {
    return this.request(
      "PATCH",
      `/v1/models/${encodeURIComponent(providerId)}/${encodeURIComponent(modelId)}`,
      input,
    )
  }

  listRules(): Promise<{ rules: PermissionRule[] }> {
    return this.request("GET", "/v1/rules")
  }

  createRule(input: {
    action: string
    resource: string
    effect: "allow" | "ask" | "deny"
    position?: number
    ttlSeconds?: number | null
    note?: string | null
  }): Promise<{ rule: PermissionRule }> {
    return this.request("POST", "/v1/rules", input)
  }

  updateRule(
    id: string,
    input: Partial<{
      action: string
      resource: string
      effect: "allow" | "ask" | "deny"
      position: number
      ttlSeconds: number | null
      note: string | null
    }>,
  ): Promise<{ rule: PermissionRule }> {
    return this.request("PATCH", `/v1/rules/${encodeURIComponent(id)}`, input)
  }

  removeRule(id: string): Promise<{ ok: true }> {
    return this.request("DELETE", `/v1/rules/${encodeURIComponent(id)}`)
  }

  listApprovals(status?: ApprovalStatus): Promise<{ approvals: Approval[] }> {
    const suffix = status ? `?status=${encodeURIComponent(status)}` : ""
    return this.request("GET", `/v1/approvals${suffix}`)
  }

  getApproval(id: string): Promise<{ approval: Approval }> {
    return this.request("GET", `/v1/approvals/${encodeURIComponent(id)}`)
  }

  decideApproval(
    id: string,
    decision: "approve" | "reject",
    options?: { reason?: string; arguments?: unknown; scope?: ApprovalScope },
  ): Promise<{ approval: Approval }> {
    return this.request("POST", `/v1/approvals/${encodeURIComponent(id)}/decision`, {
      decision,
      ...(options?.scope ? { scope: options.scope } : {}),
      ...(options?.reason ? { reason: options.reason } : {}),
      ...(options && options.arguments !== undefined ? { arguments: options.arguments } : {}),
    })
  }

  approvalConfig(): Promise<{ config: ApprovalConfig }> {
    return this.request("GET", "/v1/approval-config")
  }

  setApprovalConfig(input: Partial<ApprovalConfig>): Promise<{ config: ApprovalConfig }> {
    return this.request("PATCH", "/v1/approval-config", input)
  }

  listApprovalGrants(): Promise<{ grants: ApprovalGrant[] }> {
    return this.request("GET", "/v1/approval-grants")
  }

  deleteApprovalGrant(id: string): Promise<{ ok: true }> {
    return this.request("DELETE", `/v1/approval-grants/${encodeURIComponent(id)}`)
  }

  settings(): Promise<{ settings: SettingsContract }> {
    return this.request("GET", "/v1/settings")
  }

  updateSettings(input: SettingsPatch): Promise<{ settings: SettingsContract }> {
    return this.request("PATCH", "/v1/settings", input)
  }

  listAudit(limit = 100): Promise<{ entries: AuditEntry[] }> {
    return this.request("GET", `/v1/audit?limit=${limit}`)
  }

  listTools(): Promise<{
    tools: Array<{
      name: string
      action: string
      description: string
      risk: string
      readOnly: boolean
      approvalRequired?: boolean
    }>
  }> {
    return this.request("GET", "/v1/tools")
  }

  getMemory(): Promise<{
    generatedAt: string
    user: MemoryStoreView
    memory: MemoryStoreView
    pending: MemoryPendingRecord[]
    history: MemoryHistoryRecord[]
  }> {
    return this.request("GET", "/v1/memory")
  }

  updateMemory(input: {
    store: "user" | "memory"
    operations: ReadonlyArray<{
      action: "add" | "patch" | "remove"
      content?: string
      oldText?: string
    }>
  }): Promise<{ mutation: MemoryMutationResult }> {
    return this.request("PATCH", "/v1/memory", input)
  }

  listMemoryPending(): Promise<{ pending: MemoryPendingRecord[] }> {
    return this.request("GET", "/v1/memory/pending")
  }

  decideMemoryPending(
    id: string,
    decision: "approve" | "reject",
    reason?: string,
  ): Promise<{ mutation?: MemoryMutationResult; pending: MemoryPendingRecord[] }> {
    return this.request("POST", `/v1/memory/pending/${encodeURIComponent(id)}/decision`, {
      decision,
      ...(reason ? { reason } : {}),
    })
  }

  undoMemory(historyId?: string): Promise<{ mutation: MemoryMutationResult }> {
    return this.request("POST", "/v1/memory/undo", historyId ? { historyId } : {})
  }

  exportMemory(): Promise<string> {
    return this.requestText("/v1/memory/export")
  }

  searchSessions(input: {
    query?: string
    sessionId?: string
    aroundMessageId?: string
    window?: number
    limit?: number
    sort?: "relevance" | "newest" | "oldest"
    roleFilter?: string
  } = {}): Promise<SessionSearchResult> {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(input)) {
      if (value !== undefined && value !== "") params.set(key, String(value))
    }
    return this.request("GET", `/v1/sessions/search?${params.toString()}`)
  }

  listCheckpoints(limit = 100, sessionId?: string): Promise<{ checkpoints: Checkpoint[] }> {
    const query = new URLSearchParams({ limit: String(limit) })
    if (sessionId) query.set("sessionId", sessionId)
    return this.request("GET", `/v1/checkpoints?${query.toString()}`)
  }

  getCheckpoint(id: string): Promise<{ checkpoint: Checkpoint }> {
    return this.request("GET", `/v1/checkpoints/${encodeURIComponent(id)}`)
  }

  diffCheckpoint(id: string): Promise<{ diff: CheckpointDiff }> {
    return this.request("GET", `/v1/checkpoints/${encodeURIComponent(id)}/diff`)
  }

  restoreCheckpoint(
    id: string,
    input: { filePath?: string; safe?: boolean } = {},
  ): Promise<{ result: CheckpointRestoreResult }> {
    return this.request("POST", `/v1/checkpoints/${encodeURIComponent(id)}/restore`, input)
  }

  stop(): Promise<{ ok: true }> {
    return this.request("POST", "/v1/system/stop", {})
  }

  async eventsResponse(after = 0, signal?: AbortSignal): Promise<Response> {
    const headers: Record<string, string> = { accept: "text/event-stream" }
    if (after > 0) headers["last-event-id"] = String(after)
    if (this.cookie) headers.cookie = `${this.cookieName()}=${this.cookie}`
    else if (this.password) {
      headers.authorization = `Basic ${Buffer.from(`agent-1:${this.password}`, "utf8").toString("base64")}`
    }
    return fetch(`${this.baseUrl}/v1/events?after=${after}`, { headers, signal })
  }
}
