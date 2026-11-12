import { Effect } from "effect"
import { SqlClient } from "effect/sql"

export const initialMigration = Effect.gen(function* () {
  const sql = yield* SqlClient.SqlClient
  const now = new Date().toISOString()

  yield* sql`
    CREATE TABLE IF NOT EXISTS sessions (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL,
      provider_id TEXT,
      model_id TEXT,
      summary TEXT,
      summary_through_seq INTEGER,
      reasoning_effort TEXT,
      memory_snapshot_json TEXT,
      memory_snapshot_at TEXT
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
    CREATE VIRTUAL TABLE IF NOT EXISTS messages_fts USING fts5(
      text,
      content='messages',
      content_rowid='seq',
      tokenize='unicode61'
    )
  `
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS messages_fts_ai AFTER INSERT ON messages BEGIN
      INSERT INTO messages_fts(rowid, text) VALUES (new.seq, new.text);
    END
  `
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS messages_fts_ad AFTER DELETE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, text)
        VALUES ('delete', old.seq, old.text);
    END
  `
  yield* sql`
    CREATE TRIGGER IF NOT EXISTS messages_fts_au AFTER UPDATE ON messages BEGIN
      INSERT INTO messages_fts(messages_fts, rowid, text)
        VALUES ('delete', old.seq, old.text);
      INSERT INTO messages_fts(rowid, text) VALUES (new.seq, new.text);
    END
  `
  yield* sql`INSERT INTO messages_fts(messages_fts) VALUES ('rebuild')`

  yield* sql`
    CREATE TABLE IF NOT EXISTS turns (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      status TEXT NOT NULL,
      provider_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      user_message_id TEXT NOT NULL,
      step_count INTEGER NOT NULL DEFAULT 0,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      cost_usd REAL NOT NULL DEFAULT 0,
      error TEXT,
      error_details_json TEXT,
      checkpoint_json TEXT,
      reasoning_effort TEXT,
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
      action TEXT NOT NULL DEFAULT 'tool.unknown',
      resource TEXT NOT NULL DEFAULT '*',
      pattern_key TEXT NOT NULL DEFAULT '*',
      arguments_json TEXT NOT NULL,
      arguments_hash TEXT NOT NULL,
      display_command TEXT,
      status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'invalidated')),
      created_at TEXT NOT NULL,
      expires_at TEXT NOT NULL,
      decided_at TEXT,
      decided_by TEXT,
      reason TEXT,
      scope TEXT CHECK (scope IN ('once', 'session', 'always'))
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

  yield* sql`
    CREATE TABLE IF NOT EXISTS providers (
      id TEXT PRIMARY KEY,
      name TEXT NOT NULL,
      kind TEXT NOT NULL CHECK (kind IN ('cloud', 'local')),
      base_url TEXT NOT NULL,
      env_json TEXT NOT NULL DEFAULT '[]',
      headers_json TEXT,
      enabled INTEGER NOT NULL DEFAULT 1,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `
  yield* sql`
    CREATE TABLE IF NOT EXISTS provider_credentials (
      id TEXT PRIMARY KEY,
      provider_id TEXT NOT NULL,
      label TEXT NOT NULL,
      active INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `
  yield* sql`CREATE INDEX IF NOT EXISTS provider_credentials_provider_idx ON provider_credentials (provider_id, active)`
  yield* sql`
    CREATE TABLE IF NOT EXISTS provider_models (
      provider_id TEXT NOT NULL,
      model_id TEXT NOT NULL,
      name TEXT NOT NULL,
      family TEXT,
      type TEXT NOT NULL DEFAULT 'chat',
      released_at TEXT,
      status TEXT,
      context_limit INTEGER NOT NULL DEFAULT 32768,
      output_limit INTEGER NOT NULL DEFAULT 4096,
      input_modalities_json TEXT NOT NULL DEFAULT '["text"]',
      output_modalities_json TEXT NOT NULL DEFAULT '["text"]',
      tools_supported INTEGER NOT NULL DEFAULT 0,
      temperature_supported INTEGER NOT NULL DEFAULT 1,
      reasoning INTEGER NOT NULL DEFAULT 0,
      reasoning_options_json TEXT NOT NULL DEFAULT '[]',
      cost_input REAL NOT NULL DEFAULT 0,
      cost_output REAL NOT NULL DEFAULT 0,
      cost_cache_read REAL NOT NULL DEFAULT 0,
      cost_cache_write REAL NOT NULL DEFAULT 0,
      enabled INTEGER NOT NULL DEFAULT 1,
      favorite INTEGER NOT NULL DEFAULT 0,
      last_used_at TEXT,
      metadata_json TEXT NOT NULL DEFAULT '{}',
      updated_at TEXT NOT NULL,
      PRIMARY KEY (provider_id, model_id)
    )
  `
  yield* sql`CREATE INDEX IF NOT EXISTS provider_models_name_idx ON provider_models (provider_id, name)`
  yield* sql`CREATE INDEX IF NOT EXISTS provider_models_enabled_idx ON provider_models (enabled, provider_id)`

  yield* sql`
    CREATE TABLE IF NOT EXISTS memory_entries (
      id TEXT PRIMARY KEY,
      store TEXT NOT NULL CHECK (store IN ('user', 'memory')),
      content TEXT NOT NULL,
      position INTEGER NOT NULL DEFAULT 0,
      created_at TEXT NOT NULL,
      updated_at TEXT NOT NULL
    )
  `
  yield* sql`CREATE UNIQUE INDEX IF NOT EXISTS memory_entries_exact_idx ON memory_entries (store, content)`
  yield* sql`CREATE INDEX IF NOT EXISTS memory_entries_store_position_idx ON memory_entries (store, position)`

  yield* sql`
    CREATE TABLE IF NOT EXISTS memory_pending (
      id TEXT PRIMARY KEY,
      session_id TEXT,
      turn_id TEXT,
      store TEXT NOT NULL CHECK (store IN ('user', 'memory')),
      action TEXT NOT NULL CHECK (action IN ('add', 'patch', 'remove')),
      payload_json TEXT NOT NULL,
      summary TEXT NOT NULL,
      origin TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('pending', 'approved', 'rejected', 'expired', 'invalidated')),
      matched_entry TEXT,
      created_at TEXT NOT NULL,
      decided_at TEXT,
      decided_by TEXT,
      reason TEXT
    )
  `
  yield* sql`CREATE INDEX IF NOT EXISTS memory_pending_status_idx ON memory_pending (status, created_at)`
  yield* sql`CREATE INDEX IF NOT EXISTS memory_pending_session_idx ON memory_pending (session_id, created_at)`

  yield* sql`
    CREATE TABLE IF NOT EXISTS memory_history (
      id TEXT PRIMARY KEY,
      store TEXT NOT NULL CHECK (store IN ('user', 'memory')),
      action TEXT NOT NULL,
      before_json TEXT NOT NULL,
      after_json TEXT NOT NULL,
      pending_id TEXT,
      actor TEXT NOT NULL,
      note TEXT,
      created_at TEXT NOT NULL,
      undone_at TEXT,
      undo_history_id TEXT
    )
  `
  yield* sql`CREATE INDEX IF NOT EXISTS memory_history_store_idx ON memory_history (store, created_at)`
  yield* sql`CREATE INDEX IF NOT EXISTS memory_history_pending_idx ON memory_history (pending_id)`

  yield* sql`
    CREATE TABLE IF NOT EXISTS memory_review_runs (
      id TEXT PRIMARY KEY,
      session_id TEXT NOT NULL,
      status TEXT NOT NULL CHECK (status IN ('running', 'completed', 'failed', 'cancelled')),
      trigger TEXT NOT NULL,
      provider_id TEXT,
      model_id TEXT,
      turns_since_memory INTEGER NOT NULL DEFAULT 0,
      input_tokens INTEGER NOT NULL DEFAULT 0,
      output_tokens INTEGER NOT NULL DEFAULT 0,
      error TEXT,
      started_at TEXT NOT NULL,
      completed_at TEXT
    )
  `
  yield* sql`CREATE INDEX IF NOT EXISTS memory_review_runs_session_idx ON memory_review_runs (session_id, started_at)`

  const rules: Array<[string, string, string, string, number, string]> = [
    ["rule_allow_test_echo", "tool.test_echo", "*", "allow", 10, "Read-only test echo tool"],
    ["rule_allow_test_time", "tool.test_time", "*", "allow", 11, "Read-only test clock tool"],
    ["rule_allow_memory", "memory.write", "*", "allow", 20, "Memory follows the owner-approved memory default"],
    ["rule_ask_test_confirm", "tool.test_confirm", "*", "ask", 30, "Approval-gated test tool"],
    ["rule_ask_connectors", "connector.*", "*", "ask", 42, "Future connector actions"],
    ["rule_allow_web_fetch", "web.fetch", "*", "allow", 50, "Fetch public web content with SSRF guard"],
    ["rule_allow_web_search", "web.search", "*", "allow", 51, "Search with configured provider"],
    ["rule_allow_session_search", "session.search", "*", "allow", 52, "Read-only historical conversation search"],
    ["rule_deny_fs_delete", "fs.delete", "*", "deny", 64, "Hard delete is disabled"],
  ]
  for (const [id, action, resource, effect, position, note] of rules) {
    yield* sql`
      INSERT OR IGNORE INTO permission_rules
        (id, action, resource, effect, position, ttl_seconds, expires_at, note, created_at, updated_at)
      VALUES (${id}, ${action}, ${resource}, ${effect}, ${position}, NULL, NULL, ${note}, ${now}, ${now})
    `
  }

  const settings: Array<[string, string]> = [
    ["approval.mode", "smart"],
    ["approval.timeout_seconds", "300"],
    ["approval.deny", "[]"],
    ["approval.allowlist", "[]"],
    ["approval.write_safe_root", ""],
    ["approval.smart_model", ""],
  ]
  for (const [key, value] of settings) {
    yield* sql`
      INSERT OR IGNORE INTO settings (key, value, updated_at)
      VALUES (${key}, ${value}, ${now})
    `
  }

  yield* Effect.void
})
