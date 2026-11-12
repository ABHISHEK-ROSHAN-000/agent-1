export interface Session {
  readonly id: string
  readonly title: string
  readonly createdAt: string
  readonly updatedAt: string
  readonly providerId?: string | null
  readonly modelId?: string | null
  readonly reasoningEffort?: string | null
  readonly summary?: string | null
  readonly summaryThroughSeq?: number | null
  readonly memorySnapshotJson?: string | null
  readonly memorySnapshotAt?: string | null
}

export type ReasoningOption =
  | { readonly type: "effort"; readonly values: readonly string[] }
  | { readonly type: "toggle" }
  | { readonly type: "budget_tokens"; readonly min?: number; readonly max?: number }

export type ProviderKind = "cloud" | "local"
export type CredentialSource = "stored" | "environment" | "none"

export interface ProviderCredential {
  readonly id: string
  readonly label: string
  readonly active: boolean
  readonly source: "stored"
}

export interface ProviderInfo {
  readonly id: string
  readonly name: string
  readonly kind: ProviderKind
  readonly baseUrl: string
  readonly connected: boolean
  readonly source: CredentialSource
  readonly credentials: readonly ProviderCredential[]
  readonly environment: readonly string[]
  readonly modelCount: number
}

export interface CatalogModel {
  readonly providerId: string
  readonly modelId: string
  readonly name: string
  readonly family?: string
  readonly contextWindow: number
  readonly maxOutputTokens: number
  readonly inputModalities: readonly string[]
  readonly outputModalities: readonly string[]
  readonly supportsTools: boolean
  readonly supportsTemperature: boolean
  readonly reasoning: boolean
  readonly reasoningOptions: readonly ReasoningOption[]
  readonly costInputPerMillion: number
  readonly costOutputPerMillion: number
  readonly costCacheReadPerMillion: number
  readonly costCacheWritePerMillion: number
  readonly enabled: boolean
  readonly favorite: boolean
  readonly status?: string
}

export interface ModelSelection {
  readonly providerId: string
  readonly modelId: string
  readonly reasoningEffort?: string | null
}

export interface SelectedModel extends ModelSelection {
  readonly name: string
  readonly providerName: string
  readonly contextWindow: number
  readonly maxOutputTokens: number
  readonly supportsTools: boolean
  readonly costInputPerMillion: number
  readonly costOutputPerMillion: number
}

export type MessageRole = "user" | "assistant" | "tool" | "system"

export type FileSource =
  | { readonly type: "inline" }
  | { readonly type: "uri"; readonly uri: string }

export interface PromptMention {
  readonly start: number
  readonly end: number
  readonly text: string
}

export interface PromptFileInput {
  readonly uri: string
  readonly source?: FileSource
  readonly name?: string
  readonly description?: string
  readonly mention?: PromptMention
}

export interface StoredFile {
  readonly uri: `media:${string}`
  readonly mime: string
  readonly source: FileSource
  readonly name?: string
  readonly description?: string
  readonly mention?: PromptMention
  readonly bytes?: number
  readonly width?: number
  readonly height?: number
}

export interface HydratedFile extends StoredFile {
  readonly data: string
}

export interface Message {
  readonly id: string
  readonly seq: number
  readonly sessionId: string
  readonly turnId: string | null
  readonly role: MessageRole
  readonly text: string
  readonly content: unknown
  readonly files?: readonly StoredFile[]
  readonly createdAt: string
}

export type InboxDelivery = "steer" | "queue"

export interface InboxUserPayload {
  readonly text: string
  readonly files?: readonly StoredFile[]
  readonly metadata?: Readonly<Record<string, unknown>>
}

export interface InboxUserItem {
  readonly id: string
  readonly sessionId: string
  readonly type: "user"
  readonly delivery: InboxDelivery
  readonly payload: InboxUserPayload
  readonly createdAt: string
}

/** Pending session input. Only user prompts are admitted in Phase 8E. */
export type InboxItem = InboxUserItem

export type TurnStatus =
  | "queued"
  | "running"
  | "waiting_approval"
  | "interrupted"
  | "resuming"
  | "completed"
  | "failed"
  | "cancelled"

export interface TurnErrorDetails {
  readonly kind: string
  readonly message: string
  readonly status?: number
  readonly providerMessage?: string
  readonly retryAfterMs?: number
}

export interface Turn {
  readonly id: string
  readonly sessionId: string
  readonly status: TurnStatus
  readonly providerId: string
  readonly modelId: string
  readonly reasoningEffort?: string | null
  readonly userMessageId: string
  readonly stepCount: number
  readonly inputTokens: number
  readonly outputTokens: number
  readonly costUsd: number
  readonly error: string | null
  readonly errorDetails?: TurnErrorDetails | null
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
export type ApprovalMode = "smart" | "manual" | "off"
export type ApprovalScope = "once" | "session" | "always"

export interface Approval {
  readonly id: string
  readonly turnId: string
  readonly sessionId: string
  readonly toolCallId: string
  readonly toolName: string
  readonly action: string
  readonly resource: string
  readonly patternKey: string
  readonly arguments: unknown
  readonly argumentsHash: string
  readonly displayCommand: string | null
  readonly status: ApprovalStatus
  readonly createdAt: string
  readonly expiresAt: string
  readonly decidedAt: string | null
  readonly decidedBy: string | null
  readonly reason: string | null
  readonly scope: ApprovalScope | null
}

export interface ApprovalGrant {
  readonly id: string
  readonly sessionId: string | null
  readonly scope: "session" | "always"
  readonly action: string
  readonly resource: string
  readonly patternKey: string
  readonly createdAt: string
  readonly expiresAt: string | null
}

export interface ApprovalConfig {
  readonly mode: ApprovalMode
  readonly timeoutSeconds: number
  readonly deny: readonly string[]
  readonly allowlist: readonly string[]
  readonly writeSafeRoot: string | null
  readonly smartModel: string | null
}

export interface Checkpoint {
  readonly id: string
  readonly sessionId: string | null
  readonly turnId: string | null
  readonly rootPath: string
  readonly rootHash: string
  readonly commit: string
  readonly reason: string
  readonly filesChanged: number
  readonly insertions: number
  readonly deletions: number
  readonly createdAt: string
}

export interface CheckpointDiff {
  readonly checkpointId: string
  readonly stat: string
  readonly diff: string
  readonly files: readonly {
    readonly path: string
    readonly status: string
    readonly additions: number
    readonly deletions: number
  }[]
}

export interface CheckpointRestoreResult {
  readonly checkpointId: string
  readonly restoredTo: string
  readonly restoredFiles: readonly string[]
  readonly deletedFiles: readonly string[]
  readonly skippedUserEdits: readonly string[]
  readonly skippedOversize: readonly string[]
  readonly failedDeletes: readonly string[]
  readonly failedRestores: readonly string[]
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
