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

export type ActiveTurnStatus = "queued" | "running" | "waiting_approval" | "resuming"

export interface ActiveSessionEntry {
  status: ActiveTurnStatus
  turnId: string
}

export interface ActiveTurn {
  id: string
  status: ActiveTurnStatus
  startedAt: string
  updatedAt: string
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
  files?: Array<{ uri: string; mime: string; name?: string; bytes?: number; width?: number; height?: number }>
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

export type ApprovalScope = "once" | "session" | "always"

export interface Approval {
  id: string
  turnId: string
  sessionId: string
  toolCallId: string
  toolName: string
  action: string
  resource: string
  patternKey: string
  arguments: unknown
  argumentsHash: string
  displayCommand: string | null
  status: "pending" | "approved" | "rejected" | "expired" | "invalidated"
  createdAt: string
  expiresAt: string
  decidedAt: string | null
  decidedBy: string | null
  reason: string | null
  scope: ApprovalScope | null
}

export interface ApprovalGrant {
  id: string
  sessionId: string | null
  scope: "session" | "always"
  action: string
  resource: string
  patternKey: string
  createdAt: string
  expiresAt: string | null
}

export interface ApprovalConfig {
  mode: "smart" | "manual" | "off"
  timeoutSeconds: number
  deny: string[]
  allowlist: string[]
  writeSafeRoot: string | null
  smartModel: string | null
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

export interface Checkpoint {
  id: string
  sessionId: string | null
  turnId: string | null
  rootPath: string
  rootHash: string
  commit: string
  reason: string
  filesChanged: number
  insertions: number
  deletions: number
  createdAt: string
}

export interface CheckpointDiff {
  checkpointId: string
  stat: string
  diff: string
  files: Array<{ path: string; status: string; additions: number; deletions: number }>
}

export interface CheckpointRestoreResult {
  checkpointId: string
  restoredTo: string
  restoredFiles: string[]
  deletedFiles: string[]
  skippedUserEdits: string[]
  skippedOversize: string[]
  failedDeletes: string[]
  failedRestores: string[]
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
  activeTurn: ActiveTurn | null
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
  approvalRequired?: boolean
}

export interface MemoryUsage {
  chars: number
  limit: number
  percent: number
}

export interface MemoryStoreView {
  store: "user" | "memory"
  entries: string[]
  usage: MemoryUsage
  block: string | null
}

export interface MemoryPendingRecord {
  id: string
  sessionId: string | null
  turnId: string | null
  store: "user" | "memory"
  action: "add" | "patch" | "remove"
  payload: { action: "add" | "patch" | "remove"; content?: string; oldText?: string }
  summary: string
  origin: string
  status: "pending" | "approved" | "rejected" | "expired" | "invalidated"
  matchedEntry: string | null
  createdAt: string
  decidedAt: string | null
  decidedBy: string | null
  reason: string | null
}

export interface MemoryHistoryRecord {
  id: string
  store: "user" | "memory"
  action: string
  before: string[]
  after: string[]
  pendingId: string | null
  actor: string
  note: string | null
  createdAt: string
  undoneAt: string | null
  undoHistoryId: string | null
}

export interface MemoryMutationResult {
  store: "user" | "memory"
  actions: string[]
  changed: boolean
  message: string
  entries: string[]
  usage: MemoryUsage
  history: MemoryHistoryRecord | null
}

export interface SessionSearchResult {
  ok: boolean
  mode?: "discover" | "read" | "browse" | "scroll"
  query?: string
  sessionId?: string
  title?: string
  results?: Array<{
    sessionId: string
    title: string
    updatedAt: string
    matches: Array<{
      messageId: string
      role: string
      snippet: string
      text: string
      createdAt: string
    }>
  }>
  sessions?: Array<{ id: string; title: string; updatedAt: string }>
  messages?: Array<{
    id: string
    seq: number
    role: string
    text: string
    createdAt: string
    sessionId: string
  }>
  count?: number
  total?: number
  truncated?: boolean
  messagesBefore?: number
  messagesAfter?: number
  window?: number
  error?: string
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
  activeSessions: () =>
    request<{ active: Record<string, ActiveSessionEntry> }>("GET", "/v1/sessions/active"),
  sessionContext: (sessionId: string) =>
    request<{ session: Session; activeTurn: ActiveTurn | null }>(
      "GET",
      `/v1/sessions/${encodeURIComponent(sessionId)}/context`,
    ),
  createSession: (title?: string) =>
    request<{ session: Session }>("POST", "/v1/sessions", title ? { title } : {}),
  renameSession: (sessionId: string, title: string) =>
    request<{ session: Session }>("PATCH", `/v1/sessions/${encodeURIComponent(sessionId)}`, { title }),
  deleteSession: (sessionId: string) =>
    request<{ ok: true }>("DELETE", `/v1/sessions/${encodeURIComponent(sessionId)}`),
  messages: (sessionId: string, limit = 200) =>
    request<{ messages: Message[] }>(
      "GET",
      `/v1/sessions/${encodeURIComponent(sessionId)}/messages?limit=${limit}`,
    ),
  mediaUrl: (uri: string) =>
    uri.startsWith("media:") ? `/v1/media/${encodeURIComponent(uri.slice(6))}` : uri,
  startMessage: (
    sessionId: string,
    content: string,
    selection?: ModelSelection,
    files?: Array<{ uri: string; name?: string; source?: { type: "inline" } | { type: "uri"; uri: string } }>,
  ) =>
    request<{ turn: Turn; streamUrl: string }>(
      "POST",
      `/v1/sessions/${encodeURIComponent(sessionId)}/messages`,
      {
        content,
        ...(files && files.length > 0 ? { files } : {}),
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
  decideApproval: (id: string, decision: "approve" | "reject", options?: { reason?: string; scope?: ApprovalScope }) =>
    request<{ approval: Approval }>(
      "POST",
      `/v1/approvals/${encodeURIComponent(id)}/decision`,
      {
        decision,
        ...(options?.scope ? { scope: options.scope } : {}),
        ...(options?.reason ? { reason: options.reason } : {}),
      },
    ),
  approvalConfig: () => request<{ config: ApprovalConfig }>("GET", "/v1/approval-config"),
  setApprovalConfig: (input: Partial<ApprovalConfig>) =>
    request<{ config: ApprovalConfig }>("PATCH", "/v1/approval-config", input),
  approvalGrants: () => request<{ grants: ApprovalGrant[] }>("GET", "/v1/approval-grants"),
  deleteApprovalGrant: (id: string) =>
    request<{ ok: true }>("DELETE", `/v1/approval-grants/${encodeURIComponent(id)}`),
  rules: () => request<{ rules: Rule[] }>("GET", "/v1/rules"),
  createRule: (input: { action: string; resource: string; effect: string; note?: string }) =>
    request<{ rule: Rule }>("POST", "/v1/rules", input),
  updateRule: (id: string, input: Partial<Rule>) =>
    request<{ rule: Rule }>("PATCH", `/v1/rules/${encodeURIComponent(id)}`, input),
  deleteRule: (id: string) =>
    request<{ ok: true }>("DELETE", `/v1/rules/${encodeURIComponent(id)}`),
  checkpoints: (limit = 100, sessionId?: string) =>
    request<{ checkpoints: Checkpoint[] }>(
      "GET",
      `/v1/checkpoints?limit=${limit}${sessionId ? `&sessionId=${encodeURIComponent(sessionId)}` : ""}`,
    ),
  checkpoint: (id: string) =>
    request<{ checkpoint: Checkpoint }>("GET", `/v1/checkpoints/${encodeURIComponent(id)}`),
  checkpointDiff: (id: string) =>
    request<{ diff: CheckpointDiff }>("GET", `/v1/checkpoints/${encodeURIComponent(id)}/diff`),
  restoreCheckpoint: (id: string, input: { filePath?: string; safe?: boolean } = {}) =>
    request<{ result: CheckpointRestoreResult }>(
      "POST",
      `/v1/checkpoints/${encodeURIComponent(id)}/restore`,
      input,
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
  memory: () =>
    request<{
      generatedAt: string
      user: MemoryStoreView
      memory: MemoryStoreView
      pending: MemoryPendingRecord[]
      history: MemoryHistoryRecord[]
    }>("GET", "/v1/memory"),
  updateMemory: (input: {
    store: "user" | "memory"
    operations: Array<{ action: "add" | "patch" | "remove"; content?: string; oldText?: string }>
  }) => request<{ mutation: MemoryMutationResult }>("PATCH", "/v1/memory", input),
  memoryPending: () => request<{ pending: MemoryPendingRecord[] }>("GET", "/v1/memory/pending"),
  decideMemoryPending: (id: string, decision: "approve" | "reject", reason?: string) =>
    request<{ mutation?: MemoryMutationResult; pending: MemoryPendingRecord[] }>(
      "POST",
      `/v1/memory/pending/${encodeURIComponent(id)}/decision`,
      { decision, ...(reason ? { reason } : {}) },
    ),
  undoMemory: (historyId?: string) =>
    request<{ mutation: MemoryMutationResult }>(
      "POST",
      "/v1/memory/undo",
      historyId ? { historyId } : {},
    ),
  searchSessions: (input: {
    query?: string
    sessionId?: string
    aroundMessageId?: string
    window?: number
    limit?: number
    sort?: "relevance" | "newest" | "oldest"
    roleFilter?: string
  } = {}) => {
    const params = new URLSearchParams()
    for (const [key, value] of Object.entries(input)) {
      if (value !== undefined && value !== "") params.set(key, String(value))
    }
    return request<SessionSearchResult>("GET", `/v1/sessions/search?${params.toString()}`)
  },
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
      if (!stopped) retry = setTimeout(connect, 1000)
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
