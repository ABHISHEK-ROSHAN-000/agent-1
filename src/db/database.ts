import { Effect, ManagedRuntime } from "effect"
import { SqlClient } from "effect/sql"
import type { SqlError } from "effect/sql/SqlError"
import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-bun"
import { mkdirSync } from "node:fs"
import path from "node:path"
import type {
  Approval,
  ApprovalGrant,
  ApprovalScope,
  ApprovalStatus,
  AuditEntry,
  Checkpoint,
  EventRecord,
  InboxDelivery,
  InboxItem,
  Message,
  StoredFile,
  MessageRole,
  PermissionRule,
  RuleEffect,
  Session,
  TokenUsage,
  Turn,
  TurnErrorDetails,
  TurnStatus,
} from "../shared/types"
import { newId } from "../core/ids"
import { nowIso } from "../core/time"
import type {
  CommitMemoryMutation,
  MemoryEntry,
  MemoryHistoryRecord,
  MemoryPendingRecord,
  MemoryPendingStatus,
  MemoryReviewRun,
  MemoryReviewStatus,
  MemoryStoreName,
  NewMemoryPending,
  NewMemoryReviewRun,
} from "../memory/types"
import type { SessionSearchHit } from "../memory/session-search-types"
import { backupIfNeeded, schemaVersion } from "./backup"
import { LATEST_SCHEMA_VERSION, migrationLoader } from "./migrations"

interface SessionRow {
  readonly id: string
  readonly title: string
  readonly created_at: string
  readonly updated_at: string
  readonly provider_id: string | null
  readonly model_id: string | null
  readonly reasoning_effort: string | null
  readonly summary: string | null
  readonly summary_through_seq: number | null
  readonly memory_snapshot_json: string | null
  readonly memory_snapshot_at: string | null
}

export interface ProviderRecord {
  readonly id: string
  readonly name: string
  readonly kind: "cloud" | "local"
  readonly baseUrl: string
  readonly env: readonly string[]
  readonly headers: Readonly<Record<string, string>>
  readonly enabled: boolean
  readonly createdAt: string
  readonly updatedAt: string
}

interface ProviderRow {
  readonly id: string
  readonly name: string
  readonly kind: "cloud" | "local"
  readonly base_url: string
  readonly env_json: string
  readonly headers_json: string | null
  readonly enabled: number
  readonly created_at: string
  readonly updated_at: string
}

export interface ProviderCredentialRecord {
  readonly id: string
  readonly providerId: string
  readonly label: string
  readonly active: boolean
  readonly createdAt: string
  readonly updatedAt: string
}

interface ProviderCredentialRow {
  readonly id: string
  readonly provider_id: string
  readonly label: string
  readonly active: number
  readonly created_at: string
  readonly updated_at: string
}

interface ProviderModelRow {
  readonly provider_id: string
  readonly model_id: string
  readonly name: string
  readonly family: string | null
  readonly type: string
  readonly released_at: string | null
  readonly status: string | null
  readonly context_limit: number
  readonly output_limit: number
  readonly input_modalities_json: string
  readonly output_modalities_json: string
  readonly tools_supported: number
  readonly temperature_supported: number
  readonly reasoning: number
  readonly reasoning_options_json: string
  readonly cost_input: number
  readonly cost_output: number
  readonly cost_cache_read: number
  readonly cost_cache_write: number
  readonly enabled: number
  readonly favorite: number
  readonly last_used_at: string | null
  readonly metadata_json: string
  readonly updated_at: string
}

interface MessageRow {
  readonly id: string
  readonly seq: number
  readonly session_id: string
  readonly turn_id: string | null
  readonly role: "user" | "assistant" | "tool" | "system"
  readonly text: string
  readonly content_json: string
  readonly files_json: string | null
  readonly created_at: string
}

interface BlobRow {
  readonly hash: string
  readonly mime: string
  readonly bytes: number
  readonly width: number | null
  readonly height: number | null
  readonly data: Uint8Array
}

interface BlobRefRow {
  readonly hash: string
}

interface TurnRow {
  readonly id: string
  readonly session_id: string
  readonly status: string
  readonly provider_id: string
  readonly model_id: string
  readonly user_message_id: string
  readonly step_count: number
  readonly input_tokens: number
  readonly output_tokens: number
  readonly cost_usd: number
  readonly error: string | null
  readonly error_details_json: string | null
  readonly reasoning_effort: string | null
  readonly started_at: string
  readonly updated_at: string
  readonly completed_at: string | null
}

interface TurnStateCheckpointRow {
  readonly step: number
  readonly state_json: string
  readonly created_at: string
}

interface PermissionRuleRow {
  readonly id: string
  readonly action: string
  readonly resource: string
  readonly effect: RuleEffect
  readonly position: number
  readonly ttl_seconds: number | null
  readonly expires_at: string | null
  readonly note: string | null
  readonly created_at: string
  readonly updated_at: string
}

interface ApprovalRow {
  readonly id: string
  readonly turn_id: string
  readonly session_id: string
  readonly tool_call_id: string
  readonly tool_name: string
  readonly action: string
  readonly resource: string
  readonly pattern_key: string
  readonly arguments_json: string
  readonly arguments_hash: string
  readonly display_command: string | null
  readonly status: ApprovalStatus
  readonly created_at: string
  readonly expires_at: string
  readonly decided_at: string | null
  readonly decided_by: string | null
  readonly reason: string | null
  readonly scope: ApprovalScope | null
}

interface ApprovalGrantRow {
  readonly id: string
  readonly session_id: string | null
  readonly scope: "session" | "always"
  readonly action: string
  readonly resource: string
  readonly pattern_key: string
  readonly created_at: string
  readonly expires_at: string | null
}

interface CheckpointRow {
  readonly id: string
  readonly session_id: string | null
  readonly turn_id: string | null
  readonly root_path: string
  readonly root_hash: string
  readonly commit_sha: string
  readonly reason: string
  readonly files_changed: number
  readonly insertions: number
  readonly deletions: number
  readonly created_at: string
}

interface AuditRow {
  readonly id: number
  readonly at: string
  readonly actor: string
  readonly action: string
  readonly resource: string
  readonly decision: string
  readonly rule_id: string | null
  readonly approval_id: string | null
  readonly turn_id: string | null
  readonly details_json: string
}

interface MemoryEntryRow {
  readonly id: string
  readonly store: MemoryStoreName
  readonly content: string
  readonly position: number
  readonly created_at: string
  readonly updated_at: string
}

interface MemoryPendingRow {
  readonly id: string
  readonly session_id: string | null
  readonly turn_id: string | null
  readonly store: MemoryStoreName
  readonly action: "add" | "patch" | "remove"
  readonly payload_json: string
  readonly summary: string
  readonly origin: string
  readonly status: MemoryPendingStatus
  readonly matched_entry: string | null
  readonly created_at: string
  readonly decided_at: string | null
  readonly decided_by: string | null
  readonly reason: string | null
}

interface MemoryHistoryRow {
  readonly id: string
  readonly store: MemoryStoreName
  readonly action: string
  readonly before_json: string
  readonly after_json: string
  readonly pending_id: string | null
  readonly actor: string
  readonly note: string | null
  readonly created_at: string
  readonly undone_at: string | null
  readonly undo_history_id: string | null
}

interface MemoryReviewRunRow {
  readonly id: string
  readonly session_id: string
  readonly status: MemoryReviewStatus
  readonly trigger: MemoryReviewRun["trigger"]
  readonly provider_id: string | null
  readonly model_id: string | null
  readonly turns_since_memory: number
  readonly input_tokens: number
  readonly output_tokens: number
  readonly error: string | null
  readonly started_at: string
  readonly completed_at: string | null
}

interface SessionSearchHitRow {
  readonly message_id: string
  readonly seq: number
  readonly session_id: string
  readonly session_title: string
  readonly session_updated_at: string
  readonly role: MessageRole
  readonly text: string
  readonly snippet: string | null
  readonly created_at: string
}

interface EventRow {
  readonly seq: number
  readonly type: string
  readonly session_id: string | null
  readonly payload: string
  readonly created_at: string
}

interface InboxRow {
  readonly id: string
  readonly session_id: string
  readonly type: string
  readonly payload_json: string
  readonly delivery: InboxDelivery
  readonly enqueued_seq: number
  readonly created_at: string
}

interface SettingRow {
  readonly value: string
}

interface AuthSessionRow {
  readonly id: string
  readonly expires_at: string
}

interface PairingRow {
  readonly id: string
}

interface IdempotencyRow {
  readonly key: string
  readonly method: string
  readonly path: string
  readonly status: number
  readonly response: string
  readonly expires_at: string
}

export interface NewMessage {
  readonly role: MessageRole
  readonly text: string
  readonly content: unknown
  readonly files?: readonly StoredFile[]
}

export interface BlobInput {
  readonly hash: string
  readonly mime: string
  readonly bytes: number
  readonly width?: number | null
  readonly height?: number | null
  readonly data: Uint8Array
}

export interface StoredBlob extends BlobInput {
  readonly data: Uint8Array
}

export interface TurnStepInput {
  readonly step: number
  readonly sessionId: string
  readonly turnId?: string
  readonly messages?: readonly NewMessage[]
  readonly checkpoint: unknown
  readonly usage?: TokenUsage
  readonly status?: TurnStatus
  readonly error?: string | null
  readonly errorDetails?: TurnErrorDetails | null
}

export interface InboxAdmissionResult {
  readonly item: InboxItem
  readonly pending: boolean
  readonly event: EventRecord | null
}

export interface InboxStepResult {
  readonly messages: Message[]
  readonly delivered: InboxItem[]
  readonly events: EventRecord[]
  readonly status: TurnStatus
}

export class InboxConflictError extends Error {
  readonly code = "inbox_conflict"

  constructor(message = "Inbox item conflicts with an existing message") {
    super(message)
    this.name = "InboxConflictError"
  }
}

export interface InboxMutationResult {
  readonly item: InboxItem | null
  readonly event: EventRecord | null
}

export interface CreatedTurnFromInbox {
  readonly turn: Turn
  readonly userMessage: Message
  readonly item: InboxItem
  readonly event: EventRecord
}

export interface IdempotencyRecord {
  readonly key: string
  readonly method: string
  readonly path: string
  readonly status: number
  readonly response: string
  readonly expiresAt: string
}

export interface AuthSessionRecord {
  readonly id: string
  readonly expiresAt: string
}

export interface CreatedSession {
  readonly session: Session
  readonly event: EventRecord
}

type DatabaseRuntime = ManagedRuntime.ManagedRuntime<
  SqliteClient.SqliteClient | SqlClient.SqlClient,
  SqlError
>

function rowToSession(row: SessionRow): Session {
  return {
    id: row.id,
    title: row.title,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    providerId: row.provider_id,
    modelId: row.model_id,
    reasoningEffort: row.reasoning_effort,
    summary: row.summary,
    summaryThroughSeq: row.summary_through_seq,
    memorySnapshotJson: row.memory_snapshot_json,
    memorySnapshotAt: row.memory_snapshot_at,
  }
}

function jsonStrings(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []
  } catch {
    return []
  }
}

function jsonReasoningOptions(value: string): import("../shared/types").ReasoningOption[] {
  try {
    const parsed = JSON.parse(value) as unknown
    if (!Array.isArray(parsed)) return []
    return parsed.flatMap((item): import("../shared/types").ReasoningOption[] => {
      if (!item || typeof item !== "object") return []
      const option = item as Record<string, unknown>
      if (option.type === "effort" && Array.isArray(option.values)) {
        const values = option.values.filter((entry): entry is string => typeof entry === "string")
        return values.length > 0 ? [{ type: "effort", values }] : []
      }
      if (option.type === "toggle") return [{ type: "toggle" }]
      if (option.type === "budget_tokens") {
        return [
          {
            type: "budget_tokens",
            ...(typeof option.min === "number" ? { min: option.min } : {}),
            ...(typeof option.max === "number" ? { max: option.max } : {}),
          },
        ]
      }
      return []
    })
  } catch {
    return []
  }
}

function rowToProvider(row: ProviderRow): ProviderRecord {
  let headers: Record<string, string> = {}
  try {
    const parsed = row.headers_json ? (JSON.parse(row.headers_json) as unknown) : {}
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      headers = Object.fromEntries(
        Object.entries(parsed).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
      )
    }
  } catch {
    headers = {}
  }
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    baseUrl: row.base_url,
    env: jsonStrings(row.env_json),
    headers,
    enabled: row.enabled === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function rowToProviderCredential(row: ProviderCredentialRow): ProviderCredentialRecord {
  return {
    id: row.id,
    providerId: row.provider_id,
    label: row.label,
    active: row.active === 1,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function rowToCatalogModel(row: ProviderModelRow): import("../shared/types").CatalogModel {
  return {
    providerId: row.provider_id,
    modelId: row.model_id,
    name: row.name,
    ...(row.family ? { family: row.family } : {}),
    contextWindow: row.context_limit,
    maxOutputTokens: row.output_limit,
    inputModalities: jsonStrings(row.input_modalities_json),
    outputModalities: jsonStrings(row.output_modalities_json),
    supportsTools: row.tools_supported === 1,
    supportsTemperature: row.temperature_supported === 1,
    reasoning: row.reasoning === 1,
    reasoningOptions: jsonReasoningOptions(row.reasoning_options_json),
    costInputPerMillion: row.cost_input,
    costOutputPerMillion: row.cost_output,
    costCacheReadPerMillion: row.cost_cache_read,
    costCacheWritePerMillion: row.cost_cache_write,
    enabled: row.enabled === 1,
    favorite: row.favorite === 1,
    ...(row.status ? { status: row.status } : {}),
  }
}

function rowToInbox(row: InboxRow): InboxItem {
  if (row.type !== "user") throw new Error(`Unsupported inbox item type: ${row.type}`)
  let payload: { text?: unknown; metadata?: unknown; files?: unknown } = {}
  try {
    payload = JSON.parse(row.payload_json) as { text?: unknown; metadata?: unknown; files?: unknown }
  } catch {
    payload = {}
  }
  return {
    id: row.id,
    sessionId: row.session_id,
    type: "user",
    delivery: row.delivery,
    payload: {
      text: typeof payload.text === "string" ? payload.text : "",
      ...(Array.isArray(payload.files) ? { files: payload.files as StoredFile[] } : {}),
      ...(payload.metadata && typeof payload.metadata === "object" && !Array.isArray(payload.metadata)
        ? { metadata: payload.metadata as Record<string, unknown> }
        : {}),
    },
    createdAt: row.created_at,
  }
}

function rowToMessage(row: MessageRow): import("../shared/types").Message {
  let content: unknown = {}
  try {
    content = JSON.parse(row.content_json) as unknown
  } catch {
    content = {}
  }
  let files: StoredFile[] | undefined
  if (row.files_json) {
    try {
      const parsed = JSON.parse(row.files_json) as unknown
      if (Array.isArray(parsed)) files = parsed as StoredFile[]
    } catch {
      files = undefined
    }
  }
  return {
    id: row.id,
    seq: row.seq,
    sessionId: row.session_id,
    turnId: row.turn_id,
    role: row.role,
    text: row.text,
    content,
    ...(files && files.length > 0 ? { files } : {}),
    createdAt: row.created_at,
  }
}

function parseTurnErrorDetails(value: string | null): TurnErrorDetails | undefined {
  if (!value) return undefined
  try {
    const parsed = JSON.parse(value) as Partial<TurnErrorDetails>
    if (typeof parsed.kind !== "string" || typeof parsed.message !== "string") return undefined
    return {
      kind: parsed.kind,
      message: parsed.message,
      ...(typeof parsed.status === "number" ? { status: parsed.status } : {}),
      ...(typeof parsed.providerMessage === "string"
        ? { providerMessage: parsed.providerMessage }
        : {}),
      ...(typeof parsed.retryAfterMs === "number" ? { retryAfterMs: parsed.retryAfterMs } : {}),
    }
  } catch {
    return undefined
  }
}

function rowToTurn(row: TurnRow): Turn {
  const errorDetails = parseTurnErrorDetails(row.error_details_json)
  return {
    id: row.id,
    sessionId: row.session_id,
    status: row.status as TurnStatus,
    providerId: row.provider_id,
    modelId: row.model_id,
    reasoningEffort: row.reasoning_effort,
    userMessageId: row.user_message_id,
    stepCount: row.step_count,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    costUsd: row.cost_usd,
    error: row.error,
    ...(errorDetails ? { errorDetails } : {}),
    startedAt: row.started_at,
    updatedAt: row.updated_at,
    completedAt: row.completed_at,
  }
}

function rowToRule(row: PermissionRuleRow): PermissionRule {
  return {
    id: row.id,
    action: row.action,
    resource: row.resource,
    effect: row.effect,
    position: row.position,
    ttlSeconds: row.ttl_seconds,
    expiresAt: row.expires_at,
    note: row.note,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function rowToApproval(row: ApprovalRow): Approval {
  let args: unknown = {}
  try {
    args = JSON.parse(row.arguments_json) as unknown
  } catch {
    args = {}
  }
  return {
    id: row.id,
    turnId: row.turn_id,
    sessionId: row.session_id,
    toolCallId: row.tool_call_id,
    toolName: row.tool_name,
    action: row.action,
    resource: row.resource,
    patternKey: row.pattern_key,
    arguments: args,
    argumentsHash: row.arguments_hash,
    displayCommand: row.display_command,
    status: row.status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    decidedAt: row.decided_at,
    decidedBy: row.decided_by,
    reason: row.reason,
    scope: row.scope,
  }
}

function rowToApprovalGrant(row: ApprovalGrantRow): ApprovalGrant {
  return {
    id: row.id,
    sessionId: row.session_id,
    scope: row.scope,
    action: row.action,
    resource: row.resource,
    patternKey: row.pattern_key,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
  }
}

function rowToCheckpoint(row: CheckpointRow): Checkpoint {
  return {
    id: row.id,
    sessionId: row.session_id,
    turnId: row.turn_id,
    rootPath: row.root_path,
    rootHash: row.root_hash,
    commit: row.commit_sha,
    reason: row.reason,
    filesChanged: row.files_changed,
    insertions: row.insertions,
    deletions: row.deletions,
    createdAt: row.created_at,
  }
}

export interface NewCheckpoint {
  readonly sessionId?: string | null
  readonly turnId?: string | null
  readonly rootPath: string
  readonly rootHash: string
  readonly commit: string
  readonly reason: string
  readonly filesChanged?: number
  readonly insertions?: number
  readonly deletions?: number
}

export interface AgentWriteRecord {
  readonly rootHash: string
  readonly path: string
  readonly sha256: string
  readonly updatedAt: string
}

function rowToAudit(row: AuditRow): AuditEntry {
  let details: unknown = {}
  try {
    details = JSON.parse(row.details_json) as unknown
  } catch {
    details = {}
  }
  return {
    id: row.id,
    at: row.at,
    actor: row.actor,
    action: row.action,
    resource: row.resource,
    decision: row.decision,
    ruleId: row.rule_id,
    approvalId: row.approval_id,
    turnId: row.turn_id,
    details,
  }
}

function jsonStringArray(value: string): string[] {
  try {
    const parsed = JSON.parse(value) as unknown
    return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === "string") : []
  } catch {
    return []
  }
}

function rowToMemoryEntry(row: MemoryEntryRow): MemoryEntry {
  return {
    id: row.id,
    store: row.store,
    content: row.content,
    position: row.position,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function rowToMemoryPending(row: MemoryPendingRow): MemoryPendingRecord {
  let payload: unknown = {}
  try {
    payload = JSON.parse(row.payload_json) as unknown
  } catch {
    payload = {}
  }
  const parsed = payload && typeof payload === "object" ? (payload as Record<string, unknown>) : {}
  return {
    id: row.id,
    sessionId: row.session_id,
    turnId: row.turn_id,
    store: row.store,
    action: row.action,
    payload: {
      action: row.action,
      ...(typeof parsed.content === "string" ? { content: parsed.content } : {}),
      ...(typeof parsed.oldText === "string" ? { oldText: parsed.oldText } : {}),
    },
    summary: row.summary,
    origin: row.origin,
    status: row.status,
    matchedEntry: row.matched_entry,
    createdAt: row.created_at,
    decidedAt: row.decided_at,
    decidedBy: row.decided_by,
    reason: row.reason,
  }
}

function rowToMemoryHistory(row: MemoryHistoryRow): MemoryHistoryRecord {
  return {
    id: row.id,
    store: row.store,
    action: row.action,
    before: jsonStringArray(row.before_json),
    after: jsonStringArray(row.after_json),
    pendingId: row.pending_id,
    actor: row.actor,
    note: row.note,
    createdAt: row.created_at,
    undoneAt: row.undone_at,
    undoHistoryId: row.undo_history_id,
  }
}

function rowToSessionSearchHit(row: SessionSearchHitRow): SessionSearchHit {
  return {
    messageId: row.message_id,
    seq: row.seq,
    sessionId: row.session_id,
    sessionTitle: row.session_title,
    sessionUpdatedAt: row.session_updated_at,
    role: row.role,
    text: row.text,
    snippet: row.snippet ?? row.text,
    createdAt: row.created_at,
  }
}

function rowToMemoryReviewRun(row: MemoryReviewRunRow): MemoryReviewRun {
  return {
    id: row.id,
    sessionId: row.session_id,
    status: row.status,
    trigger: row.trigger,
    providerId: row.provider_id,
    modelId: row.model_id,
    turnsSinceMemory: row.turns_since_memory,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    error: row.error,
    startedAt: row.started_at,
    completedAt: row.completed_at,
  }
}

export interface NewPermissionRule {
  readonly action: string
  readonly resource: string
  readonly effect: RuleEffect
  readonly position?: number
  readonly ttlSeconds?: number | null
  readonly note?: string | null
}

export interface NewApproval {
  readonly turnId: string
  readonly sessionId: string
  readonly toolCallId: string
  readonly toolName: string
  readonly action: string
  readonly resource: string
  readonly patternKey: string
  readonly arguments: unknown
  readonly argumentsHash: string
  readonly displayCommand?: string | null
  readonly expiresAt: string
}

export interface NewApprovalGrant {
  readonly sessionId?: string | null
  readonly scope: "session" | "always"
  readonly action: string
  readonly resource: string
  readonly patternKey: string
  readonly expiresAt?: string | null
}

function rowToEvent(row: EventRow): EventRecord {
  let payload: unknown = {}
  try {
    payload = JSON.parse(row.payload) as unknown
  } catch {
    payload = {}
  }
  return {
    seq: row.seq,
    type: row.type,
    sessionId: row.session_id,
    payload,
    createdAt: row.created_at,
  }
}

export class Database {
  private readonly runtime: DatabaseRuntime

  private constructor(runtime: DatabaseRuntime) {
    this.runtime = runtime
  }

  static async open(options: { dbPath: string; backupDir: string }): Promise<Database> {
    mkdirSync(path.dirname(options.dbPath), { recursive: true })
    const previousVersion = schemaVersion(options.dbPath)
    if (previousVersion > LATEST_SCHEMA_VERSION) {
      throw new Error(
        `Database schema v${previousVersion} is newer than this daemon supports (v${LATEST_SCHEMA_VERSION}). ` +
          "This pre-production database must be reset: stop the daemon and run `bun run db:reset -- --yes`.",
      )
    }
    backupIfNeeded(options.dbPath, options.backupDir, LATEST_SCHEMA_VERSION)

    const runtime = ManagedRuntime.make(
      SqliteClient.layer({
        filename: options.dbPath,
        busyTimeout: "5 seconds",
      }),
    )

    try {
      await runtime.runPromise(
        SqliteMigrator.run({
          loader: migrationLoader,
          table: "schema_migrations",
        }),
      )
      return new Database(runtime)
    } catch (error) {
      await runtime.dispose()
      throw error
    }
  }

  private run<A>(effect: Effect.Effect<A, unknown, SqlClient.SqlClient>): Promise<A> {
    return this.runtime.runPromise(effect)
  }

  private query<A>(fn: (sql: SqlClient.SqlClient) => Effect.Effect<A, unknown>): Promise<A> {
    return this.run(
      Effect.gen(function* () {
        const sql = yield* SqlClient.SqlClient
        return yield* fn(sql)
      }),
    )
  }

  async close(): Promise<void> {
    await this.runtime.dispose()
  }

  // ---------------------------------------------------------------------------
  // Settings

  async getSetting(key: string): Promise<string | null> {
    return this.query((sql) =>
      Effect.gen(function* () {
        const rows = yield* sql<SettingRow>`SELECT value FROM settings WHERE key = ${key}`
        return rows[0]?.value ?? null
      }),
    )
  }

  async setSetting(key: string, value: string): Promise<void> {
    await this.query((sql) =>
      sql`
        INSERT INTO settings (key, value, updated_at)
        VALUES (${key}, ${value}, ${nowIso()})
        ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = excluded.updated_at
      `.pipe(Effect.asVoid),
    )
  }

  // ---------------------------------------------------------------------------
  // Sessions

  async createSession(title: string): Promise<CreatedSession> {
    const id = newId("ses")
    const now = nowIso()
    return this.query((sql) =>
      Effect.gen(function* () {
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            yield* sql`
              INSERT INTO sessions (id, title, created_at, updated_at)
              VALUES (${id}, ${title}, ${now}, ${now})
            `
            const rows = yield* sql<{ seq: number }>`
              INSERT INTO events (type, session_id, payload, created_at)
              VALUES ('session.created', ${id}, ${JSON.stringify({ sessionId: id, title })}, ${now})
              RETURNING seq
            `
            const seq = rows[0]?.seq
            if (seq === undefined) throw new Error("Failed to append session.created event")
            const session: Session = { id, title, createdAt: now, updatedAt: now }
            return {
              session,
              event: {
                seq,
                type: "session.created",
                sessionId: id,
                payload: { sessionId: id, title },
                createdAt: now,
              },
            }
          }),
        )
      }),
    )
  }

  async listSessions(): Promise<Session[]> {
    return this.query((sql) =>
      Effect.gen(function* () {
        const rows = yield* sql<SessionRow>`
          SELECT id, title, created_at, updated_at, provider_id, model_id, reasoning_effort, summary,
                 summary_through_seq, memory_snapshot_json, memory_snapshot_at
          FROM sessions
          ORDER BY updated_at DESC, id DESC
        `
        return rows.map(rowToSession)
      }),
    )
  }

  async getSession(id: string): Promise<Session | null> {
    return this.query((sql) =>
      Effect.gen(function* () {
        const rows = yield* sql<SessionRow>`
          SELECT id, title, created_at, updated_at, provider_id, model_id, reasoning_effort, summary,
                 summary_through_seq, memory_snapshot_json, memory_snapshot_at
          FROM sessions
          WHERE id = ${id}
        `
        const row = rows[0]
        return row ? rowToSession(row) : null
      }),
    )
  }

  async renameSession(id: string, title: string): Promise<{ session: Session; event: EventRecord } | null> {
    const now = nowIso()
    return this.query((sql) =>
      Effect.gen(function* () {
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const changed = yield* sql<{ id: string }>`
              UPDATE sessions SET title = ${title}, updated_at = ${now}
              WHERE id = ${id}
              RETURNING id
            `
            if (changed.length === 0) return null
            const session = yield* sql<SessionRow>`
              SELECT id, title, created_at, updated_at, provider_id, model_id, reasoning_effort,
                     summary, summary_through_seq, memory_snapshot_json, memory_snapshot_at
              FROM sessions WHERE id = ${id}
            `
            const inserted = yield* sql<{ seq: number }>`
              INSERT INTO events (type, session_id, payload, created_at)
              VALUES ('session.renamed', ${id}, ${JSON.stringify({ sessionId: id, title })}, ${now})
              RETURNING seq
            `
            const seq = inserted[0]?.seq
            const row = session[0]
            if (seq === undefined || !row) throw new Error("Failed to rename session")
            return {
              session: rowToSession(row),
              event: {
                seq,
                type: "session.renamed",
                sessionId: id,
                payload: { sessionId: id, title },
                createdAt: now,
              } satisfies EventRecord,
            }
          }),
        )
      }),
    )
  }

  async deleteSession(id: string): Promise<EventRecord | null> {
    const now = nowIso()
    return this.query((sql) =>
      Effect.gen(function* () {
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const existing = yield* sql<{ id: string }>`
              SELECT id FROM sessions WHERE id = ${id}
            `
            if (existing.length === 0) return null

            yield* sql`
              DELETE FROM turn_checkpoints
              WHERE turn_id IN (SELECT id FROM turns WHERE session_id = ${id})
            `
            yield* sql`DELETE FROM approval_grants WHERE session_id = ${id}`
            yield* sql`DELETE FROM approvals WHERE session_id = ${id}`
            yield* sql`DELETE FROM memory_pending WHERE session_id = ${id}`
            yield* sql`DELETE FROM memory_review_runs WHERE session_id = ${id}`
            yield* sql`DELETE FROM session_inbox WHERE session_id = ${id}`
            const released = yield* sql<BlobRefRow>`
              DELETE FROM blob_refs WHERE session_id = ${id} RETURNING hash
            `
            for (const ref of released) {
              yield* sql`
                DELETE FROM blobs
                WHERE hash = ${ref.hash}
                  AND NOT EXISTS (SELECT 1 FROM blob_refs WHERE hash = ${ref.hash})
              `
            }
            yield* sql`DELETE FROM messages WHERE session_id = ${id}`
            yield* sql`DELETE FROM turns WHERE session_id = ${id}`
            yield* sql`DELETE FROM checkpoints WHERE session_id = ${id}`
            yield* sql`DELETE FROM events WHERE session_id = ${id}`
            yield* sql`DELETE FROM sessions WHERE id = ${id}`

            const inserted = yield* sql<{ seq: number }>`
              INSERT INTO events (type, session_id, payload, created_at)
              VALUES ('session.deleted', ${id}, ${JSON.stringify({ sessionId: id })}, ${now})
              RETURNING seq
            `
            const seq = inserted[0]?.seq
            if (seq === undefined) throw new Error("Failed to append session.deleted event")
            return {
              seq,
              type: "session.deleted",
              sessionId: id,
              payload: { sessionId: id },
              createdAt: now,
            } satisfies EventRecord
          }),
        )
      }),
    )
  }

  // ---------------------------------------------------------------------------
  // Attachments / blobs

  async saveBlobs(blobs: readonly BlobInput[]): Promise<void> {
    if (blobs.length === 0) return
    await this.query((sql) =>
      sql.withTransaction(
        Effect.gen(function* () {
          for (const blob of blobs) {
            yield* sql`
              INSERT INTO blobs (hash, mime, bytes, width, height, data)
              VALUES (${blob.hash}, ${blob.mime}, ${blob.bytes}, ${blob.width ?? null},
                      ${blob.height ?? null}, ${blob.data})
              ON CONFLICT(hash) DO NOTHING
            `
          }
        }),
      ),
    )
  }

  async getBlob(hash: string): Promise<StoredBlob | null> {
    return this.query((sql) =>
      Effect.gen(function* () {
        const rows = yield* sql<BlobRow>`
          SELECT hash, mime, bytes, width, height, data
          FROM blobs
          WHERE hash = ${hash}
        `
        const row = rows[0]
        if (!row) return null
        return {
          hash: row.hash,
          mime: row.mime,
          bytes: row.bytes,
          width: row.width,
          height: row.height,
          data: row.data instanceof Uint8Array ? row.data : new Uint8Array(row.data),
        }
      }),
    )
  }

  async getReferencedBlob(hash: string): Promise<StoredBlob | null> {
    return this.query((sql) =>
      Effect.gen(function* () {
        const rows = yield* sql<BlobRow>`
          SELECT b.hash, b.mime, b.bytes, b.width, b.height, b.data
          FROM blobs b
          WHERE b.hash = ${hash}
            AND EXISTS (SELECT 1 FROM blob_refs WHERE blob_refs.hash = b.hash)
        `
        const row = rows[0]
        if (!row) return null
        return {
          hash: row.hash,
          mime: row.mime,
          bytes: row.bytes,
          width: row.width,
          height: row.height,
          data: row.data instanceof Uint8Array ? row.data : new Uint8Array(row.data),
        }
      }),
    )
  }

  async getBlobs(hashes: readonly string[]): Promise<Map<string, StoredBlob>> {
    if (hashes.length === 0) return new Map()
    return this.query((sql) =>
      Effect.gen(function* () {
        const rows = yield* sql<BlobRow>`
          SELECT hash, mime, bytes, width, height, data
          FROM blobs
          WHERE hash IN ${sql.in(hashes)}
        `
        return new Map(
          rows.map((row) => [
            row.hash,
            {
              hash: row.hash,
              mime: row.mime,
              bytes: row.bytes,
              width: row.width,
              height: row.height,
              data: row.data instanceof Uint8Array ? row.data : new Uint8Array(row.data),
            },
          ]),
        )
      }),
    )
  }

  async recordBlobRefs(
    sessionId: string,
    messageId: string,
    seq: number,
    hashes: readonly string[],
  ): Promise<void> {
    if (hashes.length === 0) return
    const unique = [...new Set(hashes)]
    await this.query((sql) =>
      sql.withTransaction(
        Effect.gen(function* () {
          for (const hash of unique) {
            yield* sql`
              INSERT INTO blob_refs (session_id, message_id, hash, seq)
              VALUES (${sessionId}, ${messageId}, ${hash}, ${seq})
              ON CONFLICT(session_id, message_id, hash) DO UPDATE SET seq = excluded.seq
            `
          }
        }),
      ),
    )
  }

  async releaseBlobRefs(sessionId: string, messageId: string): Promise<void> {
    await this.query((sql) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const released = yield* sql<BlobRefRow>`
            DELETE FROM blob_refs
            WHERE session_id = ${sessionId} AND message_id = ${messageId}
            RETURNING hash
          `
          for (const row of released) {
            yield* sql`
              DELETE FROM blobs
              WHERE hash = ${row.hash}
                AND NOT EXISTS (SELECT 1 FROM blob_refs WHERE hash = ${row.hash})
            `
          }
        }),
      ),
    )
  }

  async pruneUnreferencedBlobs(): Promise<number> {
    return this.query((sql) =>
      Effect.gen(function* () {
        const rows = yield* sql<{ hash: string }>`
          DELETE FROM blobs
          WHERE NOT EXISTS (SELECT 1 FROM blob_refs WHERE blob_refs.hash = blobs.hash)
          RETURNING hash
        `
        return rows.length
      }),
    )
  }

  // ---------------------------------------------------------------------------
  // Session inbox / queue

  async admitInbox(input: {
    id: string
    sessionId: string
    text: string
    delivery: InboxDelivery
    files?: readonly StoredFile[]
    metadata?: Readonly<Record<string, unknown>>
  }): Promise<InboxAdmissionResult> {
    const now = nowIso()
    const payload = {
      text: input.text,
      ...(input.files && input.files.length > 0 ? { files: input.files } : {}),
      ...(input.metadata ? { metadata: input.metadata } : {}),
    }
    return this.query((sql) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const pending = yield* sql<InboxRow>`
            SELECT id, session_id, type, payload_json, delivery, enqueued_seq, created_at
            FROM session_inbox
            WHERE id = ${input.id}
          `
          const existing = pending[0]
          if (existing) {
            if (existing.session_id !== input.sessionId || existing.type !== "user") {
              throw new InboxConflictError()
            }
            return { item: rowToInbox(existing), pending: true, event: null }
          }

          const messageRows = yield* sql<MessageRow>`
            SELECT id, seq, session_id, turn_id, role, text, content_json, files_json, created_at
            FROM messages
            WHERE id = ${input.id}
          `
          const message = messageRows[0]
          if (message) {
            if (message.session_id !== input.sessionId || message.role !== "user") {
              throw new InboxConflictError()
            }
            return {
              item: {
                id: input.id,
                sessionId: input.sessionId,
                type: "user",
                delivery: input.delivery,
                payload: {
                  text: message.text,
                  ...(message.files_json
                    ? { files: JSON.parse(message.files_json) as StoredFile[] }
                    : {}),
                },
                createdAt: message.created_at,
              },
              pending: false,
              event: null,
            }
          }

          const seqRows = yield* sql<{ seq: number }>`
            SELECT COALESCE(MAX(enqueued_seq), 0) + 1 AS seq
            FROM session_inbox
            WHERE session_id = ${input.sessionId}
          `
          const enqueuedSeq = seqRows[0]?.seq ?? 1
          yield* sql`
            INSERT INTO session_inbox
              (id, session_id, type, payload_json, delivery, enqueued_seq, created_at)
            VALUES
              (${input.id}, ${input.sessionId}, 'user', ${JSON.stringify(payload)}, ${input.delivery},
               ${enqueuedSeq}, ${now})
          `
          for (const file of input.files ?? []) {
            yield* sql`
              INSERT INTO blob_refs (session_id, message_id, hash, seq)
              VALUES (${input.sessionId}, ${input.id}, ${file.uri.slice("media:".length)}, ${enqueuedSeq})
              ON CONFLICT(session_id, message_id, hash) DO UPDATE SET seq = excluded.seq
            `
          }
          const item: InboxItem = {
            id: input.id,
            sessionId: input.sessionId,
            type: "user",
            delivery: input.delivery,
            payload,
            createdAt: now,
          }
          const eventRows = yield* sql<{ seq: number }>`
            INSERT INTO events (type, session_id, payload, created_at)
            VALUES ('session.inbox.enqueued', ${input.sessionId},
                    ${JSON.stringify({ inboxId: input.id, sessionId: input.sessionId, item })}, ${now})
            RETURNING seq
          `
          const seq = eventRows[0]?.seq
          if (seq === undefined) throw new Error("Failed to append inbox event")
          return {
            item,
            pending: true,
            event: {
              seq,
              type: "session.inbox.enqueued",
              sessionId: input.sessionId,
              payload: { inboxId: input.id, sessionId: input.sessionId, item },
              createdAt: now,
            },
          }
        }),
      ),
    )
  }

  async listInbox(sessionId: string): Promise<InboxItem[]> {
    return this.query((sql) =>
      Effect.gen(function* () {
        const rows = yield* sql<InboxRow>`
          SELECT id, session_id, type, payload_json, delivery, enqueued_seq, created_at
          FROM session_inbox
          WHERE session_id = ${sessionId}
          ORDER BY enqueued_seq ASC
        `
        return rows.map(rowToInbox)
      }),
    )
  }

  async findInbox(sessionId: string, id: string): Promise<InboxItem | null> {
    return this.query((sql) =>
      Effect.gen(function* () {
        const rows = yield* sql<InboxRow>`
          SELECT id, session_id, type, payload_json, delivery, enqueued_seq, created_at
          FROM session_inbox
          WHERE session_id = ${sessionId} AND id = ${id}
        `
        return rows[0] ? rowToInbox(rows[0]) : null
      }),
    )
  }

  async cancelInbox(sessionId: string, id: string): Promise<InboxMutationResult> {
    const now = nowIso()
    return this.query((sql) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<InboxRow>`
            DELETE FROM session_inbox
            WHERE session_id = ${sessionId} AND id = ${id}
            RETURNING id, session_id, type, payload_json, delivery, enqueued_seq, created_at
          `
          const row = rows[0]
          if (!row) return { item: null, event: null }
          const released = yield* sql<BlobRefRow>`
            DELETE FROM blob_refs
            WHERE session_id = ${sessionId} AND message_id = ${id}
            RETURNING hash
          `
          for (const ref of released) {
            yield* sql`
              DELETE FROM blobs
              WHERE hash = ${ref.hash}
                AND NOT EXISTS (SELECT 1 FROM blob_refs WHERE hash = ${ref.hash})
            `
          }
          const eventRows = yield* sql<{ seq: number }>`
            INSERT INTO events (type, session_id, payload, created_at)
            VALUES ('session.inbox.cancelled', ${sessionId},
                    ${JSON.stringify({ inboxId: id, sessionId })}, ${now})
            RETURNING seq
          `
          const seq = eventRows[0]?.seq
          if (seq === undefined) throw new Error("Failed to append inbox cancellation")
          return {
            item: rowToInbox(row),
            event: {
              seq,
              type: "session.inbox.cancelled",
              sessionId,
              payload: { inboxId: id, sessionId },
              createdAt: now,
            },
          }
        }),
      ),
    )
  }

  async setInboxDelivery(
    sessionId: string,
    id: string,
    delivery: InboxDelivery,
  ): Promise<InboxMutationResult> {
    const now = nowIso()
    return this.query((sql) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<InboxRow>`
            SELECT id, session_id, type, payload_json, delivery, enqueued_seq, created_at
            FROM session_inbox
            WHERE session_id = ${sessionId} AND id = ${id}
          `
          const row = rows[0]
          if (!row) return { item: null, event: null }
          if (row.delivery === delivery) return { item: rowToInbox(row), event: null }
          yield* sql`
            UPDATE session_inbox SET delivery = ${delivery}
            WHERE session_id = ${sessionId} AND id = ${id}
          `
          const eventRows = yield* sql<{ seq: number }>`
            INSERT INTO events (type, session_id, payload, created_at)
            VALUES ('session.inbox.delivery.changed', ${sessionId},
                    ${JSON.stringify({ inboxId: id, sessionId, delivery })}, ${now})
            RETURNING seq
          `
          const seq = eventRows[0]?.seq
          if (seq === undefined) throw new Error("Failed to append inbox delivery change")
          return {
            item: { ...rowToInbox(row), delivery },
            event: {
              seq,
              type: "session.inbox.delivery.changed",
              sessionId,
              payload: { inboxId: id, sessionId, delivery },
              createdAt: now,
            },
          }
        }),
      ),
    )
  }

  async createTurnFromInbox(input: {
    sessionId: string
    inboxId: string
    providerId: string
    modelId: string
    reasoningEffort: string | null
  }): Promise<CreatedTurnFromInbox | null> {
    const turnId = newId("turn")
    const now = nowIso()
    return this.query((sql) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<InboxRow>`
            SELECT id, session_id, type, payload_json, delivery, enqueued_seq, created_at
            FROM session_inbox
            WHERE session_id = ${input.sessionId} AND id = ${input.inboxId}
          `
          const row = rows[0]
          if (!row || row.type !== "user") return null
          const item = rowToInbox(row)
          const text = item.payload.text
          const files = item.payload.files
          const content = { role: "user", content: text }
          const inserted = yield* sql<{ seq: number }>`
            INSERT INTO messages (id, session_id, turn_id, role, text, content_json, files_json, created_at)
            VALUES (${row.id}, ${input.sessionId}, ${turnId}, 'user', ${text},
                    ${JSON.stringify(content)}, ${files ? JSON.stringify(files) : null}, ${now})
            RETURNING seq
          `
          const seq = inserted[0]?.seq
          if (seq === undefined) throw new Error("Failed to persist inbox user message")
          for (const file of files ?? []) {
            yield* sql`
              INSERT INTO blob_refs (session_id, message_id, hash, seq)
              VALUES (${input.sessionId}, ${row.id}, ${file.uri.slice("media:".length)}, ${seq})
              ON CONFLICT(session_id, message_id, hash) DO UPDATE SET seq = excluded.seq
            `
          }
          yield* sql`
            INSERT INTO turns
              (id, session_id, status, provider_id, model_id, reasoning_effort, user_message_id,
               step_count, input_tokens, output_tokens, cost_usd, error, checkpoint_json,
               started_at, updated_at, completed_at)
            VALUES
              (${turnId}, ${input.sessionId}, 'queued', ${input.providerId}, ${input.modelId},
               ${input.reasoningEffort}, ${row.id}, 0, 0, 0, 0, NULL, NULL, ${now}, ${now}, NULL)
          `
          yield* sql`
            DELETE FROM session_inbox
            WHERE session_id = ${input.sessionId} AND id = ${input.inboxId}
          `
          const eventRows = yield* sql<{ seq: number }>`
            INSERT INTO events (type, session_id, payload, created_at)
            VALUES ('session.inbox.delivered', ${input.sessionId},
                    ${JSON.stringify({ inboxId: row.id, sessionId: input.sessionId })}, ${now})
            RETURNING seq
          `
          const eventSeq = eventRows[0]?.seq
          if (eventSeq === undefined) throw new Error("Failed to append inbox delivery")
          yield* sql`UPDATE sessions SET updated_at = ${now} WHERE id = ${input.sessionId}`
          const turn: Turn = {
            id: turnId,
            sessionId: input.sessionId,
            status: "queued",
            providerId: input.providerId,
            modelId: input.modelId,
            reasoningEffort: input.reasoningEffort,
            userMessageId: row.id,
            stepCount: 0,
            inputTokens: 0,
            outputTokens: 0,
            costUsd: 0,
            error: null,
            startedAt: now,
            updatedAt: now,
            completedAt: null,
          }
          return {
            turn,
            userMessage: {
              id: row.id,
              seq,
              sessionId: input.sessionId,
              turnId,
              role: "user",
              text,
              content,
              ...(files && files.length > 0 ? { files } : {}),
              createdAt: now,
            },
            item,
            event: {
              seq: eventSeq,
              type: "session.inbox.delivered",
              sessionId: input.sessionId,
              payload: { inboxId: row.id, sessionId: input.sessionId },
              createdAt: now,
            },
          }
        }),
      ),
    )
  }

  /**
   * Saves one turn step and, in the same transaction, promotes selected inbox
   * rows into user messages. If any inbox row is delivered the turn stays
   * running even when the caller asked to complete it.
   */
  async saveTurnStepWithInbox(
    input: TurnStepInput & { readonly inboxIds?: readonly string[] },
  ): Promise<InboxStepResult> {
    const now = nowIso()
    const requestedStatus = input.status ?? "running"
    const usage = input.usage ?? { inputTokens: 0, outputTokens: 0, costUsd: 0 }
    const messages: Message[] = []
    const delivered: InboxItem[] = []
    const events: EventRecord[] = []

    return this.query((sql) =>
      sql.withTransaction(
        Effect.gen(function* () {
          for (const message of input.messages ?? []) {
            const id = newId("msg")
            const inserted = yield* sql<{ seq: number }>`
              INSERT INTO messages (id, session_id, turn_id, role, text, content_json, files_json, created_at)
              VALUES (${id}, ${input.sessionId}, ${input.turnId ?? null}, ${message.role}, ${message.text},
                      ${JSON.stringify(message.content)}, ${message.files ? JSON.stringify(message.files) : null}, ${now})
              RETURNING seq
            `
            const seq = inserted[0]?.seq
            if (seq === undefined) throw new Error("Failed to persist turn message")
            for (const file of message.files ?? []) {
              yield* sql`
                INSERT INTO blob_refs (session_id, message_id, hash, seq)
                VALUES (${input.sessionId}, ${id}, ${file.uri.slice("media:".length)}, ${seq})
                ON CONFLICT(session_id, message_id, hash) DO UPDATE SET seq = excluded.seq
              `
            }
            messages.push({
              id,
              seq,
              sessionId: input.sessionId,
              turnId: input.turnId ?? null,
              role: message.role,
              text: message.text,
              content: message.content,
              ...(message.files && message.files.length > 0 ? { files: message.files } : {}),
              createdAt: now,
            })
          }

          for (const inboxId of input.inboxIds ?? []) {
            const rows = yield* sql<InboxRow>`
              SELECT id, session_id, type, payload_json, delivery, enqueued_seq, created_at
              FROM session_inbox
              WHERE session_id = ${input.sessionId} AND id = ${inboxId}
            `
            const row = rows[0]
            if (!row || row.type !== "user") continue
            const item = rowToInbox(row)
            const text = item.payload.text
            const files = item.payload.files
            const content = { role: "user", content: text }
            const inserted = yield* sql<{ seq: number }>`
              INSERT INTO messages (id, session_id, turn_id, role, text, content_json, files_json, created_at)
              VALUES (${row.id}, ${input.sessionId}, ${input.turnId ?? null}, 'user', ${text},
                      ${JSON.stringify(content)}, ${files ? JSON.stringify(files) : null}, ${now})
              RETURNING seq
            `
            const seq = inserted[0]?.seq
            if (seq === undefined) throw new Error("Failed to persist promoted inbox message")
            yield* sql`
              DELETE FROM session_inbox
              WHERE session_id = ${input.sessionId} AND id = ${row.id}
            `
            const eventRows = yield* sql<{ seq: number }>`
              INSERT INTO events (type, session_id, payload, created_at)
              VALUES ('session.inbox.delivered', ${input.sessionId},
                      ${JSON.stringify({ inboxId: row.id, sessionId: input.sessionId })}, ${now})
              RETURNING seq
            `
            const eventSeq = eventRows[0]?.seq
            if (eventSeq === undefined) throw new Error("Failed to append inbox delivery")
            delivered.push(item)
            events.push({
              seq: eventSeq,
              type: "session.inbox.delivered",
              sessionId: input.sessionId,
              payload: { inboxId: row.id, sessionId: input.sessionId },
              createdAt: now,
            })
            messages.push({
              id: row.id,
              seq,
              sessionId: input.sessionId,
              turnId: input.turnId ?? null,
              role: "user",
              text,
              content,
              ...(files && files.length > 0 ? { files } : {}),
              createdAt: now,
            })
          }

          const status = delivered.length > 0 ? "running" : requestedStatus
          const terminal = status === "completed" || status === "failed" || status === "cancelled"
          yield* sql`
            UPDATE turns SET
              status = ${status},
              step_count = ${input.step},
              input_tokens = ${usage.inputTokens},
              output_tokens = ${usage.outputTokens},
              cost_usd = ${usage.costUsd},
              error = ${input.error ?? null},
              error_details_json = ${input.errorDetails ? JSON.stringify(input.errorDetails) : null},
              checkpoint_json = ${JSON.stringify(input.checkpoint)},
              updated_at = ${now},
              completed_at = ${terminal ? now : null}
            WHERE id = ${input.turnId ?? ""}
          `
          yield* sql`
            INSERT INTO turn_checkpoints (turn_id, step, state_json, created_at)
            VALUES (${input.turnId ?? ""}, ${input.step}, ${JSON.stringify(input.checkpoint)}, ${now})
          `
          yield* sql`UPDATE sessions SET updated_at = ${now} WHERE id = ${input.sessionId}`
          return { messages, delivered, events, status }
        }),
      ),
    )
  }

  // ---------------------------------------------------------------------------
  // Events

  async appendEvent(type: string, sessionId: string | null, payload: unknown): Promise<EventRecord> {
    const now = nowIso()
    return this.query((sql) =>
      Effect.gen(function* () {
        const rows = yield* sql<{ seq: number }>`
          INSERT INTO events (type, session_id, payload, created_at)
          VALUES (${type}, ${sessionId}, ${JSON.stringify(payload)}, ${now})
          RETURNING seq
        `
        const seq = rows[0]?.seq
        if (seq === undefined) throw new Error("Failed to append event")
        return { seq, type, sessionId, payload, createdAt: now }
      }),
    )
  }

  async eventsAfter(after: number, limit = 1000): Promise<EventRecord[]> {
    return this.query((sql) =>
      Effect.gen(function* () {
        const rows = yield* sql<EventRow>`
          SELECT seq, type, session_id, payload, created_at
          FROM events
          WHERE seq > ${after}
          ORDER BY seq ASC
          LIMIT ${limit}
        `
        return rows.map(rowToEvent)
      }),
    )
  }

  async latestEventSeq(): Promise<number> {
    return this.query((sql) =>
      Effect.gen(function* () {
        const rows = yield* sql<{ seq: number }>`SELECT COALESCE(MAX(seq), 0) AS seq FROM events`
        return rows[0]?.seq ?? 0
      }),
    )
  }

  // ---------------------------------------------------------------------------
  // Auth sessions

  async createAuthSession(tokenHash: string, expiresAt: string): Promise<AuthSessionRecord> {
    const id = newId("as")
    const now = nowIso()
    await this.query((sql) =>
      sql`
        INSERT INTO auth_sessions (id, token_hash, created_at, expires_at, last_seen_at)
        VALUES (${id}, ${tokenHash}, ${now}, ${expiresAt}, ${now})
      `.pipe(Effect.asVoid),
    )
    return { id, expiresAt }
  }

  async findAuthSession(tokenHash: string, now = nowIso()): Promise<AuthSessionRecord | null> {
    return this.query((sql) =>
      Effect.gen(function* () {
        const rows = yield* sql<AuthSessionRow>`
          SELECT id, expires_at
          FROM auth_sessions
          WHERE token_hash = ${tokenHash} AND expires_at > ${now}
        `
        const row = rows[0]
        if (!row) return null
        yield* sql`UPDATE auth_sessions SET last_seen_at = ${nowIso()} WHERE id = ${row.id}`
        return { id: row.id, expiresAt: row.expires_at }
      }),
    )
  }

  async deleteAuthSession(id: string): Promise<void> {
    await this.query((sql) => sql`DELETE FROM auth_sessions WHERE id = ${id}`.pipe(Effect.asVoid))
  }

  async deleteAllAuthSessions(): Promise<void> {
    await this.query((sql) => sql`DELETE FROM auth_sessions`.pipe(Effect.asVoid))
  }

  async pruneExpiredAuthSessions(now = nowIso()): Promise<void> {
    await this.query((sql) =>
      sql`DELETE FROM auth_sessions WHERE expires_at <= ${now}`.pipe(Effect.asVoid),
    )
  }

  // ---------------------------------------------------------------------------
  // Pairing tokens

  async createPairingToken(tokenHash: string, expiresAt: string): Promise<void> {
    const id = newId("pair")
    const now = nowIso()
    await this.query((sql) =>
      sql`
        INSERT INTO pairing_tokens (id, token_hash, created_at, expires_at, used_at)
        VALUES (${id}, ${tokenHash}, ${now}, ${expiresAt}, NULL)
      `.pipe(Effect.asVoid),
    )
  }

  async consumePairingToken(tokenHash: string, now = nowIso()): Promise<boolean> {
    return this.query((sql) =>
      Effect.gen(function* () {
        const rows = yield* sql<PairingRow>`
          UPDATE pairing_tokens
          SET used_at = ${now}
          WHERE token_hash = ${tokenHash} AND used_at IS NULL AND expires_at > ${now}
          RETURNING id
        `
        return rows.length > 0
      }),
    )
  }

  async deleteAllPairingTokens(): Promise<void> {
    await this.query((sql) => sql`DELETE FROM pairing_tokens`.pipe(Effect.asVoid))
  }

  async pruneExpiredPairingTokens(now = nowIso()): Promise<void> {
    await this.query((sql) =>
      sql`DELETE FROM pairing_tokens WHERE expires_at <= ${now}`.pipe(Effect.asVoid),
    )
  }

  // ---------------------------------------------------------------------------
  // Idempotency

  async getIdempotency(key: string): Promise<IdempotencyRecord | null> {
    return this.query((sql) =>
      Effect.gen(function* () {
        const rows = yield* sql<IdempotencyRow>`
          SELECT key, method, path, status, response, expires_at
          FROM idempotency_keys
          WHERE key = ${key}
        `
        const row = rows[0]
        return row
          ? {
              key: row.key,
              method: row.method,
              path: row.path,
              status: row.status,
              response: row.response,
              expiresAt: row.expires_at,
            }
          : null
      }),
    )
  }

  async setIdempotency(
    key: string,
    method: string,
    requestPath: string,
    status: number,
    response: string,
    expiresAt: string,
  ): Promise<void> {
    await this.query((sql) =>
      sql`
        INSERT INTO idempotency_keys (key, method, path, status, response, created_at, expires_at)
        VALUES (${key}, ${method}, ${requestPath}, ${status}, ${response}, ${nowIso()}, ${expiresAt})
        ON CONFLICT(key) DO UPDATE SET
          method = excluded.method,
          path = excluded.path,
          status = excluded.status,
          response = excluded.response,
          expires_at = excluded.expires_at
      `.pipe(Effect.asVoid),
    )
  }

  // ---------------------------------------------------------------------------
  // Providers and model catalog

  async listProviders(): Promise<ProviderRecord[]> {
    return this.query((sql) =>
      Effect.gen(function* () {
        const rows = yield* sql<ProviderRow>`
          SELECT id, name, kind, base_url, env_json, headers_json, enabled, created_at, updated_at
          FROM providers
          ORDER BY name ASC, id ASC
        `
        return rows.map(rowToProvider)
      }),
    )
  }

  async getProvider(id: string): Promise<ProviderRecord | null> {
    return this.query((sql) =>
      Effect.gen(function* () {
        const rows = yield* sql<ProviderRow>`
          SELECT id, name, kind, base_url, env_json, headers_json, enabled, created_at, updated_at
          FROM providers
          WHERE id = ${id}
        `
        const row = rows[0]
        return row ? rowToProvider(row) : null
      }),
    )
  }

  async upsertProvider(input: {
    id: string
    name: string
    kind: "cloud" | "local"
    baseUrl: string
    env: readonly string[]
    headers?: Readonly<Record<string, string>>
    enabled?: boolean
  }): Promise<ProviderRecord> {
    const now = nowIso()
    await this.query((sql) =>
      sql`
        INSERT INTO providers (id, name, kind, base_url, env_json, headers_json, enabled, created_at, updated_at)
        VALUES (${input.id}, ${input.name}, ${input.kind}, ${input.baseUrl}, ${JSON.stringify(input.env)},
                ${input.headers ? JSON.stringify(input.headers) : null}, ${input.enabled === false ? 0 : 1},
                ${now}, ${now})
        ON CONFLICT(id) DO UPDATE SET
          name = excluded.name,
          kind = excluded.kind,
          base_url = excluded.base_url,
          env_json = excluded.env_json,
          headers_json = excluded.headers_json,
          enabled = excluded.enabled,
          updated_at = excluded.updated_at
      `.pipe(Effect.asVoid),
    )
    const provider = await this.getProvider(input.id)
    if (!provider) throw new Error("Failed to persist provider")
    return provider
  }

  async listProviderCredentials(providerId: string): Promise<ProviderCredentialRecord[]> {
    return this.query((sql) =>
      Effect.gen(function* () {
        const rows = yield* sql<ProviderCredentialRow>`
          SELECT id, provider_id, label, active, created_at, updated_at
          FROM provider_credentials
          WHERE provider_id = ${providerId}
          ORDER BY active DESC, created_at ASC
        `
        return rows.map(rowToProviderCredential)
      }),
    )
  }

  async createProviderCredential(providerId: string, label: string, active: boolean): Promise<ProviderCredentialRecord> {
    const id = newId("cred")
    const now = nowIso()
    await this.query((sql) =>
      sql.withTransaction(
        Effect.gen(function* () {
          if (active) {
            yield* sql`
              UPDATE provider_credentials SET active = 0, updated_at = ${now}
              WHERE provider_id = ${providerId}
            `
          }
          yield* sql`
            INSERT INTO provider_credentials (id, provider_id, label, active, created_at, updated_at)
            VALUES (${id}, ${providerId}, ${label}, ${active ? 1 : 0}, ${now}, ${now})
          `
        }),
      ),
    )
    return {
      id,
      providerId,
      label,
      active,
      createdAt: now,
      updatedAt: now,
    }
  }

  async activateProviderCredential(providerId: string, credentialId: string): Promise<boolean> {
    const now = nowIso()
    return this.query((sql) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<{ id: string }>`
            SELECT id FROM provider_credentials WHERE id = ${credentialId} AND provider_id = ${providerId}
          `
          if (!rows[0]) return false
          yield* sql`
            UPDATE provider_credentials SET active = 0, updated_at = ${now}
            WHERE provider_id = ${providerId}
          `
          yield* sql`
            UPDATE provider_credentials SET active = 1, updated_at = ${now}
            WHERE id = ${credentialId} AND provider_id = ${providerId}
          `
          return true
        }),
      ),
    )
  }

  async deleteProviderCredential(providerId: string, credentialId: string): Promise<boolean> {
    const now = nowIso()
    return this.query((sql) =>
      sql.withTransaction(
        Effect.gen(function* () {
          const rows = yield* sql<{ active: number }>`
            SELECT active FROM provider_credentials
            WHERE id = ${credentialId} AND provider_id = ${providerId}
          `
          const current = rows[0]
          if (!current) return false
          yield* sql`
            DELETE FROM provider_credentials
            WHERE id = ${credentialId} AND provider_id = ${providerId}
          `
          if (current.active === 1) {
            const remaining = yield* sql<{ id: string }>`
              SELECT id FROM provider_credentials
              WHERE provider_id = ${providerId}
              ORDER BY created_at ASC
              LIMIT 1
            `
            if (remaining[0]) {
              yield* sql`
                UPDATE provider_credentials SET active = 1, updated_at = ${now}
                WHERE id = ${remaining[0].id}
              `
            }
          }
          return true
        }),
      ),
    )
  }

  async activeProviderCredential(providerId: string): Promise<ProviderCredentialRecord | null> {
    return this.query((sql) =>
      Effect.gen(function* () {
        const rows = yield* sql<ProviderCredentialRow>`
          SELECT id, provider_id, label, active, created_at, updated_at
          FROM provider_credentials
          WHERE provider_id = ${providerId} AND active = 1
          ORDER BY created_at ASC
          LIMIT 1
        `
        return rows[0] ? rowToProviderCredential(rows[0]) : null
      }),
    )
  }

  async upsertProviderModels(models: readonly import("../shared/types").CatalogModel[]): Promise<void> {
    if (models.length === 0) return
    const now = nowIso()
    await this.query((sql) =>
      sql.withTransaction(
        Effect.gen(function* () {
          for (const model of models) {
            yield* sql`
              INSERT INTO provider_models
                (provider_id, model_id, name, family, type, released_at, status,
                 context_limit, output_limit, input_modalities_json, output_modalities_json,
                 tools_supported, temperature_supported, reasoning, reasoning_options_json,
                 cost_input, cost_output, cost_cache_read, cost_cache_write, enabled, favorite,
                 metadata_json, updated_at)
              VALUES
                (${model.providerId}, ${model.modelId}, ${model.name}, ${model.family ?? null}, 'chat',
                 ${null}, ${model.status ?? null}, ${model.contextWindow}, ${model.maxOutputTokens},
                 ${JSON.stringify(model.inputModalities)}, ${JSON.stringify(model.outputModalities)},
                 ${model.supportsTools ? 1 : 0}, ${model.supportsTemperature ? 1 : 0},
                 ${model.reasoning ? 1 : 0}, ${JSON.stringify(model.reasoningOptions)},
                 ${model.costInputPerMillion}, ${model.costOutputPerMillion},
                 ${model.costCacheReadPerMillion}, ${model.costCacheWritePerMillion},
                 ${model.enabled ? 1 : 0}, ${model.favorite ? 1 : 0}, '{}', ${now})
              ON CONFLICT(provider_id, model_id) DO UPDATE SET
                name = excluded.name,
                family = excluded.family,
                context_limit = excluded.context_limit,
                output_limit = excluded.output_limit,
                input_modalities_json = excluded.input_modalities_json,
                output_modalities_json = excluded.output_modalities_json,
                tools_supported = excluded.tools_supported,
                temperature_supported = excluded.temperature_supported,
                reasoning = excluded.reasoning,
                reasoning_options_json = excluded.reasoning_options_json,
                cost_input = excluded.cost_input,
                cost_output = excluded.cost_output,
                cost_cache_read = excluded.cost_cache_read,
                cost_cache_write = excluded.cost_cache_write,
                updated_at = excluded.updated_at
            `
          }
        }),
      ),
    )
  }

  async listProviderModels(providerId?: string, includeDisabled = false): Promise<import("../shared/types").CatalogModel[]> {
    return this.query((sql) =>
      Effect.gen(function* () {
        const rows = providerId
          ? yield* sql<ProviderModelRow>`
              SELECT provider_id, model_id, name, family, type, released_at, status,
                     context_limit, output_limit, input_modalities_json, output_modalities_json,
                     tools_supported, temperature_supported, reasoning, reasoning_options_json,
                     cost_input, cost_output, cost_cache_read, cost_cache_write, enabled, favorite,
                     last_used_at, metadata_json, updated_at
              FROM provider_models
              WHERE provider_id = ${providerId} ${includeDisabled ? sql`` : sql`AND enabled = 1`}
              ORDER BY name ASC, model_id ASC
            `
          : yield* sql<ProviderModelRow>`
              SELECT provider_id, model_id, name, family, type, released_at, status,
                     context_limit, output_limit, input_modalities_json, output_modalities_json,
                     tools_supported, temperature_supported, reasoning, reasoning_options_json,
                     cost_input, cost_output, cost_cache_read, cost_cache_write, enabled, favorite,
                     last_used_at, metadata_json, updated_at
              FROM provider_models
              WHERE 1 = 1 ${includeDisabled ? sql`` : sql`AND enabled = 1`}
              ORDER BY provider_id ASC, name ASC, model_id ASC
            `
        return rows.map(rowToCatalogModel)
      }),
    )
  }

  async getProviderModel(
    providerId: string,
    modelId: string,
  ): Promise<import("../shared/types").CatalogModel | null> {
    return this.query((sql) =>
      Effect.gen(function* () {
        const rows = yield* sql<ProviderModelRow>`
          SELECT provider_id, model_id, name, family, type, released_at, status,
                 context_limit, output_limit, input_modalities_json, output_modalities_json,
                 tools_supported, temperature_supported, reasoning, reasoning_options_json,
                 cost_input, cost_output, cost_cache_read, cost_cache_write, enabled, favorite,
                 last_used_at, metadata_json, updated_at
          FROM provider_models
          WHERE provider_id = ${providerId} AND model_id = ${modelId}
        `
        return rows[0] ? rowToCatalogModel(rows[0]) : null
      }),
    )
  }

  async updateProviderModel(
    providerId: string,
    modelId: string,
    update: { enabled?: boolean; favorite?: boolean; supportsTools?: boolean },
  ): Promise<import("../shared/types").CatalogModel | null> {
    const now = nowIso()
    await this.query((sql) =>
      sql`
        UPDATE provider_models SET
          enabled = COALESCE(${update.enabled === undefined ? null : update.enabled ? 1 : 0}, enabled),
          favorite = COALESCE(${update.favorite === undefined ? null : update.favorite ? 1 : 0}, favorite),
          tools_supported = COALESCE(${update.supportsTools === undefined ? null : update.supportsTools ? 1 : 0}, tools_supported),
          updated_at = ${now}
        WHERE provider_id = ${providerId} AND model_id = ${modelId}
      `.pipe(Effect.asVoid),
    )
    return this.getProviderModel(providerId, modelId)
  }

  async touchProviderModel(providerId: string, modelId: string): Promise<void> {
    await this.query((sql) =>
      sql`
        UPDATE provider_models SET last_used_at = ${nowIso()}
        WHERE provider_id = ${providerId} AND model_id = ${modelId}
      `.pipe(Effect.asVoid),
    )
  }

  async setSessionModel(
    sessionId: string,
    providerId: string | null,
    modelId: string | null,
    reasoningEffort: string | null = null,
  ): Promise<void> {
    await this.query((sql) =>
      sql`
        UPDATE sessions SET provider_id = ${providerId}, model_id = ${modelId},
          reasoning_effort = ${reasoningEffort}, updated_at = ${nowIso()}
        WHERE id = ${sessionId}
      `.pipe(Effect.asVoid),
    )
  }

  async setSessionMemorySnapshot(
    sessionId: string,
    snapshotJson: string,
    snapshotAt: string = nowIso(),
  ): Promise<void> {
    await this.query((sql) =>
      sql`
        UPDATE sessions
        SET memory_snapshot_json = ${snapshotJson}, memory_snapshot_at = ${snapshotAt},
            updated_at = ${nowIso()}
        WHERE id = ${sessionId}
      `.pipe(Effect.asVoid),
    )
  }

  // ---------------------------------------------------------------------------
  // Messages and turns

  async getSessionMessages(sessionId: string, limit = 500): Promise<Message[]> {
    return this.query((sql) =>
      Effect.gen(function* () {
        const rows = yield* sql<MessageRow>`
          SELECT id, seq, session_id, turn_id, role, text, content_json, files_json, created_at
          FROM messages
          WHERE session_id = ${sessionId}
          ORDER BY seq ASC
          LIMIT ${limit}
        `
        return rows.map(rowToMessage)
      }),
    )
  }

  async getTurn(turnId: string): Promise<Turn | null> {
    return this.query((sql) =>
      Effect.gen(function* () {
        const rows = yield* sql<TurnRow>`
          SELECT id, session_id, status, provider_id, model_id, user_message_id, step_count,
                 input_tokens, output_tokens, cost_usd, error, error_details_json, reasoning_effort,
                 started_at, updated_at, completed_at
          FROM turns
          WHERE id = ${turnId}
        `
        const row = rows[0]
        return row ? rowToTurn(row) : null
      }),
    )
  }

  async hasActiveTurn(sessionId: string): Promise<boolean> {
    return this.query((sql) =>
      Effect.gen(function* () {
        const rows = yield* sql<{ active: number }>`
          SELECT 1 AS active FROM turns
          WHERE session_id = ${sessionId}
            AND status IN ('queued', 'running', 'waiting_approval', 'resuming')
          LIMIT 1
        `
        return rows.length > 0
      }),
    )
  }

  async getActiveTurn(sessionId: string): Promise<Turn | null> {
    return this.query((sql) =>
      Effect.gen(function* () {
        const rows = yield* sql<TurnRow>`
          SELECT id, session_id, status, provider_id, model_id, user_message_id, step_count,
                 input_tokens, output_tokens, cost_usd, error, error_details_json, reasoning_effort,
                 started_at, updated_at, completed_at
          FROM turns
          WHERE session_id = ${sessionId}
            AND status IN ('queued', 'running', 'waiting_approval', 'resuming')
          ORDER BY started_at DESC
          LIMIT 1
        `
        const row = rows[0]
        return row ? rowToTurn(row) : null
      }),
    )
  }

  async listActiveTurns(): Promise<Turn[]> {
    return this.query((sql) =>
      Effect.gen(function* () {
        const rows = yield* sql<TurnRow>`
          SELECT id, session_id, status, provider_id, model_id, user_message_id, step_count,
                 input_tokens, output_tokens, cost_usd, error, error_details_json, reasoning_effort,
                 started_at, updated_at, completed_at
          FROM turns
          WHERE status IN ('queued', 'running', 'waiting_approval', 'resuming')
          ORDER BY started_at DESC
        `
        const seen = new Set<string>()
        return rows
          .map(rowToTurn)
          .filter((turn) => {
            if (seen.has(turn.sessionId)) return false
            seen.add(turn.sessionId)
            return true
          })
      }),
    )
  }

  async searchMessages(
    query: string,
    limit = 300,
    excludeSessionId?: string | null,
    sort: "relevance" | "newest" | "oldest" = "relevance",
  ): Promise<SessionSearchHit[]> {
    return this.query((sql) =>
      Effect.gen(function* () {
        const order =
          sort === "newest"
            ? sql`m.created_at DESC, m.seq DESC`
            : sort === "oldest"
              ? sql`m.created_at ASC, m.seq ASC`
              : sql`bm25(messages_fts), m.seq DESC`
        const rows = excludeSessionId
          ? yield* sql<SessionSearchHitRow>`
              SELECT m.id AS message_id, m.seq, m.session_id, s.title AS session_title,
                     s.updated_at AS session_updated_at, m.role, m.text, m.created_at,
                     snippet(messages_fts, 0, '', '', '…', 12) AS snippet
              FROM messages_fts
              JOIN messages m ON m.seq = messages_fts.rowid
              JOIN sessions s ON s.id = m.session_id
              WHERE messages_fts MATCH ${query}
                AND m.session_id <> ${excludeSessionId}
              ORDER BY ${order}
              LIMIT ${limit}
            `
          : yield* sql<SessionSearchHitRow>`
              SELECT m.id AS message_id, m.seq, m.session_id, s.title AS session_title,
                     s.updated_at AS session_updated_at, m.role, m.text, m.created_at,
                     snippet(messages_fts, 0, '', '', '…', 12) AS snippet
              FROM messages_fts
              JOIN messages m ON m.seq = messages_fts.rowid
              JOIN sessions s ON s.id = m.session_id
              WHERE messages_fts MATCH ${query}
              ORDER BY ${order}
              LIMIT ${limit}
            `
        return rows.map(rowToSessionSearchHit)
      }),
    )
  }

  async listTurns(sessionId: string, limit = 50): Promise<Turn[]> {
    return this.query((sql) =>
      Effect.gen(function* () {
        const rows = yield* sql<TurnRow>`
          SELECT id, session_id, status, provider_id, model_id, user_message_id, step_count,
                 input_tokens, output_tokens, cost_usd, error, error_details_json, reasoning_effort,
                 started_at, updated_at, completed_at
          FROM turns
          WHERE session_id = ${sessionId}
          ORDER BY started_at DESC
          LIMIT ${limit}
        `
        return rows.map(rowToTurn)
      }),
    )
  }

  async createTurnWithUserMessage(
    sessionId: string,
    providerId: string,
    modelId: string,
    text: string,
    reasoningEffort: string | null = null,
    files?: readonly StoredFile[],
  ): Promise<{ turn: Turn; userMessage: Message }> {
    const turnId = newId("turn")
    const messageId = newId("msg")
    const now = nowIso()
    const content = { role: "user", content: text }
    return this.query((sql) =>
      Effect.gen(function* () {
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const inserted = yield* sql<{ seq: number }>`
              INSERT INTO messages (id, session_id, turn_id, role, text, content_json, files_json, created_at)
              VALUES (${messageId}, ${sessionId}, ${turnId}, 'user', ${text}, ${JSON.stringify(content)},
                      ${files ? JSON.stringify(files) : null}, ${now})
              RETURNING seq
            `
            const seq = inserted[0]?.seq
            if (seq === undefined) throw new Error("Failed to persist user message")
            for (const file of files ?? []) {
              yield* sql`
                INSERT INTO blob_refs (session_id, message_id, hash, seq)
                VALUES (${sessionId}, ${messageId}, ${file.uri.slice("media:".length)}, ${seq})
                ON CONFLICT(session_id, message_id, hash) DO UPDATE SET seq = excluded.seq
              `
            }
            yield* sql`
              INSERT INTO turns
                (id, session_id, status, provider_id, model_id, reasoning_effort, user_message_id,
                 step_count, input_tokens, output_tokens, cost_usd, error, checkpoint_json,
                 started_at, updated_at, completed_at)
              VALUES
                (${turnId}, ${sessionId}, 'queued', ${providerId}, ${modelId}, ${reasoningEffort},
                 ${messageId}, 0, 0, 0, 0, NULL, NULL, ${now}, ${now}, NULL)
            `
            yield* sql`UPDATE sessions SET updated_at = ${now} WHERE id = ${sessionId}`
            const turn: Turn = {
              id: turnId,
              sessionId,
              status: "queued",
              providerId,
              modelId,
              reasoningEffort,
              userMessageId: messageId,
              stepCount: 0,
              inputTokens: 0,
              outputTokens: 0,
              costUsd: 0,
              error: null,
              startedAt: now,
              updatedAt: now,
              completedAt: null,
            }
            const userMessage: Message = {
              id: messageId,
              seq,
              sessionId,
              turnId,
              role: "user",
              text,
              content,
              ...(files && files.length > 0 ? { files } : {}),
              createdAt: now,
            }
            return { turn, userMessage }
          }),
        )
      }),
    )
  }

  async saveTurnStep(turnId: string, input: TurnStepInput): Promise<Message[]> {
    const now = nowIso()
    const status = input.status ?? "running"
    const terminal = status === "completed" || status === "failed" || status === "cancelled"
    const usage = input.usage ?? { inputTokens: 0, outputTokens: 0, costUsd: 0 }
    const newMessages: Message[] = []

    await this.query((sql) =>
      sql.withTransaction(
        Effect.gen(function* () {
          for (const message of input.messages ?? []) {
            const id = newId("msg")
            const inserted = yield* sql<{ seq: number }>`
              INSERT INTO messages (id, session_id, turn_id, role, text, content_json, files_json, created_at)
              VALUES (${id}, ${input.sessionId}, ${turnId}, ${message.role}, ${message.text},
                      ${JSON.stringify(message.content)}, ${message.files ? JSON.stringify(message.files) : null}, ${now})
              RETURNING seq
            `
            const seq = inserted[0]?.seq
            if (seq === undefined) throw new Error("Failed to persist turn message")
            for (const file of message.files ?? []) {
              yield* sql`
                INSERT INTO blob_refs (session_id, message_id, hash, seq)
                VALUES (${input.sessionId}, ${id}, ${file.uri.slice("media:".length)}, ${seq})
                ON CONFLICT(session_id, message_id, hash) DO UPDATE SET seq = excluded.seq
              `
            }
            newMessages.push({
              id,
              seq,
              sessionId: input.sessionId,
              turnId,
              role: message.role,
              text: message.text,
              content: message.content,
              ...(message.files && message.files.length > 0 ? { files: message.files } : {}),
              createdAt: now,
            })
          }

          yield* sql`
            UPDATE turns SET
              status = ${status},
              step_count = ${input.step},
              input_tokens = ${usage.inputTokens},
              output_tokens = ${usage.outputTokens},
              cost_usd = ${usage.costUsd},
              error = ${input.error ?? null},
              error_details_json = ${input.errorDetails ? JSON.stringify(input.errorDetails) : null},
              checkpoint_json = ${JSON.stringify(input.checkpoint)},
              updated_at = ${now},
              completed_at = ${terminal ? now : null}
            WHERE id = ${turnId}
          `
          yield* sql`
            INSERT INTO turn_checkpoints (turn_id, step, state_json, created_at)
            VALUES (${turnId}, ${input.step}, ${JSON.stringify(input.checkpoint)}, ${now})
          `
          yield* sql`UPDATE sessions SET updated_at = ${now} WHERE id = ${input.sessionId}`
        }),
      ),
    )

    return newMessages
  }

  async saveTurnCheckpoint(
    turnId: string,
    sessionId: string,
    step: number,
    checkpoint: unknown,
    usage: TokenUsage,
    status: TurnStatus = "running",
  ): Promise<void> {
    await this.saveTurnStep(turnId, {
      step,
      sessionId,
      checkpoint,
      usage,
      status,
    })
  }

  async setTurnStatus(
    turnId: string,
    status: TurnStatus,
    error: string | null = null,
    errorDetails: TurnErrorDetails | null = null,
  ): Promise<void> {
    const now = nowIso()
    const terminal = status === "completed" || status === "failed" || status === "cancelled"
    await this.query((sql) =>
      sql`
        UPDATE turns SET status = ${status}, error = ${error},
          error_details_json = ${errorDetails ? JSON.stringify(errorDetails) : null},
          updated_at = ${now}, completed_at = ${terminal ? now : null}
        WHERE id = ${turnId}
      `.pipe(Effect.asVoid),
    )
  }

  async cancelTurn(turnId: string): Promise<Turn | null> {
    const turn = await this.getTurn(turnId)
    if (!turn) return null
    if (turn.status === "completed" || turn.status === "failed" || turn.status === "cancelled") {
      return turn
    }
    await this.setTurnStatus(turnId, "cancelled")
    return this.getTurn(turnId)
  }

  async getLatestCheckpoint(turnId: string): Promise<{ step: number; state: unknown; createdAt: string } | null> {
    return this.query((sql) =>
      Effect.gen(function* () {
        const rows = yield* sql<TurnStateCheckpointRow>`
          SELECT step, state_json, created_at
          FROM turn_checkpoints
          WHERE turn_id = ${turnId}
          ORDER BY id DESC
          LIMIT 1
        `
        const row = rows[0]
        if (!row) return null
        let state: unknown = {}
        try {
          state = JSON.parse(row.state_json) as unknown
        } catch {
          state = {}
        }
        return { step: row.step, state, createdAt: row.created_at }
      }),
    )
  }

  async recoverableTurns(): Promise<Turn[]> {
    return this.query((sql) =>
      Effect.gen(function* () {
        const rows = yield* sql<TurnRow>`
          SELECT id, session_id, status, provider_id, model_id, user_message_id, step_count,
                 input_tokens, output_tokens, cost_usd, error, error_details_json, reasoning_effort,
                 started_at, updated_at, completed_at
          FROM turns
          WHERE status IN ('queued', 'running', 'resuming', 'waiting_approval')
          ORDER BY started_at ASC
        `
        return rows.map(rowToTurn)
      }),
    )
  }

  async setSessionSummary(sessionId: string, summary: string, throughSeq: number): Promise<void> {
    await this.query((sql) =>
      sql`
        UPDATE sessions SET summary = ${summary}, summary_through_seq = ${throughSeq},
          updated_at = ${nowIso()}
        WHERE id = ${sessionId}
      `.pipe(Effect.asVoid),
    )
  }

  // ---------------------------------------------------------------------------
  // Permission rules

  async listPermissionRules(): Promise<PermissionRule[]> {
    return this.query((sql) =>
      Effect.gen(function* () {
        const rows = yield* sql<PermissionRuleRow>`
          SELECT id, action, resource, effect, position, ttl_seconds, expires_at, note,
                 created_at, updated_at
          FROM permission_rules
          ORDER BY position ASC, id ASC
        `
        return rows.map(rowToRule)
      }),
    )
  }

  async getPermissionRule(id: string): Promise<PermissionRule | null> {
    return this.query((sql) =>
      Effect.gen(function* () {
        const rows = yield* sql<PermissionRuleRow>`
          SELECT id, action, resource, effect, position, ttl_seconds, expires_at, note,
                 created_at, updated_at
          FROM permission_rules
          WHERE id = ${id}
        `
        const row = rows[0]
        return row ? rowToRule(row) : null
      }),
    )
  }

  async createPermissionRule(input: NewPermissionRule): Promise<PermissionRule> {
    const id = newId("rule")
    const now = nowIso()
    const position = input.position ?? 100
    const ttlSeconds = input.ttlSeconds ?? null
    const expiresAt =
      ttlSeconds === null ? null : new Date(Date.now() + ttlSeconds * 1000).toISOString()
    const note = input.note ?? null
    await this.query((sql) =>
      sql`
        INSERT INTO permission_rules
          (id, action, resource, effect, position, ttl_seconds, expires_at, note, created_at, updated_at)
        VALUES (${id}, ${input.action}, ${input.resource}, ${input.effect}, ${position},
                ${ttlSeconds}, ${expiresAt}, ${note}, ${now}, ${now})
      `.pipe(Effect.asVoid),
    )
    return {
      id,
      action: input.action,
      resource: input.resource,
      effect: input.effect,
      position,
      ttlSeconds,
      expiresAt,
      note,
      createdAt: now,
      updatedAt: now,
    }
  }

  async updatePermissionRule(
    id: string,
    input: Partial<NewPermissionRule>,
  ): Promise<PermissionRule | null> {
    const current = await this.getPermissionRule(id)
    if (!current) return null
    const now = nowIso()
    const action = input.action ?? current.action
    const resource = input.resource ?? current.resource
    const effect = input.effect ?? current.effect
    const position = input.position ?? current.position
    const ttlSeconds = input.ttlSeconds === undefined ? current.ttlSeconds : input.ttlSeconds
    const expiresAt =
      ttlSeconds === null ? null : new Date(Date.now() + ttlSeconds * 1000).toISOString()
    const note = input.note === undefined ? current.note : input.note
    await this.query((sql) =>
      sql`
        UPDATE permission_rules SET action = ${action}, resource = ${resource}, effect = ${effect},
          position = ${position}, ttl_seconds = ${ttlSeconds}, expires_at = ${expiresAt},
          note = ${note}, updated_at = ${now}
        WHERE id = ${id}
      `.pipe(Effect.asVoid),
    )
    return this.getPermissionRule(id)
  }

  async deletePermissionRule(id: string): Promise<void> {
    await this.query((sql) => sql`DELETE FROM permission_rules WHERE id = ${id}`.pipe(Effect.asVoid))
  }

  // ---------------------------------------------------------------------------
  // Approvals

  async createApproval(input: NewApproval): Promise<Approval> {
    const id = newId("apv")
    const now = nowIso()
    await this.query((sql) =>
      sql`
        INSERT INTO approvals
          (id, turn_id, session_id, tool_call_id, tool_name, action, resource, pattern_key,
           arguments_json, arguments_hash, display_command, status, created_at, expires_at,
           decided_at, decided_by, reason, scope)
        VALUES
          (${id}, ${input.turnId}, ${input.sessionId}, ${input.toolCallId}, ${input.toolName},
           ${input.action}, ${input.resource}, ${input.patternKey}, ${JSON.stringify(input.arguments)},
           ${input.argumentsHash}, ${input.displayCommand ?? null}, 'pending', ${now},
           ${input.expiresAt}, NULL, NULL, NULL, NULL)
      `.pipe(Effect.asVoid),
    )
    return {
      id,
      turnId: input.turnId,
      sessionId: input.sessionId,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      action: input.action,
      resource: input.resource,
      patternKey: input.patternKey,
      arguments: input.arguments,
      argumentsHash: input.argumentsHash,
      displayCommand: input.displayCommand ?? null,
      status: "pending",
      createdAt: now,
      expiresAt: input.expiresAt,
      decidedAt: null,
      decidedBy: null,
      reason: null,
      scope: null,
    }
  }

  async getApproval(id: string): Promise<Approval | null> {
    return this.query((sql) =>
      Effect.gen(function* () {
        const rows = yield* sql<ApprovalRow>`
          SELECT id, turn_id, session_id, tool_call_id, tool_name, action, resource, pattern_key,
                 arguments_json, arguments_hash, display_command, status, created_at, expires_at,
                 decided_at, decided_by, reason, scope
          FROM approvals
          WHERE id = ${id}
        `
        const row = rows[0]
        return row ? rowToApproval(row) : null
      }),
    )
  }

  async findApproval(turnId: string, toolCallId: string): Promise<Approval | null> {
    return this.query((sql) =>
      Effect.gen(function* () {
        const rows = yield* sql<ApprovalRow>`
          SELECT id, turn_id, session_id, tool_call_id, tool_name, action, resource, pattern_key,
                 arguments_json, arguments_hash, display_command, status, created_at, expires_at,
                 decided_at, decided_by, reason, scope
          FROM approvals
          WHERE turn_id = ${turnId} AND tool_call_id = ${toolCallId}
          ORDER BY created_at DESC
          LIMIT 1
        `
        const row = rows[0]
        return row ? rowToApproval(row) : null
      }),
    )
  }

  async listApprovals(status?: ApprovalStatus, limit = 100): Promise<Approval[]> {
    return this.query((sql) =>
      Effect.gen(function* () {
        const rows = status
          ? yield* sql<ApprovalRow>`
              SELECT id, turn_id, session_id, tool_call_id, tool_name, action, resource, pattern_key,
                     arguments_json, arguments_hash, display_command, status, created_at, expires_at,
                     decided_at, decided_by, reason, scope
              FROM approvals
              WHERE status = ${status}
              ORDER BY created_at DESC
              LIMIT ${limit}
            `
          : yield* sql<ApprovalRow>`
              SELECT id, turn_id, session_id, tool_call_id, tool_name, action, resource, pattern_key,
                     arguments_json, arguments_hash, display_command, status, created_at, expires_at,
                     decided_at, decided_by, reason, scope
              FROM approvals
              ORDER BY created_at DESC
              LIMIT ${limit}
            `
        return rows.map(rowToApproval)
      }),
    )
  }

  async decideApproval(
    id: string,
    status: "approved" | "rejected" | "expired" | "invalidated",
    decidedBy: string,
    reason: string | null,
    scope: ApprovalScope | null = null,
  ): Promise<Approval | null> {
    const now = nowIso()
    const changed = await this.query((sql) =>
      sql<{ id: string }>`
        UPDATE approvals
        SET status = ${status}, decided_at = ${now}, decided_by = ${decidedBy}, reason = ${reason},
            scope = ${scope}
        WHERE id = ${id} AND status = 'pending'
        RETURNING id
      `,
    )
    if (changed.length === 0) return null
    return this.getApproval(id)
  }

  async decideApprovalWithEvent(
    id: string,
    status: "approved" | "rejected" | "expired" | "invalidated",
    decidedBy: string,
    reason: string | null,
    scope: ApprovalScope | null,
    event: { type: string; sessionId: string; payload: unknown },
  ): Promise<{ approval: Approval; event: EventRecord } | null> {
    const now = nowIso()
    return this.query((sql) =>
      Effect.gen(function* () {
        const result = yield* sql.withTransaction(
          Effect.gen(function* () {
            const changed = yield* sql<{ id: string }>`
              UPDATE approvals
              SET status = ${status}, decided_at = ${now}, decided_by = ${decidedBy}, reason = ${reason},
                  scope = ${scope}
              WHERE id = ${id} AND status = 'pending'
              RETURNING id
            `
            if (changed.length === 0) return null
            const inserted = yield* sql<{ seq: number }>`
              INSERT INTO events (type, session_id, payload, created_at)
              VALUES (${event.type}, ${event.sessionId}, ${JSON.stringify(event.payload)}, ${now})
              RETURNING seq
            `
            const seq = inserted[0]?.seq
            if (seq === undefined) throw new Error("Failed to append approval event")
            return {
              event: {
                seq,
                type: event.type,
                sessionId: event.sessionId,
                payload: event.payload,
                createdAt: now,
              } satisfies EventRecord,
            }
          }),
        )
        if (!result) return null
        const rows = yield* sql<ApprovalRow>`
          SELECT id, turn_id, session_id, tool_call_id, tool_name, action, resource, pattern_key,
                 arguments_json, arguments_hash, display_command, status, created_at, expires_at,
                 decided_at, decided_by, reason, scope
          FROM approvals
          WHERE id = ${id}
        `
        const row = rows[0]
        return row ? { approval: rowToApproval(row), event: result.event } : null
      }),
    )
  }

  async expireApprovals(now = nowIso()): Promise<string[]> {
    return this.query((sql) =>
      Effect.gen(function* () {
        const rows = yield* sql<{ id: string }>`
          UPDATE approvals SET status = 'expired', decided_at = ${now}
          WHERE status = 'pending' AND expires_at <= ${now}
          RETURNING id
        `
        return rows.map((row) => row.id)
      }),
    )
  }

  async expireApprovalsWithEvents(now = nowIso()): Promise<EventRecord[]> {
    return this.query((sql) =>
      Effect.gen(function* () {
        return yield* sql.withTransaction(
          Effect.gen(function* () {
            const candidates = yield* sql<{
              id: string
              session_id: string
              turn_id: string
              tool_call_id: string
            }>`
              SELECT id, session_id, turn_id, tool_call_id
              FROM approvals
              WHERE status = 'pending' AND expires_at <= ${now}
            `
            const events: EventRecord[] = []
            for (const candidate of candidates) {
              const changed = yield* sql<{ id: string }>`
                UPDATE approvals SET status = 'expired', decided_at = ${now}
                WHERE id = ${candidate.id} AND status = 'pending'
                RETURNING id
              `
              if (changed.length === 0) continue
              const payload = {
                approvalId: candidate.id,
                turnId: candidate.turn_id,
                sessionId: candidate.session_id,
                toolCallId: candidate.tool_call_id,
                expiredAt: now,
              }
              const inserted = yield* sql<{ seq: number }>`
                INSERT INTO events (type, session_id, payload, created_at)
                VALUES ('approval.expired', ${candidate.session_id}, ${JSON.stringify(payload)}, ${now})
                RETURNING seq
              `
              const seq = inserted[0]?.seq
              if (seq === undefined) throw new Error("Failed to append approval expiry event")
              events.push({
                seq,
                type: "approval.expired",
                sessionId: candidate.session_id,
                payload,
                createdAt: now,
              })
            }
            return events
          }),
        )
      }),
    )
  }

  async createApprovalGrant(input: NewApprovalGrant): Promise<ApprovalGrant> {
    const id = newId("agr")
    const now = nowIso()
    await this.query((sql) =>
      sql`
        INSERT INTO approval_grants
          (id, session_id, scope, action, resource, pattern_key, created_at, expires_at)
        VALUES
          (${id}, ${input.sessionId ?? null}, ${input.scope}, ${input.action}, ${input.resource},
           ${input.patternKey}, ${now}, ${input.expiresAt ?? null})
      `.pipe(Effect.asVoid),
    )
    return {
      id,
      sessionId: input.sessionId ?? null,
      scope: input.scope,
      action: input.action,
      resource: input.resource,
      patternKey: input.patternKey,
      createdAt: now,
      expiresAt: input.expiresAt ?? null,
    }
  }

  async findApprovalGrant(
    sessionId: string | null,
    action: string,
    patternKey: string,
  ): Promise<ApprovalGrant | null> {
    return this.query((sql) =>
      Effect.gen(function* () {
        const now = nowIso()
        const rows = yield* sql<ApprovalGrantRow>`
          SELECT id, session_id, scope, action, resource, pattern_key, created_at, expires_at
          FROM approval_grants
          WHERE action = ${action} AND pattern_key = ${patternKey}
            AND (expires_at IS NULL OR expires_at > ${now})
            AND (scope = 'always' OR session_id = ${sessionId})
          ORDER BY CASE WHEN session_id = ${sessionId} THEN 0 ELSE 1 END, created_at DESC
          LIMIT 1
        `
        const row = rows[0]
        return row ? rowToApprovalGrant(row) : null
      }),
    )
  }

  async listApprovalGrants(limit = 200): Promise<ApprovalGrant[]> {
    return this.query((sql) =>
      Effect.gen(function* () {
        const rows = yield* sql<ApprovalGrantRow>`
          SELECT id, session_id, scope, action, resource, pattern_key, created_at, expires_at
          FROM approval_grants
          ORDER BY created_at DESC
          LIMIT ${limit}
        `
        return rows.map(rowToApprovalGrant)
      }),
    )
  }

  async deleteApprovalGrant(id: string): Promise<boolean> {
    const rows = await this.query((sql) =>
      sql<{ id: string }>`DELETE FROM approval_grants WHERE id = ${id} RETURNING id`,
    )
    return rows.length > 0
  }

  // ---------------------------------------------------------------------------
  // Audit

  async appendAudit(input: {
    actor: string
    action: string
    resource: string
    decision: string
    ruleId?: string | null
    approvalId?: string | null
    turnId?: string | null
    details?: unknown
  }): Promise<void> {
    await this.query((sql) =>
      sql`
        INSERT INTO audit_log
          (at, actor, action, resource, decision, rule_id, approval_id, turn_id, details_json)
        VALUES
          (${nowIso()}, ${input.actor}, ${input.action}, ${input.resource}, ${input.decision},
           ${input.ruleId ?? null}, ${input.approvalId ?? null}, ${input.turnId ?? null},
           ${JSON.stringify(input.details ?? {})})
      `.pipe(Effect.asVoid),
    )
  }

  async listAudit(limit = 100): Promise<AuditEntry[]> {
    return this.query((sql) =>
      Effect.gen(function* () {
        const rows = yield* sql<AuditRow>`
          SELECT id, at, actor, action, resource, decision, rule_id, approval_id, turn_id,
                 details_json
          FROM audit_log
          ORDER BY id DESC
          LIMIT ${limit}
        `
        return rows.map(rowToAudit)
      }),
    )
  }

  // ---------------------------------------------------------------------------
  // Checkpoints

  async createCheckpoint(input: NewCheckpoint): Promise<Checkpoint> {
    const id = newId("chk")
    const now = nowIso()
    await this.query((sql) =>
      sql`
        INSERT INTO checkpoints
          (id, session_id, turn_id, root_path, root_hash, commit_sha,
           reason, files_changed, insertions, deletions, created_at)
        VALUES
          (${id}, ${input.sessionId ?? null}, ${input.turnId ?? null},
           ${input.rootPath}, ${input.rootHash}, ${input.commit}, ${input.reason},
           ${input.filesChanged ?? 0}, ${input.insertions ?? 0}, ${input.deletions ?? 0}, ${now})
      `.pipe(Effect.asVoid),
    )
    return {
      id,
      sessionId: input.sessionId ?? null,
      turnId: input.turnId ?? null,
      rootPath: input.rootPath,
      rootHash: input.rootHash,
      commit: input.commit,
      reason: input.reason,
      filesChanged: input.filesChanged ?? 0,
      insertions: input.insertions ?? 0,
      deletions: input.deletions ?? 0,
      createdAt: now,
    }
  }

  async getCheckpoint(id: string): Promise<Checkpoint | null> {
    return this.query((sql) =>
      Effect.gen(function* () {
        const rows = yield* sql<CheckpointRow>`
          SELECT id, session_id, turn_id, root_path, root_hash,
                 commit_sha, reason, files_changed, insertions, deletions, created_at
          FROM checkpoints
          WHERE id = ${id}
        `
        const row = rows[0]
        return row ? rowToCheckpoint(row) : null
      }),
    )
  }

  async listCheckpoints(limit = 100, sessionId?: string): Promise<Checkpoint[]> {
    return this.query((sql) =>
      Effect.gen(function* () {
        const rows = sessionId
          ? yield* sql<CheckpointRow>`
              SELECT id, session_id, turn_id, root_path, root_hash,
                     commit_sha, reason, files_changed, insertions, deletions, created_at
              FROM checkpoints
              WHERE session_id = ${sessionId}
              ORDER BY created_at DESC, rowid DESC
              LIMIT ${limit}
            `
          : yield* sql<CheckpointRow>`
              SELECT id, session_id, turn_id, root_path, root_hash,
                     commit_sha, reason, files_changed, insertions, deletions, created_at
              FROM checkpoints
              ORDER BY created_at DESC, rowid DESC
              LIMIT ${limit}
            `
        return rows.map(rowToCheckpoint)
      }),
    )
  }

  async listCheckpointsForRoot(rootHash: string, limit = 20): Promise<Checkpoint[]> {
    return this.query((sql) =>
      Effect.gen(function* () {
        const rows = yield* sql<CheckpointRow>`
          SELECT id, session_id, turn_id, root_path, root_hash,
                 commit_sha, reason, files_changed, insertions, deletions, created_at
          FROM checkpoints
          WHERE root_hash = ${rootHash}
          ORDER BY created_at DESC, rowid DESC
          LIMIT ${limit}
        `
        return rows.map(rowToCheckpoint)
      }),
    )
  }

  async deleteCheckpoints(ids: readonly string[]): Promise<void> {
    if (ids.length === 0) return
    await this.query((sql) =>
      Effect.gen(function* () {
        for (const id of ids) yield* sql`DELETE FROM checkpoints WHERE id = ${id}`
      }),
    )
  }

  async recordAgentWrite(rootHash: string, filePath: string, sha256: string): Promise<void> {
    await this.query((sql) =>
      sql`
        INSERT INTO agent_writes (root_hash, path, sha256, updated_at)
        VALUES (${rootHash}, ${filePath}, ${sha256}, ${nowIso()})
        ON CONFLICT(root_hash, path) DO UPDATE SET
          sha256 = excluded.sha256, updated_at = excluded.updated_at
      `.pipe(Effect.asVoid),
    )
  }

  async getAgentWrite(rootHash: string, filePath: string): Promise<AgentWriteRecord | null> {
    return this.query((sql) =>
      Effect.gen(function* () {
        const rows = yield* sql<{
          root_hash: string
          path: string
          sha256: string
          updated_at: string
        }>`
          SELECT root_hash, path, sha256, updated_at
          FROM agent_writes
          WHERE root_hash = ${rootHash} AND path = ${filePath}
        `
        const row = rows[0]
        return row
          ? {
              rootHash: row.root_hash,
              path: row.path,
              sha256: row.sha256,
              updatedAt: row.updated_at,
            }
          : null
      }),
    )
  }

  // ---------------------------------------------------------------------------
  // Memory

  async listMemoryEntries(store?: MemoryStoreName): Promise<MemoryEntry[]> {
    return this.query((sql) =>
      Effect.gen(function* () {
        if (store) {
          const rows = yield* sql<MemoryEntryRow>`
            SELECT id, store, content, position, created_at, updated_at
            FROM memory_entries
            WHERE store = ${store}
            ORDER BY position, id
          `
          return rows.map(rowToMemoryEntry)
        }
        const rows = yield* sql<MemoryEntryRow>`
          SELECT id, store, content, position, created_at, updated_at
          FROM memory_entries
          ORDER BY store, position, id
        `
        return rows.map(rowToMemoryEntry)
      }),
    )
  }

  async commitMemoryMutation(input: CommitMemoryMutation): Promise<MemoryHistoryRecord> {
    const id = newId("memh")
    const now = nowIso()
    await this.query((sql) =>
      sql.withTransaction(
        Effect.gen(function* () {
          yield* sql`DELETE FROM memory_entries WHERE store = ${input.store}`
          for (const [position, content] of input.entries.entries()) {
            yield* sql`
              INSERT INTO memory_entries (id, store, content, position, created_at, updated_at)
              VALUES (${newId("mem")}, ${input.store}, ${content}, ${position}, ${now}, ${now})
            `
          }
          yield* sql`
            INSERT INTO memory_history
              (id, store, action, before_json, after_json, pending_id, actor, note,
               created_at, undone_at, undo_history_id)
            VALUES
              (${id}, ${input.store}, ${input.action}, ${JSON.stringify(input.before)},
               ${JSON.stringify(input.after)}, ${input.pendingId ?? null}, ${input.actor},
               ${input.note ?? null}, ${now}, NULL, NULL)
          `
          if (input.pendingId && input.pendingDecision) {
            yield* sql`
              UPDATE memory_pending
              SET status = ${input.pendingDecision}, decided_at = ${now},
                  decided_by = ${input.pendingDecidedBy ?? input.actor}, reason = ${input.note ?? null}
              WHERE id = ${input.pendingId} AND status = 'pending'
            `
          }
          if (input.undoHistoryId) {
            yield* sql`
              UPDATE memory_history
              SET undone_at = ${now}, undo_history_id = ${id}
              WHERE id = ${input.undoHistoryId} AND undone_at IS NULL
            `
          }
        }),
      ),
    )
    return {
      id,
      store: input.store,
      action: input.action,
      before: input.before,
      after: input.after,
      pendingId: input.pendingId ?? null,
      actor: input.actor,
      note: input.note ?? null,
      createdAt: now,
      undoneAt: null,
      undoHistoryId: null,
    }
  }

  async createMemoryPending(input: NewMemoryPending): Promise<MemoryPendingRecord> {
    const id = newId("memp")
    const now = nowIso()
    const payload = JSON.stringify(input.payload)
    await this.query((sql) =>
      sql`
        INSERT INTO memory_pending
          (id, session_id, turn_id, store, action, payload_json, summary, origin, status,
           matched_entry, created_at, decided_at, decided_by, reason)
        VALUES
          (${id}, ${input.sessionId ?? null}, ${input.turnId ?? null}, ${input.store},
           ${input.action}, ${payload}, ${input.summary}, ${input.origin}, 'pending',
           ${input.matchedEntry ?? null}, ${now}, NULL, NULL, NULL)
      `.pipe(Effect.asVoid),
    )
    return {
      id,
      sessionId: input.sessionId ?? null,
      turnId: input.turnId ?? null,
      store: input.store,
      action: input.action,
      payload: input.payload,
      summary: input.summary,
      origin: input.origin,
      status: "pending",
      matchedEntry: input.matchedEntry ?? null,
      createdAt: now,
      decidedAt: null,
      decidedBy: null,
      reason: null,
    }
  }

  async getMemoryPending(id: string): Promise<MemoryPendingRecord | null> {
    return this.query((sql) =>
      Effect.gen(function* () {
        const rows = yield* sql<MemoryPendingRow>`
          SELECT id, session_id, turn_id, store, action, payload_json, summary, origin, status,
                 matched_entry, created_at, decided_at, decided_by, reason
          FROM memory_pending
          WHERE id = ${id}
        `
        const row = rows[0]
        return row ? rowToMemoryPending(row) : null
      }),
    )
  }

  async listMemoryPending(status?: MemoryPendingStatus, limit = 100): Promise<MemoryPendingRecord[]> {
    return this.query((sql) =>
      Effect.gen(function* () {
        const rows = status
          ? yield* sql<MemoryPendingRow>`
              SELECT id, session_id, turn_id, store, action, payload_json, summary, origin, status,
                     matched_entry, created_at, decided_at, decided_by, reason
              FROM memory_pending
              WHERE status = ${status}
              ORDER BY created_at DESC, rowid DESC
              LIMIT ${limit}
            `
          : yield* sql<MemoryPendingRow>`
              SELECT id, session_id, turn_id, store, action, payload_json, summary, origin, status,
                     matched_entry, created_at, decided_at, decided_by, reason
              FROM memory_pending
              ORDER BY created_at DESC, rowid DESC
              LIMIT ${limit}
            `
        return rows.map(rowToMemoryPending)
      }),
    )
  }

  async decideMemoryPending(
    id: string,
    status: "approved" | "rejected" | "expired" | "invalidated",
    decidedBy: string,
    reason: string | null,
  ): Promise<MemoryPendingRecord | null> {
    const now = nowIso()
    await this.query((sql) =>
      sql`
        UPDATE memory_pending
        SET status = ${status}, decided_at = ${now}, decided_by = ${decidedBy}, reason = ${reason}
        WHERE id = ${id} AND status = 'pending'
      `.pipe(Effect.asVoid),
    )
    return this.getMemoryPending(id)
  }

  async listMemoryHistory(limit = 100): Promise<MemoryHistoryRecord[]> {
    return this.query((sql) =>
      Effect.gen(function* () {
        const rows = yield* sql<MemoryHistoryRow>`
          SELECT id, store, action, before_json, after_json, pending_id, actor, note,
                 created_at, undone_at, undo_history_id
          FROM memory_history
          ORDER BY created_at DESC, rowid DESC
          LIMIT ${limit}
        `
        return rows.map(rowToMemoryHistory)
      }),
    )
  }

  async getMemoryHistory(id: string): Promise<MemoryHistoryRecord | null> {
    return this.query((sql) =>
      Effect.gen(function* () {
        const rows = yield* sql<MemoryHistoryRow>`
          SELECT id, store, action, before_json, after_json, pending_id, actor, note,
                 created_at, undone_at, undo_history_id
          FROM memory_history
          WHERE id = ${id}
        `
        const row = rows[0]
        return row ? rowToMemoryHistory(row) : null
      }),
    )
  }

  async createMemoryReviewRun(input: NewMemoryReviewRun): Promise<MemoryReviewRun> {
    const id = newId("mrev")
    const now = nowIso()
    await this.query((sql) =>
      sql`
        INSERT INTO memory_review_runs
          (id, session_id, status, trigger, provider_id, model_id, turns_since_memory,
           input_tokens, output_tokens, error, started_at, completed_at)
        VALUES
          (${id}, ${input.sessionId}, 'running', ${input.trigger}, ${input.providerId ?? null},
           ${input.modelId ?? null}, ${input.turnsSinceMemory}, 0, 0, NULL, ${now}, NULL)
      `.pipe(Effect.asVoid),
    )
    return {
      id,
      sessionId: input.sessionId,
      status: "running",
      trigger: input.trigger,
      providerId: input.providerId ?? null,
      modelId: input.modelId ?? null,
      turnsSinceMemory: input.turnsSinceMemory,
      inputTokens: 0,
      outputTokens: 0,
      error: null,
      startedAt: now,
      completedAt: null,
    }
  }

  async completeMemoryReviewRun(
    id: string,
    status: Exclude<MemoryReviewStatus, "running">,
    usage: { inputTokens: number; outputTokens: number } = { inputTokens: 0, outputTokens: 0 },
    error: string | null = null,
  ): Promise<MemoryReviewRun | null> {
    await this.query((sql) =>
      sql`
        UPDATE memory_review_runs
        SET status = ${status}, input_tokens = ${usage.inputTokens},
            output_tokens = ${usage.outputTokens}, error = ${error}, completed_at = ${nowIso()}
        WHERE id = ${id} AND status = 'running'
      `.pipe(Effect.asVoid),
    )
    return this.getMemoryReviewRun(id)
  }

  async getMemoryReviewRun(id: string): Promise<MemoryReviewRun | null> {
    return this.query((sql) =>
      Effect.gen(function* () {
        const rows = yield* sql<MemoryReviewRunRow>`
          SELECT id, session_id, status, trigger, provider_id, model_id, turns_since_memory,
                 input_tokens, output_tokens, error, started_at, completed_at
          FROM memory_review_runs
          WHERE id = ${id}
        `
        const row = rows[0]
        return row ? rowToMemoryReviewRun(row) : null
      }),
    )
  }

  async listMemoryReviewRuns(sessionId?: string, limit = 50): Promise<MemoryReviewRun[]> {
    return this.query((sql) =>
      Effect.gen(function* () {
        const rows = sessionId
          ? yield* sql<MemoryReviewRunRow>`
              SELECT id, session_id, status, trigger, provider_id, model_id, turns_since_memory,
                     input_tokens, output_tokens, error, started_at, completed_at
              FROM memory_review_runs
              WHERE session_id = ${sessionId}
              ORDER BY started_at DESC, rowid DESC
              LIMIT ${limit}
            `
          : yield* sql<MemoryReviewRunRow>`
              SELECT id, session_id, status, trigger, provider_id, model_id, turns_since_memory,
                     input_tokens, output_tokens, error, started_at, completed_at
              FROM memory_review_runs
              ORDER BY started_at DESC, rowid DESC
              LIMIT ${limit}
            `
        return rows.map(rowToMemoryReviewRun)
      }),
    )
  }

  async latestTerminalMemoryReview(sessionId: string): Promise<MemoryReviewRun | null> {
    return this.query((sql) =>
      Effect.gen(function* () {
        const rows = yield* sql<MemoryReviewRunRow>`
          SELECT id, session_id, status, trigger, provider_id, model_id, turns_since_memory,
                 input_tokens, output_tokens, error, started_at, completed_at
          FROM memory_review_runs
          WHERE session_id = ${sessionId} AND status IN ('completed', 'failed', 'cancelled')
          ORDER BY completed_at DESC, rowid DESC
          LIMIT 1
        `
        const row = rows[0]
        return row ? rowToMemoryReviewRun(row) : null
      }),
    )
  }

  async countUserMessagesSince(sessionId: string, since: string | null): Promise<number> {
    return this.query((sql) =>
      Effect.gen(function* () {
        const rows = since
          ? yield* sql<{ count: number }>`
              SELECT COUNT(*) AS count FROM messages
              WHERE session_id = ${sessionId} AND role = 'user' AND created_at > ${since}
            `
          : yield* sql<{ count: number }>`
              SELECT COUNT(*) AS count FROM messages
              WHERE session_id = ${sessionId} AND role = 'user'
            `
        return Number(rows[0]?.count ?? 0)
      }),
    )
  }

  async failRunningMemoryReviews(): Promise<number> {
    return this.query((sql) =>
      Effect.gen(function* () {
        const rows = yield* sql<{ id: string }>`
          UPDATE memory_review_runs
          SET status = 'failed', error = 'daemon restarted before the review completed',
              completed_at = ${nowIso()}
          WHERE status = 'running'
          RETURNING id
        `
        return rows.length
      }),
    )
  }
}
