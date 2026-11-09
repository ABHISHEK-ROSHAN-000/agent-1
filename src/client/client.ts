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
