export class ApiError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
  ) {
    super(message)
    this.name = "ApiError"
  }
}

export interface Session {
  id: string
  title: string
  createdAt: string
  updatedAt: string
  providerId?: string | null
  modelId?: string | null
  reasoningEffort?: string | null
  summary?: string | null
  summaryThroughSeq?: number | null
}

export interface Message {
  id: string
  seq?: number
  sessionId?: string
  turnId?: string | null
  role: "user" | "assistant" | "tool" | "system"
  text: string
  content?: unknown
  createdAt?: string
}

export interface Turn {
  id: string
  sessionId: string
  providerId?: string
  modelId?: string
  reasoningEffort?: string | null
  status:
    | "queued"
    | "running"
    | "waiting_approval"
    | "interrupted"
    | "resuming"
    | "completed"
    | "failed"
    | "cancelled"
  error: string | null
  errorDetails?: {
    kind: string
    message: string
    status?: number
    providerMessage?: string
    retryAfterMs?: number
  } | null
}

export interface Approval {
  id: string
  turnId: string
  sessionId: string
  toolCallId: string
  toolName: string
  arguments: unknown
  argumentsHash: string
  status: "pending" | "approved" | "rejected" | "expired" | "invalidated"
  createdAt: string
  expiresAt: string
  decidedAt: string | null
  decidedBy: string | null
  reason: string | null
}

export interface Rule {
  id: string
  action: string
  resource: string
  effect: "allow" | "ask" | "deny"
  position: number
  ttlSeconds: number | null
  expiresAt: string | null
  note: string | null
}

export interface Workspace {
  id: string
  label: string
  path: string
  access: "read" | "write"
  createdAt: string
  updatedAt: string
}

export interface JournalEntry {
  id: string
  batchId: string
  turnId: string | null
  sessionId: string | null
  toolName: string
  operation: string
  source: string | null
  target: string | null
  sourceHash: string | null
  targetHash: string | null
  state: string
  undo: unknown
  error: string | null
  createdAt: string
  updatedAt: string
}

export interface ProviderCredential {
  id: string
  label: string
  active: boolean
  source: "stored"
}

export interface ProviderInfo {
  id: string
  name: string
  kind: "cloud" | "local"
  baseUrl: string
  connected: boolean
  source: "stored" | "environment" | "none"
  credentials: ProviderCredential[]
  environment: string[]
  modelCount: number
}

export type ReasoningOption =
  | { type: "effort"; values: string[] }
  | { type: "toggle" }
  | { type: "budget_tokens"; min?: number; max?: number }

export interface CatalogModel {
  providerId: string
  modelId: string
  name: string
  family?: string
  contextWindow: number
  maxOutputTokens: number
  inputModalities: string[]
  outputModalities: string[]
  supportsTools: boolean
  supportsTemperature: boolean
  reasoning: boolean
  reasoningOptions: ReasoningOption[]
  costInputPerMillion: number
  costOutputPerMillion: number
  costCacheReadPerMillion: number
  costCacheWritePerMillion: number
  enabled: boolean
  favorite: boolean
  status?: string
}

export interface ModelSelection {
  providerId: string
  modelId: string
  reasoningEffort?: string | null
}

export function modelKey(model: Pick<CatalogModel, "providerId" | "modelId">): string {
  return `${model.providerId}/${model.modelId}`
}

export function parseModelKey(value: string | undefined): ModelSelection | undefined {
  if (!value) return undefined
  const separator = value.indexOf("/")
  if (separator <= 0 || separator === value.length - 1) return undefined
  return { providerId: value.slice(0, separator), modelId: value.slice(separator + 1) }
}

export interface SelectedModel extends ModelSelection {
  name: string
  providerName: string
  contextWindow: number
  maxOutputTokens: number
  supportsTools: boolean
  costInputPerMillion: number
  costOutputPerMillion: number
}

export interface RemoteStatus {
  enabled: boolean
  accepted: boolean
  state: "off" | "starting" | "ready" | "error"
  route: string
  url?: string
  error?: string
  urls: string[]
}

export interface ContextInfo {
  session: Session
  model: SelectedModel | null
  messages: number
  turns: number
  inputTokens: number
  outputTokens: number
  contextTokens: number
  costUsd: number
  lastActivity: string
  contextWindow: number | null
}

export interface ToolInfo {
  name: string
  action: string
  description: string
  risk: string
  readOnly: boolean
}

async function request<T>(method: string, path: string, body?: unknown): Promise<T> {
  const response = await fetch(path, {
    method,
    credentials: "same-origin",
    headers: {
      accept: "application/json",
      ...(body === undefined ? {} : { "content-type": "application/json" }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  const text = await response.text()
  let parsed: unknown = undefined
  try {
    parsed = text ? JSON.parse(text) : undefined
  } catch {
    parsed = undefined
  }
  if (!response.ok) {
    const error = (parsed as { error?: { code?: string; message?: string } } | undefined)?.error
    throw new ApiError(response.status, error?.code ?? "request_failed", error?.message ?? text)
  }
  return parsed as T
}

export const api = {
  info: () =>
    request<{
      status: string
      version: string
      phase: string
      urls: string[]
      remote: RemoteStatus
      capabilities: string[]
      eventSeq: number
      uptimeSeconds: number
    }>("GET", "/v1/info"),
  health: () => request<{ status: string; version: string }>("GET", "/v1/health"),
  login: (password: string) => request<{ ok: true; expiresAt: string }>("POST", "/v1/auth/login", { password }),
  logout: () => request<{ ok: true }>("POST", "/v1/auth/logout", {}),
  rotate: () => request<{ password: string }>("POST", "/v1/auth/rotate", {}),
  sessions: () => request<{ sessions: Session[] }>("GET", "/v1/sessions"),
  createSession: (title?: string) =>
    request<{ session: Session }>("POST", "/v1/sessions", title ? { title } : {}),
  messages: (sessionId: string, limit = 200) =>
    request<{ messages: Message[] }>(
      "GET",
      `/v1/sessions/${encodeURIComponent(sessionId)}/messages?limit=${limit}`,
    ),
  startMessage: (sessionId: string, content: string, selection?: ModelSelection) =>
    request<{ turn: Turn; streamUrl: string }>(
      "POST",
      `/v1/sessions/${encodeURIComponent(sessionId)}/messages`,
      {
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
      },
    ),
  setSessionModel: (sessionId: string, selection: ModelSelection) =>
    request<{ model: SelectedModel }>(
      "PATCH",
      `/v1/sessions/${encodeURIComponent(sessionId)}/model`,
      selection,
    ),
  turn: (turnId: string) =>
    request<{ turn: Turn; messages: Message[] }>("GET", `/v1/turns/${encodeURIComponent(turnId)}`),
  cancelTurn: (turnId: string) =>
    request<{ turn: Turn }>("POST", `/v1/turns/${encodeURIComponent(turnId)}/cancel`, {}),
  context: (sessionId: string) =>
    request<ContextInfo>("GET", `/v1/sessions/${encodeURIComponent(sessionId)}/context`),
  approvals: (status?: string) =>
    request<{ approvals: Approval[] }>("GET", `/v1/approvals${status ? `?status=${status}` : ""}`),
  decideApproval: (id: string, decision: "approve" | "reject", reason?: string) =>
    request<{ approval: Approval }>(
      "POST",
      `/v1/approvals/${encodeURIComponent(id)}/decision`,
      { decision, ...(reason ? { reason } : {}) },
    ),
  rules: () => request<{ rules: Rule[] }>("GET", "/v1/rules"),
  createRule: (input: { action: string; resource: string; effect: string; note?: string }) =>
    request<{ rule: Rule }>("POST", "/v1/rules", input),
  updateRule: (id: string, input: Partial<Rule>) =>
    request<{ rule: Rule }>("PATCH", `/v1/rules/${encodeURIComponent(id)}`, input),
  deleteRule: (id: string) =>
    request<{ ok: true }>("DELETE", `/v1/rules/${encodeURIComponent(id)}`),
  workspaces: () => request<{ workspaces: Workspace[] }>("GET", "/v1/workspaces"),
  addWorkspace: (input: { path: string; label?: string; access: "read" | "write" }) =>
    request<{ workspace: Workspace }>("POST", "/v1/workspaces", input),
  removeWorkspace: (id: string) =>
    request<{ ok: true }>("DELETE", `/v1/workspaces/${encodeURIComponent(id)}`),
  workspaceTree: (id: string, path?: string) =>
    request<{ path: string; entries: Array<{ name: string; path: string; type: string; size: number }> }>(
      "GET",
      `/v1/workspaces/${encodeURIComponent(id)}/tree${path ? `?path=${encodeURIComponent(path)}` : ""}`,
    ),
  workspaceFile: (id: string, path: string) =>
    request<{ path: string; size: number; content: string; sha256: string }>(
      "GET",
      `/v1/workspaces/${encodeURIComponent(id)}/file?path=${encodeURIComponent(path)}`,
    ),
  workspacePaths: (id: string) =>
    request<{ root: string; paths: string[] }>(
      "GET",
      `/v1/workspaces/${encodeURIComponent(id)}/tree?recursive=1`,
    ),
  journal: (limit = 100) => request<{ entries: JournalEntry[] }>("GET", `/v1/journal?limit=${limit}`),
  undoJournal: (batchId?: string) =>
    request<{ batchId: string; undone: number; skipped: number; errors: string[] }>(
      "POST",
      "/v1/journal/undo",
      batchId ? { batchId } : {},
    ),
  providers: () => request<{ providers: ProviderInfo[] }>("GET", "/v1/providers"),
  connectProvider: (id: string, apiKey?: string, label?: string) =>
    request<{ provider: ProviderInfo }>(
      "POST",
      `/v1/providers/${encodeURIComponent(id)}/connect`,
      { ...(apiKey ? { apiKey } : {}), ...(label ? { label } : {}) },
    ),
  refreshProvider: (id: string) =>
    request<{ provider: ProviderInfo }>(
      "POST",
      `/v1/providers/${encodeURIComponent(id)}/refresh`,
      {},
    ),
  removeProviderCredential: (providerId: string, credentialId: string) =>
    request<{ provider: ProviderInfo }>(
      "DELETE",
      `/v1/providers/${encodeURIComponent(providerId)}/credentials/${encodeURIComponent(credentialId)}`,
    ),
  models: (provider?: string, all = false) =>
    request<{ models: CatalogModel[] }>(
      "GET",
      `/v1/models?${new URLSearchParams({
        ...(provider ? { provider } : {}),
        ...(all ? { all: "1" } : {}),
      }).toString()}`,
    ),
  defaultModel: () => request<{ model: CatalogModel | null }>("GET", "/v1/models/default"),
  setDefaultModel: (selection: ModelSelection) =>
    request<{ model: CatalogModel }>("PUT", "/v1/models/default", selection),
  updateModel: (providerId: string, modelId: string, input: { enabled?: boolean; favorite?: boolean }) =>
    request<{ model: CatalogModel }>(
      "PATCH",
      `/v1/models/${encodeURIComponent(providerId)}/${encodeURIComponent(modelId)}`,
      input,
    ),

  tools: () => request<{ tools: ToolInfo[] }>("GET", "/v1/tools"),
  audit: (limit = 100) => request<{ entries: unknown[] }>("GET", `/v1/audit?limit=${limit}`),
}

export type TurnStreamEvent =
  | { type: "status"; status: Turn["status"] }
  | { type: "delta"; text: string }
  | { type: "tool"; phase: "start" | "done"; toolName: string; toolCallId: string }
  | {
      type: "retry"
      attempt: number
      delayMs: number
      message: string
      kind: string
      status?: number
    }
  | { type: "done"; status: Turn["status"] }
  | {
      type: "error"
      message: string
      kind?: string
      status?: number
      retryAfterMs?: number
    }

export interface TurnStreamHandle {
  abort(): void
  done: Promise<void>
}

export function streamTurn(
  turnId: string,
  onEvent: (event: TurnStreamEvent) => void,
): TurnStreamHandle {
  const controller = new AbortController()
  let closed = false
  const done = (async () => {
    try {
      const response = await fetch(`/v1/turns/${encodeURIComponent(turnId)}/stream`, {
        credentials: "same-origin",
        signal: controller.signal,
        headers: { accept: "text/event-stream" },
      })
      if (!response.ok || !response.body) {
        onEvent({ type: "error", message: `Turn stream failed (${response.status})` })
        return
      }
      const reader = response.body.getReader()
      const decoder = new TextDecoder()
      let buffer = ""
      while (!closed) {
        const { done: finished, value } = await reader.read()
        if (finished) break
        buffer += decoder.decode(value, { stream: true })
        let boundary = buffer.indexOf("\n\n")
        while (boundary >= 0) {
          const frame = buffer.slice(0, boundary)
          buffer = buffer.slice(boundary + 2)
          const data = frame
            .split(/\r?\n/)
            .filter((line) => line.startsWith("data:"))
            .map((line) => line.slice(5).trim())
            .join("")
          if (data) {
            try {
              onEvent(JSON.parse(data) as TurnStreamEvent)
            } catch {
              // Ignore malformed frames.
            }
          }
          boundary = buffer.indexOf("\n\n")
        }
      }
    } catch (error) {
      if (!closed) onEvent({ type: "error", message: error instanceof Error ? error.message : String(error) })
    }
  })()
  return {
    abort() {
      closed = true
      controller.abort()
    },
    done,
  }
}

export interface GlobalEvent {
  seq: number
  type: string
  sessionId: string | null
  payload: unknown
  createdAt: string
}

export function subscribeEvents(
  onEvent: (event: GlobalEvent) => void,
  onState: (state: string) => void,
  initialAfter = 0,
): () => void {
  let source: EventSource | undefined
  let stopped = false
  let after = initialAfter
  let retry: ReturnType<typeof setTimeout> | undefined

  const connect = () => {
    if (stopped) return
    source = new EventSource(`/v1/events?after=${after}`)
    source.onopen = () => onState("live")
    source.onerror = () => {
      onState("reconnecting")
      source?.close()
      if (!stopped) retry = setTimeout(connect, 1500)
    }
    source.onmessage = (message) => {
      try {
        const event = JSON.parse(message.data) as GlobalEvent
        after = Math.max(after, event.seq)
        onEvent(event)
      } catch {
        // Ignore heartbeat/comment frames.
      }
    }
  }

  connect()
  return () => {
    stopped = true
    if (retry) clearTimeout(retry)
    source?.close()
  }
}
