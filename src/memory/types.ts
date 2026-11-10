export type MemoryStoreName = "user" | "memory"

export type MemoryOperationAction = "add" | "patch" | "remove"

export interface MemoryOperation {
  readonly action: MemoryOperationAction
  readonly content?: string
  readonly oldText?: string
}

export interface MemoryEntry {
  readonly id: string
  readonly store: MemoryStoreName
  readonly content: string
  readonly position: number
  readonly createdAt: string
  readonly updatedAt: string
}

export interface MemoryUsage {
  readonly chars: number
  readonly limit: number
  readonly percent: number
}

export type MemoryErrorCode =
  | "invalid_target"
  | "empty_operations"
  | "missing_content"
  | "missing_old_text"
  | "not_found"
  | "ambiguous"
  | "repeated_span"
  | "span_not_found"
  | "no_op"
  | "over_limit"
  | "would_empty"
  | "stale_entry"
  | "scan_blocked"
  | "already_decided"
  | "already_undone"
  | "nothing_to_undo"
  | "not_available"

export interface MemoryErrorDetails {
  readonly currentEntries?: readonly string[]
  readonly usage?: MemoryUsage
  readonly requiredFree?: number
  readonly closestEntries?: readonly string[]
  readonly matches?: readonly string[]
  readonly threats?: readonly string[]
}

export class MemoryError extends Error {
  readonly code: MemoryErrorCode
  readonly details: MemoryErrorDetails

  constructor(code: MemoryErrorCode, message: string, details: MemoryErrorDetails = {}) {
    super(message)
    this.name = "MemoryError"
    this.code = code
    this.details = details
  }
}

export interface MemoryStoreResult {
  readonly store: MemoryStoreName
  readonly actions: readonly MemoryOperationAction[]
  readonly changed: boolean
  readonly message: string
  readonly entries: readonly string[]
  readonly usage: MemoryUsage
}

export type MemoryPendingAction = "add" | "patch" | "remove"
export type MemoryPendingStatus = "pending" | "approved" | "rejected" | "expired" | "invalidated"

export interface MemoryPendingPayload {
  readonly action: MemoryPendingAction
  readonly content?: string
  readonly oldText?: string
}

export interface MemoryPendingRecord {
  readonly id: string
  readonly sessionId: string | null
  readonly turnId: string | null
  readonly store: MemoryStoreName
  readonly action: MemoryPendingAction
  readonly payload: MemoryPendingPayload
  readonly summary: string
  readonly origin: string
  readonly status: MemoryPendingStatus
  readonly matchedEntry: string | null
  readonly createdAt: string
  readonly decidedAt: string | null
  readonly decidedBy: string | null
  readonly reason: string | null
}

export interface NewMemoryPending {
  readonly sessionId?: string | null
  readonly turnId?: string | null
  readonly store: MemoryStoreName
  readonly action: MemoryPendingAction
  readonly payload: MemoryPendingPayload
  readonly summary: string
  readonly origin: string
  readonly matchedEntry?: string | null
}

export interface MemoryHistoryRecord {
  readonly id: string
  readonly store: MemoryStoreName
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

export interface MemoryMutation {
  readonly store: MemoryStoreName
  readonly actions: readonly MemoryOperationAction[]
  readonly changed: boolean
  readonly message: string
  readonly entries: readonly string[]
  readonly usage: MemoryUsage
  readonly history: MemoryHistoryRecord | null
}

export interface MemoryStoreSnapshot {
  readonly store: MemoryStoreName
  readonly entries: readonly string[]
  readonly usage: MemoryUsage
  readonly block: string | null
}

export interface MemorySnapshot {
  readonly user: MemoryStoreSnapshot
  readonly memory: MemoryStoreSnapshot
  readonly generatedAt: string
}

export interface CommitMemoryMutation {
  readonly store: MemoryStoreName
  readonly entries: readonly string[]
  readonly before: readonly string[]
  readonly after: readonly string[]
  readonly action: string
  readonly actor: string
  readonly note?: string | null
  readonly pendingId?: string | null
  readonly pendingDecision?: "approved" | "rejected" | "expired" | "invalidated"
  readonly pendingDecidedBy?: string | null
  readonly undoHistoryId?: string | null
}
