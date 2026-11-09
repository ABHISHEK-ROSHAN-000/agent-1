import { Effect, ManagedRuntime } from "effect"
import { SqlClient } from "effect/sql"
import type { SqlError } from "effect/sql/SqlError"
import { SqliteClient, SqliteMigrator } from "@effect/sql-sqlite-bun"
import { mkdirSync } from "node:fs"
import path from "node:path"
import type { EventRecord, Session } from "../shared/types"
import { newId } from "../core/ids"
import { nowIso } from "../core/time"
import { backupIfNeeded, schemaVersion } from "./backup"
import { LATEST_SCHEMA_VERSION, migrationLoader } from "./migrations"

interface SessionRow {
  readonly id: string
  readonly title: string
  readonly created_at: string
  readonly updated_at: string
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
  }
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
          SELECT id, title, created_at, updated_at
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
          SELECT id, title, created_at, updated_at
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
}
