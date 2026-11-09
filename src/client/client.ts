import type {
  Approval,
  ApprovalStatus,
  AuditEntry,
  ModelProfile,
  ModelProfileInput,
  PermissionRule,
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

  info(): Promise<Record<string, unknown>> {
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

  async pair(): Promise<{ url: string; expiresAt: string }> {
    return this.request("POST", "/v1/auth/pair", {})
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
    modelProfileId?: string,
  ): Promise<{ turn: Turn; streamUrl: string }> {
    return this.request("POST", `/v1/sessions/${encodeURIComponent(sessionId)}/messages`, {
      content,
      ...(modelProfileId ? { modelProfileId } : {}),
    })
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

  listModelProfiles(): Promise<{ profiles: ModelProfile[] }> {
    return this.request("GET", "/v1/model-profiles")
  }

  createModelProfile(input: ModelProfileInput): Promise<{ profile: ModelProfile }> {
    return this.request("POST", "/v1/model-profiles", input)
  }

  updateModelProfile(
    id: string,
    input: Partial<ModelProfileInput> & { supportsTools?: boolean },
  ): Promise<{ profile: ModelProfile }> {
    return this.request("PATCH", `/v1/model-profiles/${encodeURIComponent(id)}`, input)
  }

  removeModelProfile(id: string): Promise<{ ok: true }> {
    return this.request("DELETE", `/v1/model-profiles/${encodeURIComponent(id)}`)
  }

  testModelProfile(id: string): Promise<{
    ok: boolean
    text: string
    supportsTools: boolean
    latencyMs: number
  }> {
    return this.request("POST", `/v1/model-profiles/${encodeURIComponent(id)}/test`, {})
  }

  setDefaultModelProfile(id: string): Promise<{ ok: true; profile: ModelProfile }> {
    return this.request("POST", `/v1/model-profiles/${encodeURIComponent(id)}/default`, {})
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
