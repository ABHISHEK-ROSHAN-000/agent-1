# Source map

Phase 1 through Phase 6.1 modules are implemented. Phase 7 steps 1–5 add the fresh v1 schema, memory tables/FTS5, bounded memory store, exact matching, atomic mutations, history/undo, pending destructive changes, the hostile-content scanner, the memory tool, frozen prompt snapshots, and the background memory reviewer. The search tool, API, and UI are next.

| Directory | Responsibility | Phase |
|---|---|---|
| `core/` | version, paths, config, IDs, JSON, logging | 0–1 |
| `cli/` | command-line client | 0 |
| `daemon/` | detached lifecycle, lock, state file, graceful shutdown | 1 |
| `db/` | SQLite WAL, fresh v1 schema, backups, development reset | 1, 7 |
| `server/` | `/v1` API, auth middleware, pairing, SSE, static PWA, OpenAPI | 1–6 |
| `events/` | durable event log and replay | 1 |
| `agent/` | turn loop, prompts, checkpoints, compaction, budgets | 2 |
| `models/` | provider catalog, models.dev metadata, credentials, catalog capabilities | 2, 6.1 |
| `permissions/` | rule engine, approval queue, audit log | 3 |
| `tools/` | filesystem, shell, web search/fetch, journal, undo | 4 |
| `memory/` | USER + NOTES stores, matching, threat scanning, memory tool, frozen snapshots, background review, history/undo, pending writes, session search | 7 (core/tool/review ready; API/UI next) |
| `connectors/` | Gmail, Google Calendar, Google Drive | 8 |
| `mcp/` | guarded MCP host and pinned tool manifests | 9 |
| `scheduler/` | awake-only agent schedules and briefings | 10 |
| `skills/` | skill loading, learning review, curator, ledger | 11 |
| `remote/` | OpenTunnel lifecycle, PROXY v2 bridge, visitor limits | 6 |
| `tui/` | OpenTUI + Solid client | 12 |
| `client/` | generated typed API client | 1 |
| `shared/` | shared API and event types | 1 |
| `test/` | test helpers and fixtures | 1 |

The daemon is the only process with side effects. Clients never hold authoritative state.
