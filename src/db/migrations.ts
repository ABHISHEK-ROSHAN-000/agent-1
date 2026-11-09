import { Effect } from "effect"
import { SqlClient } from "effect/sql"
import { SqliteMigrator } from "@effect/sql-sqlite-bun"

export const LATEST_SCHEMA_VERSION = 4

const initial = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `
  yield* sql`
    CREATE TABLE IF NOT EXISTS events (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      type TEXT NOT NULL,
      session_id TEXT,
      payload TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `
  yield* sql`CREATE INDEX IF NOT EXISTS events_created_at_idx ON events (created_at)`
  yield* sql`CREATE INDEX IF NOT EXISTS events_session_id_idx ON events (session_id)`

  yield* sql`
    CREATE TABLE IF NOT EXISTS auth_sessions (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      last_seen_at TEXT NOT NULL
    )
  `
  yield* sql`CREATE INDEX IF NOT EXISTS auth_sessions_token_idx ON auth_sessions (token_hash)`
  yield* sql`CREATE INDEX IF NOT EXISTS auth_sessions_expiry_idx ON auth_sessions (expires_at)`

  yield* sql`
    CREATE TABLE IF NOT EXISTS pairing_tokens (
      id TEXT PRIMARY KEY,
      token_hash TEXT NOT NULL UNIQUE,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      used_at TEXT
    )
  `
  yield* sql`CREATE INDEX IF NOT EXISTS pairing_tokens_token_idx ON pairing_tokens (token_hash)`

  yield* sql`
    CREATE TABLE IF NOT EXISTS idempotency_keys (
      key TEXT PRIMARY KEY,
      method TEXT NOT NULL,
      path TEXT NOT NULL,
      status INTEGER NOT NULL,
      response TEXT NOT NULL,
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL
    )
  `
  yield* sql`CREATE INDEX IF NOT EXISTS idempotency_expiry_idx ON idempotency_keys (expires_at)`

  yield* sql`
    CREATE TABLE IF NOT EXISTS settings (
      key TEXT PRIMARY KEY,
      value TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `

  yield* Effect.void
})

const agentRuntime = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`ALTER TABLE sessions ADD COLUMN model_profile_id TEXT`
  yield* sql`ALTER TABLE sessions ADD COLUMN summary TEXT`
  yield* sql`ALTER TABLE sessions ADD COLUMN summary_through_seq INTEGER`

  yield* sql`
    CREATE TABLE IF NOT EXISTS model_profiles (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('cloud', 'local')),
      base_url TEXT NOT NULL,
      model_id TEXT NOT NULL,
      context_window INTEGER NOT NULL,
      max_output_tokens INTEGER NOT NULL,
      cost_input_per_million REAL NOT NULL DEFAULT 0,
      cost_output_per_million REAL NOT NULL DEFAULT 0,
      supports_tools INTEGER NOT NULL DEFAULT 0,
      supports_streaming INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `
  yield* sql`CREATE INDEX IF NOT EXISTS model_profiles_name_idx ON model_profiles (name)`

  yield* sql`
    CREATE TABLE IF NOT EXISTS messages (
      seq INTEGER PRIMARY KEY AUTOINCREMENT,
      id TEXT NOT NULL UNIQUE,
      session_id TEXT NOT NULL,
      turn_id TEXT,
      role TEXT NOT NULL,
      text TEXT NOT NULL DEFAULT '',
      content_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `
  yield* sql`CREATE INDEX IF NOT EXISTS messages_session_seq_idx ON messages (session_id, seq)`
  yield* sql`CREATE INDEX IF NOT EXISTS messages_turn_idx ON messages (turn_id)`

  yield* sql`
    CREATE TABLE IF NOT EXISTS turns (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      status TEXT NOT NULL,
      model_profile_id TEXT NOT NULL,
      user_message_id TEXT NOT NULL,
      step_count INTEGER NOT NULL DEFAULT 0,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      error TEXT,
      checkpoint_json TEXT,
      started_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      completed_at TEXT
    )
  `
  yield* sql`CREATE INDEX IF NOT EXISTS turns_session_idx ON turns (session_id, started_at)`
  yield* sql`CREATE INDEX IF NOT EXISTS turns_status_idx ON turns (status)`

  yield* sql`
    CREATE TABLE IF NOT EXISTS turn_checkpoints (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      turn_id TEXT NOT NULL,
      step INTEGER NOT NULL,
      state_json TEXT NOT NULL,
      created_at TEXT NOT NULL
    )
  `
  yield* sql`CREATE INDEX IF NOT EXISTS turn_checkpoints_turn_idx ON turn_checkpoints (turn_id, id)`

  yield* Effect.void
})

const permissions = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    CREATE TABLE IF NOT EXISTS permission_rules (
      id TEXT PRIMARY KEY,
      action TEXT NOT NULL,
      resource TEXT NOT NULL DEFAULT '*',
      effect TEXT NOT NULL CHECK (effect IN ('allow', 'ask', 'deny')),
      position INTEGER NOT NULL DEFAULT 0,
      ttl_seconds INTEGER,
      expires_at TEXT,
      note TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `
  yield* sql`CREATE INDEX IF NOT EXISTS permission_rules_position_idx ON permission_rules (position, id)`

  yield* sql`
    CREATE TABLE IF NOT EXISTS approvals (
      id TEXT PRIMARY KEY,
      turn_id TEXT NOT NULL,
      session_id TEXT NOT NULL,
      tool_call_id TEXT NOT NULL,
      tool_name TEXT NOT NULL,
      arguments_json TEXT NOT NULL,
      arguments_hash TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'invalidated')),
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      decided_at TEXT,
      decided_by TEXT,
      reason TEXT
    )
  `
  yield* sql`CREATE INDEX IF NOT EXISTS approvals_status_idx ON approvals (status, created_at)`
  yield* sql`CREATE INDEX IF NOT EXISTS approvals_turn_idx ON approvals (turn_id, tool_call_id)`

  yield* sql`
    CREATE TABLE IF NOT EXISTS audit_log (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      at TEXT NOT NULL,
      actor TEXT NOT NULL,
      action TEXT NOT NULL,
      resource TEXT NOT NULL,
      decision TEXT NOT NULL,
      rule_id TEXT,
      approval_id TEXT,
      turn_id TEXT,
      details_json TEXT NOT NULL
    )
  `
  yield* sql`CREATE INDEX IF NOT EXISTS audit_log_at_idx ON audit_log (at)`

  const now = new Date().toISOString()
  const rules: Array<[string, string, string, string, number, string]> = [
    ["rule_allow_test_echo", "tool.test_echo", "*", "allow", 10, "Read-only test echo tool"],
    ["rule_allow_test_time", "tool.test_time", "*", "allow", 11, "Read-only test clock tool"],
    ["rule_ask_test_confirm", "tool.test_confirm", "*", "ask", 30, "Approval-gated test tool"],
    ["rule_ask_fs_writes", "fs.write", "*", "ask", 40, "Future filesystem writes"],
    ["rule_ask_shell", "shell.exec", "*", "ask", 41, "Future shell commands"],
    ["rule_ask_connectors", "connector.*", "*", "ask", 42, "Future connector actions"],
  ]
  for (const [id, action, resource, effect, position, note] of rules) {
    yield* sql`
      INSERT OR IGNORE INTO permission_rules
        (id, action, resource, effect, position, ttl_seconds, expires_at, note, created_at, updated_at)
      VALUES (${id}, ${action}, ${resource}, ${effect}, ${position}, NULL, NULL, ${note}, ${now}, ${now})
    `
  }

  yield* Effect.void
})

const coreTools = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient

  yield* sql`
    CREATE TABLE IF NOT EXISTS workspaces (
      id TEXT PRIMARY KEY,
      label TEXT NOT NULL,
      path TEXT NOT NULL UNIQUE,
      access TEXT NOT NULL CHECK (access IN ('read', 'write')),
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `
  yield* sql`CREATE INDEX IF NOT EXISTS workspaces_path_idx ON workspaces (path)`

  yield* sql`
    CREATE TABLE IF NOT EXISTS journal (
      id TEXT PRIMARY KEY,
      batch_id TEXT NOT NULL,
      turn_id TEXT,
      session_id TEXT,
      tool_name TEXT NOT NULL,
      operation TEXT NOT NULL,
      source TEXT,
      target TEXT,
      source_hash TEXT,
      target_hash TEXT,
      state TEXT NOT NULL CHECK (state IN ('planned', 'applying', 'done', 'failed', 'unknown', 'undone')),
      undo_json TEXT NOT NULL DEFAULT '{}',
      error TEXT,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `
  yield* sql`CREATE INDEX IF NOT EXISTS journal_batch_idx ON journal (batch_id, id)`
  yield* sql`CREATE INDEX IF NOT EXISTS journal_turn_idx ON journal (turn_id, id)`
  yield* sql`CREATE INDEX IF NOT EXISTS journal_state_idx ON journal (state)`

  const now = new Date().toISOString()
  const rules: Array<[string, string, string, string, number, string]> = [
    ["rule_allow_web_fetch", "web.fetch", "*", "allow", 50, "Fetch public web content with SSRF guard"],
    ["rule_allow_web_search", "web.search", "*", "allow", 51, "Search with configured provider"],
    ["rule_ask_fs_write", "fs.write", "*", "ask", 60, "File writes require approval"],
    ["rule_ask_fs_mkdir", "fs.mkdir", "*", "ask", 61, "Directory creation requires approval"],
    ["rule_ask_fs_moves", "fs.apply_moves", "*", "ask", 62, "Batch moves require approval"],
    ["rule_ask_fs_undo", "fs.undo", "*", "ask", 63, "Undo requires approval"],
    ["rule_deny_fs_delete", "fs.delete", "*", "deny", 64, "Hard delete is disabled"],
    ["rule_ask_shell_exec", "shell.exec", "*", "ask", 65, "Shell commands require approval"],
  ]
  for (const [id, action, resource, effect, position, note] of rules) {
    yield* sql`
      INSERT OR IGNORE INTO permission_rules
        (id, action, resource, effect, position, ttl_seconds, expires_at, note, created_at, updated_at)
      VALUES (${id}, ${action}, ${resource}, ${effect}, ${position}, NULL, NULL, ${note}, ${now}, ${now})
    `
  }

  yield* Effect.void
})

export const migrationLoader = SqliteMigrator.fromRecord({
  "0001_initial": initial,
  "0002_agent_runtime": agentRuntime,
  "0003_permissions": permissions,
  "0004_core_tools": coreTools,
})
