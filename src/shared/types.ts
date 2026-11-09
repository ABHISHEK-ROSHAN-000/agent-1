export interface Session {
  readonly id: string
  readonly title: string
  readonly createdAt: string
  readonly updatedAt: string
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
