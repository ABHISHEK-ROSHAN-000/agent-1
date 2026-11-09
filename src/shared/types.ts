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
  readonly token: string
  readonly expiresAt: string
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
