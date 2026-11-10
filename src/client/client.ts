import type {
  Approval,
  ApprovalStatus,
  AuditEntry,
  CatalogModel,
  JournalEntry,
  ModelSelection,
  PermissionRule,
  ProviderInfo,
  RemoteStatus,
  SelectedModel,
  Turn,
  Workspace,
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
    if (this.cookie) headers.cookie = `agent1_session=${this.cookie}`
    else if (this.password) {
      headers.authorization = `Basic ${Buffer.from(`agent-1:${this.password}`, "utf8").toString("base64")}`
    }

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
      const match = /(?:^|,\s*)agent1_session=([^;]+)/.exec(setCookie)
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

  listMessages(
    sessionId: string,
    limit = 100,
  ): Promise<{ messages: Array<Record<string, unknown>> }> {
    return this.request(
      "GET",
      `/v1/sessions/${encodeURIComponent(sessionId)}/messages?limit=${limit}`,
    )
  }

  startMessage(
    sessionId: string,
    content: string,
    selection?: ModelSelection,
  ): Promise<{ turn: Turn; streamUrl: string }> {
    return this.request("POST", `/v1/sessions/${encodeURIComponent(sessionId)}/messages`, {
      content,
      ...(selection
        ? {
            providerId: selection.providerId,
            modelId: selection.modelId,
            ...(selection.reasoningEffort !== undefined
              ? { reasoningEffort: selection.reasoningEffort }
              : {}),
          }
        : {}),
    })
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
    if (this.cookie) headers.cookie = `agent1_session=${this.cookie}`
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
    options?: { reason?: string; arguments?: unknown },
  ): Promise<{ approval: Approval }> {
    return this.request("POST", `/v1/approvals/${encodeURIComponent(id)}/decision`, {
      decision,
      ...(options?.reason ? { reason: options.reason } : {}),
      ...(options && options.arguments !== undefined ? { arguments: options.arguments } : {}),
    })
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
    }>
  }> {
    return this.request("GET", "/v1/tools")
  }

  listWorkspaces(): Promise<{ workspaces: Workspace[] }> {
    return this.request("GET", "/v1/workspaces")
  }

  addWorkspace(input: {
    path: string
    label?: string
    access?: "read" | "write"
  }): Promise<{ workspace: Workspace }> {
    return this.request("POST", "/v1/workspaces", input)
  }

  removeWorkspace(id: string): Promise<{ ok: true }> {
    return this.request("DELETE", `/v1/workspaces/${encodeURIComponent(id)}`)
  }

  listJournal(limit = 100): Promise<{ entries: JournalEntry[] }> {
    return this.request("GET", `/v1/journal?limit=${limit}`)
  }

  getJournal(id: string): Promise<{ entry: JournalEntry }> {
    return this.request("GET", `/v1/journal/${encodeURIComponent(id)}`)
  }

  undoJournal(batchId?: string): Promise<{
    batchId: string
    undone: number
    skipped: number
    errors: string[]
  }> {
    return this.request("POST", "/v1/journal/undo", batchId ? { batchId } : {})
  }

  stop(): Promise<{ ok: true }> {
    return this.request("POST", "/v1/system/stop", {})
  }

  async eventsResponse(after = 0, signal?: AbortSignal): Promise<Response> {
    const headers: Record<string, string> = { accept: "text/event-stream" }
    if (after > 0) headers["last-event-id"] = String(after)
    if (this.cookie) headers.cookie = `agent1_session=${this.cookie}`
    else if (this.password) {
      headers.authorization = `Basic ${Buffer.from(`agent-1:${this.password}`, "utf8").toString("base64")}`
    }
    return fetch(`${this.baseUrl}/v1/events?after=${after}`, { headers, signal })
  }
}
