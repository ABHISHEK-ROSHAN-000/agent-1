export interface Session {
  readonly id: string
  readonly title: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly modelProfileId?: string | null
  readonly summary?: string | null
  readonly summaryThroughSeq?: number | null
}

export type ModelKind = "cloud" | "local"

export interface ModelProfile {
  readonly id: string
  readonly name: string
  readonly kind: ModelKind
  readonly baseUrl: string
  readonly modelId: string
  readonly contextWindow: number
  readonly maxOutputTokens: number
  readonly costInputPerMillion: number
  readonly costOutputPerMillion: number
  readonly supportsTools: boolean
  readonly supportsStreaming: boolean
  readonly hasApiKey: boolean
  readonly createdAt: string
  readonly updatedAt: string
}

export interface ModelProfileInput {
  readonly name: string
  readonly kind: ModelKind
  readonly baseUrl: string
  readonly modelId: string
  readonly contextWindow?: number
  readonly maxOutputTokens?: number
  readonly costInputPerMillion?: number
  readonly costOutputPerMillion?: number
  readonly apiKey?: string
}

export type MessageRole = "user" | "assistant" | "tool" | "system"

export interface Message {
  readonly id: string
  readonly seq: number
  readonly sessionId: string
  readonly turnId: string | null
  readonly role: MessageRole
  readonly text: string
  readonly content: unknown
  readonly createdAt: string
}

export type TurnStatus =
  | "queued"
  | "running"
  | "waiting_approval"
  | "interrupted"
  | "resuming"
  | "completed"
  | "failed"
  | "cancelled"

export interface Turn {
  readonly id: string
  readonly sessionId: string
  readonly status: TurnStatus
  readonly modelProfileId: string
  readonly userMessageId: string
  readonly stepCount: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly costUsd: number
  readonly error: string | null
  readonly startedAt: string
  readonly updatedAt: string
  readonly completedAt: string | null
}

export interface TokenUsage {
  readonly inputTokens: number
  readonly outputTokens: number
  readonly costUsd: number
}

export type RuleEffect = "allow" | "ask" | "deny"
export type ToolRisk = "read" | "write" | "external" | "shell" | "unknown"

export interface PermissionRule {
  readonly id: string
  readonly action: string
  readonly resource: string
  readonly effect: RuleEffect
  readonly position: number
  readonly ttlSeconds: number | null
  readonly expiresAt: string | null
  readonly note: string | null
  readonly createdAt: string
  readonly updatedAt: string
}

export type ApprovalStatus = "pending" | "approved" | "rejected" | "expired" | "invalidated"

export interface Approval {
  readonly id: string
  readonly turnId: string
  readonly sessionId: string
  readonly toolCallId: string
  readonly toolName: string
  readonly arguments: unknown
  readonly argumentsHash: string
  readonly status: ApprovalStatus
  readonly createdAt: string
  readonly expiresAt: string
  readonly decidedAt: string | null
  readonly decidedBy: string | null
  readonly reason: string | null
}

export type WorkspaceAccess = "read" | "write"

export interface Workspace {
  readonly id: string
  readonly label: string
  readonly path: string
  readonly access: WorkspaceAccess
  readonly createdAt: string
  readonly updatedAt: string
}

export type JournalState = "planned" | "applying" | "done" | "failed" | "unknown" | "undone"

export interface JournalEntry {
  readonly id: string
  readonly batchId: string
  readonly turnId: string | null
  readonly sessionId: string | null
  readonly toolName: string
  readonly operation: string
  readonly source: string | null
  readonly target: string | null
  readonly sourceHash: string | null
  readonly targetHash: string | null
  readonly state: JournalState
  readonly undo: unknown
  readonly error: string | null
  readonly createdAt: string
  readonly updatedAt: string
}

export interface AuditEntry {
  readonly id: number
  readonly at: string
  readonly actor: string
  readonly action: string
  readonly resource: string
  readonly decision: string
  readonly ruleId: string | null
  readonly approvalId: string | null
  readonly turnId: string | null
  readonly details: unknown
}

export interface EventRecord {
  readonly seq: number
  readonly type: string
  readonly sessionId: string | null
  readonly payload: unknown
  readonly createdAt: string
}

export interface ServiceState {
  readonly pid: number
  readonly port: number
  readonly url: string
  readonly version: string
  readonly phase: string
  readonly startedAt: string
}

export interface AuthContext {
  readonly kind: "basic" | "cookie"
  readonly sessionId: string | null
}

export interface LoginResult {
  readonly token: string
  readonly expiresAt: string
}

export interface PairingResult {
  readonly code: string
  readonly url: string
  readonly urls: readonly string[]
  readonly expiresAt: string
  readonly expiresIn: number
}

export type RemoteTunnelState = "off" | "starting" | "ready" | "error"

export interface RemoteStatus {
  readonly enabled: boolean
  readonly accepted: boolean
  readonly state: RemoteTunnelState
  readonly route: string
  readonly url?: string
  readonly error?: string
  readonly urls: readonly string[]
}

export interface HealthInfo {
  readonly status: "ok"
  readonly product: string
  readonly version: string
  readonly phase: string
  readonly uptimeSeconds: number
  readonly eventSeq: number
}

export interface InfoResult extends HealthInfo {
  readonly dataDir: string
  readonly capabilities: readonly string[]
}

export interface ApiErrorBody {
  readonly error: {
    readonly code: string
    readonly message: string
    readonly requestId?: string
  }
}
