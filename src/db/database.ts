import { Effect, ManagedRuntime } from "effect"
import { SqlClient } from "effect/sql"
import type { SqlError } from "effect/sql/SqlError"
import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-bun"
import { mkdirSync } from "node:fs"
import path from "node:path"
import type {
  Approval,
  ApprovalStatus,
  AuditEntry,
  EventRecord,
  Message,
  MessageRole,
  ModelProfile,
  ModelProfileInput,
  PermissionRule,
  RuleEffect,
  Session,
  TokenUsage,
  Turn,
  TurnStatus,
} from "../shared/types"
import { newId } from "../core/ids"
import { nowIso } from "../core/time"
import { backupIfNeeded, schemaVersion } from "./backup"
import { LATEST_SCHEMA_VERSION, migrationLoader } from "./migrations"

interface SessionRow {
  readonly id: string
  readonly title: string
  readonly created_at: string
  readonly updated_at: string
  readonly model_profile_id: string | null
  readonly summary: string | null
  readonly summary_through_seq: number | null
}

interface ModelProfileRow {
  readonly id: string
  readonly name: string
  readonly kind: "cloud" | "local"
  readonly base_url: string
  readonly model_id: string
  readonly context_window: number
  readonly max_output_tokens: number
  readonly cost_input_per_million: number
  readonly cost_output_per_million: number
  readonly supports_tools: number
  readonly supports_streaming: number
  readonly created_at: string
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
  readonly created_at: string
}

interface TurnRow {
  readonly id: string
  readonly session_id: string
  readonly status: string
  readonly model_profile_id: string
  readonly user_message_id: string
  readonly step_count: number
  readonly input_tokens: number
  readonly output_tokens: number
  readonly cost_usd: number
  readonly error: string | null
  readonly started_at: string
  readonly updated_at: string
  readonly completed_at: string | null
}

interface CheckpointRow {
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
  readonly arguments_json: string
  readonly arguments_hash: string
  readonly status: ApprovalStatus
  readonly created_at: string
  readonly expires_at: string
  readonly decided_at: string | null
  readonly decided_by: string | null
  readonly reason: string | null
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

interface EventRow {
  readonly seq: number
  readonly type: string
  readonly session_id: string | null
  readonly payload: string
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
}

export interface TurnStepInput {
  readonly step: number
  readonly sessionId: string
  readonly messages?: readonly NewMessage[]
  readonly checkpoint: unknown
  readonly usage?: TokenUsage
  readonly status?: TurnStatus
  readonly error?: string | null
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
    modelProfileId: row.model_profile_id,
    summary: row.summary,
    summaryThroughSeq: row.summary_through_seq,
  }
}

function rowToModelProfile(row: ModelProfileRow, hasApiKey: boolean): import("../shared/types").ModelProfile {
  return {
    id: row.id,
    name: row.name,
    kind: row.kind,
    baseUrl: row.base_url,
    modelId: row.model_id,
    contextWindow: row.context_window,
    maxOutputTokens: row.max_output_tokens,
    costInputPerMillion: row.cost_input_per_million,
    costOutputPerMillion: row.cost_output_per_million,
    supportsTools: row.supports_tools === 1,
    supportsStreaming: row.supports_streaming === 1,
    hasApiKey,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  }
}

function rowToMessage(row: MessageRow): import("../shared/types").Message {
  let content: unknown = {}
  try {
    content = JSON.parse(row.content_json) as unknown
  } catch {
    content = {}
  }
  return {
    id: row.id,
    seq: row.seq,
    sessionId: row.session_id,
    turnId: row.turn_id,
    role: row.role,
    text: row.text,
    content,
    createdAt: row.created_at,
  }
}

function rowToTurn(row: TurnRow): Turn {
  return {
    id: row.id,
    sessionId: row.session_id,
    status: row.status as TurnStatus,
    modelProfileId: row.model_profile_id,
    userMessageId: row.user_message_id,
    stepCount: row.step_count,
    inputTokens: row.input_tokens,
    outputTokens: row.output_tokens,
    costUsd: row.cost_usd,
    error: row.error,
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
    arguments: args,
    argumentsHash: row.arguments_hash,
    status: row.status,
    createdAt: row.created_at,
    expiresAt: row.expires_at,
    decidedAt: row.decided_at,
    decidedBy: row.decided_by,
    reason: row.reason,
  }
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
  readonly arguments: unknown
  readonly argumentsHash: string
  readonly expiresAt: string
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
        `Database schema v${previousVersion} is newer than this daemon supports (v${LATEST_SCHEMA_VERSION})`,
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
          SELECT id, title, created_at, updated_at, model_profile_id, summary, summary_through_seq
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
          SELECT id, title, created_at, updated_at, model_profile_id, summary, summary_through_seq
          FROM sessions
          WHERE id = ${id}
        `
        const row = rows[0]
        return row ? rowToSession(row) : null
      }),
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
  // Model profiles

  async listModelProfiles(): Promise<ModelProfile[]> {
    return this.query((sql) =>
      Effect.gen(function* () {
        const rows = yield* sql<ModelProfileRow>`
          SELECT id, name, kind, base_url, model_id, context_window, max_output_tokens,
                 cost_input_per_million, cost_output_per_million, supports_tools,
                 supports_streaming, created_at, updated_at
          FROM model_profiles
          ORDER BY name ASC, id ASC
        `
        return rows.map((row) => rowToModelProfile(row, false))
      }),
    )
  }

  async getModelProfile(id: string): Promise<ModelProfile | null> {
    return this.query((sql) =>
      Effect.gen(function* () {
        const rows = yield* sql<ModelProfileRow>`
          SELECT id, name, kind, base_url, model_id, context_window, max_output_tokens,
                 cost_input_per_million, cost_output_per_million, supports_tools,
                 supports_streaming, created_at, updated_at
          FROM model_profiles
          WHERE id = ${id}
        `
        const row = rows[0]
        return row ? rowToModelProfile(row, false) : null
      }),
    )
  }

  async createModelProfile(
    input: Required<Pick<ModelProfileInput, "name" | "kind" | "baseUrl" | "modelId">> &
      Pick<ModelProfileInput, "contextWindow" | "maxOutputTokens" | "costInputPerMillion" | "costOutputPerMillion"> & {
        supportsTools: boolean
      },
  ): Promise<ModelProfile> {
    const id = newId("mdl")
    const now = nowIso()
    const contextWindow = input.contextWindow ?? 32_768
    const maxOutputTokens = input.maxOutputTokens ?? 4_096
    const costInput = input.costInputPerMillion ?? 0
    const costOutput = input.costOutputPerMillion ?? 0
    return this.query((sql) =>
      Effect.gen(function* () {
        yield* sql`
          INSERT INTO model_profiles
            (id, name, kind, base_url, model_id, context_window, max_output_tokens,
             cost_input_per_million, cost_output_per_million, supports_tools,
             supports_streaming, created_at, updated_at)
          VALUES
            (${id}, ${input.name}, ${input.kind}, ${input.baseUrl}, ${input.modelId},
             ${contextWindow}, ${maxOutputTokens}, ${costInput}, ${costOutput},
             ${input.supportsTools ? 1 : 0}, 1, ${now}, ${now})
        `
        return {
          id,
          name: input.name,
          kind: input.kind,
          baseUrl: input.baseUrl,
          modelId: input.modelId,
          contextWindow,
          maxOutputTokens,
          costInputPerMillion: costInput,
          costOutputPerMillion: costOutput,
          supportsTools: input.supportsTools,
          supportsStreaming: true,
          hasApiKey: false,
          createdAt: now,
          updatedAt: now,
        }
      }),
    )
  }

  async updateModelProfile(
    id: string,
    input: Partial<
      Required<Pick<ModelProfileInput, "name" | "kind" | "baseUrl" | "modelId">> & {
        contextWindow: number
        maxOutputTokens: number
        costInputPerMillion: number
        costOutputPerMillion: number
        supportsTools: boolean
      }
    >,
  ): Promise<ModelProfile | null> {
    const current = await this.getModelProfile(id)
    if (!current) return null
    const next = {
      name: input.name ?? current.name,
      kind: input.kind ?? current.kind,
      baseUrl: input.baseUrl ?? current.baseUrl,
      modelId: input.modelId ?? current.modelId,
      contextWindow: input.contextWindow ?? current.contextWindow,
      maxOutputTokens: input.maxOutputTokens ?? current.maxOutputTokens,
      costInputPerMillion: input.costInputPerMillion ?? current.costInputPerMillion,
      costOutputPerMillion: input.costOutputPerMillion ?? current.costOutputPerMillion,
      supportsTools: input.supportsTools ?? current.supportsTools,
      now: nowIso(),
    }
    await this.query((sql) =>
      sql`
        UPDATE model_profiles SET
          name = ${next.name},
          kind = ${next.kind},
          base_url = ${next.baseUrl},
          model_id = ${next.modelId},
          context_window = ${next.contextWindow},
          max_output_tokens = ${next.maxOutputTokens},
          cost_input_per_million = ${next.costInputPerMillion},
          cost_output_per_million = ${next.costOutputPerMillion},
          supports_tools = ${next.supportsTools ? 1 : 0},
          updated_at = ${next.now}
        WHERE id = ${id}
      `.pipe(Effect.asVoid),
    )
    return this.getModelProfile(id)
  }

  async deleteModelProfile(id: string): Promise<void> {
    await this.query((sql) => sql`DELETE FROM model_profiles WHERE id = ${id}`.pipe(Effect.asVoid))
  }

  async setSessionModelProfile(sessionId: string, modelProfileId: string | null): Promise<void> {
    await this.query((sql) =>
      sql`
        UPDATE sessions SET model_profile_id = ${modelProfileId}, updated_at = ${nowIso()}
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
          SELECT id, seq, session_id, turn_id, role, text, content_json, created_at
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
          SELECT id, session_id, status, model_profile_id, user_message_id, step_count,
                 input_tokens, output_tokens, cost_usd, error, started_at, updated_at,
                 completed_at
          FROM turns
          WHERE id = ${turnId}
        `
        const row = rows[0]
        return row ? rowToTurn(row) : null
      }),
    )
  }

  async listTurns(sessionId: string, limit = 50): Promise<Turn[]> {
    return this.query((sql) =>
      Effect.gen(function* () {
        const rows = yield* sql<TurnRow>`
          SELECT id, session_id, status, model_profile_id, user_message_id, step_count,
                 input_tokens, output_tokens, cost_usd, error, started_at, updated_at,
                 completed_at
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
    modelProfileId: string,
    text: string,
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
              INSERT INTO messages (id, session_id, turn_id, role, text, content_json, created_at)
              VALUES (${messageId}, ${sessionId}, ${turnId}, 'user', ${text}, ${JSON.stringify(content)}, ${now})
              RETURNING seq
            `
            const seq = inserted[0]?.seq
            if (seq === undefined) throw new Error("Failed to persist user message")
            yield* sql`
              INSERT INTO turns
                (id, session_id, status, model_profile_id, user_message_id, step_count,
                 input_tokens, output_tokens, cost_usd, error, checkpoint_json,
                 started_at, updated_at, completed_at)
              VALUES
                (${turnId}, ${sessionId}, 'queued', ${modelProfileId}, ${messageId}, 0,
                 0, 0, 0, NULL, NULL, ${now}, ${now}, NULL)
            `
            yield* sql`UPDATE sessions SET updated_at = ${now} WHERE id = ${sessionId}`
            const turn: Turn = {
              id: turnId,
              sessionId,
              status: "queued",
              modelProfileId,
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
              INSERT INTO messages (id, session_id, turn_id, role, text, content_json, created_at)
              VALUES (${id}, ${input.sessionId}, ${turnId}, ${message.role}, ${message.text},
                      ${JSON.stringify(message.content)}, ${now})
              RETURNING seq
            `
            const seq = inserted[0]?.seq
            if (seq === undefined) throw new Error("Failed to persist turn message")
            newMessages.push({
              id,
              seq,
              sessionId: input.sessionId,
              turnId,
              role: message.role,
              text: message.text,
              content: message.content,
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

  async setTurnStatus(turnId: string, status: TurnStatus, error: string | null = null): Promise<void> {
    const now = nowIso()
    const terminal = status === "completed" || status === "failed" || status === "cancelled"
    await this.query((sql) =>
      sql`
        UPDATE turns SET status = ${status}, error = ${error}, updated_at = ${now},
          completed_at = ${terminal ? now : null}
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
        const rows = yield* sql<CheckpointRow>`
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
          SELECT id, session_id, status, model_profile_id, user_message_id, step_count,
                 input_tokens, output_tokens, cost_usd, error, started_at, updated_at,
                 completed_at
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
          (id, turn_id, session_id, tool_call_id, tool_name, arguments_json, arguments_hash,
           status, created_at, expires_at, decided_at, decided_by, reason)
        VALUES
          (${id}, ${input.turnId}, ${input.sessionId}, ${input.toolCallId}, ${input.toolName},
           ${JSON.stringify(input.arguments)}, ${input.argumentsHash}, 'pending', ${now},
           ${input.expiresAt}, NULL, NULL, NULL)
      `.pipe(Effect.asVoid),
    )
    return {
      id,
      turnId: input.turnId,
      sessionId: input.sessionId,
      toolCallId: input.toolCallId,
      toolName: input.toolName,
      arguments: input.arguments,
      argumentsHash: input.argumentsHash,
      status: "pending",
      createdAt: now,
      expiresAt: input.expiresAt,
      decidedAt: null,
      decidedBy: null,
      reason: null,
    }
  }

  async getApproval(id: string): Promise<Approval | null> {
    return this.query((sql) =>
      Effect.gen(function* () {
        const rows = yield* sql<ApprovalRow>`
          SELECT id, turn_id, session_id, tool_call_id, tool_name, arguments_json,
                 arguments_hash, status, created_at, expires_at, decided_at, decided_by, reason
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
          SELECT id, turn_id, session_id, tool_call_id, tool_name, arguments_json,
                 arguments_hash, status, created_at, expires_at, decided_at, decided_by, reason
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
              SELECT id, turn_id, session_id, tool_call_id, tool_name, arguments_json,
                     arguments_hash, status, created_at, expires_at, decided_at, decided_by, reason
              FROM approvals
              WHERE status = ${status}
              ORDER BY created_at DESC
              LIMIT ${limit}
            `
          : yield* sql<ApprovalRow>`
              SELECT id, turn_id, session_id, tool_call_id, tool_name, arguments_json,
                     arguments_hash, status, created_at, expires_at, decided_at, decided_by, reason
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
  ): Promise<Approval | null> {
    const now = nowIso()
    await this.query((sql) =>
      sql`
        UPDATE approvals
        SET status = ${status}, decided_at = ${now}, decided_by = ${decidedBy}, reason = ${reason}
        WHERE id = ${id} AND status = 'pending'
      `.pipe(Effect.asVoid),
    )
    return this.getApproval(id)
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
}
