# Source map

Phase 1 and Phase 2 modules are implemented. Later-phase directories are planned only.

| Directory | Responsibility | Phase |
|---|---|---|
| `core/` | version, paths, config, IDs, JSON, logging | 0–1 |
| `cli/` | command-line client | 0 |
| `daemon/` | detached lifecycle, lock, state file, graceful shutdown | 1 |
| `db/` | SQLite WAL, migrations, backups | 1 |
| `server/` | `/v1` API, auth middleware, SSE, static PWA, OpenAPI | 1 |
| `events/` | durable event log and replay | 1 |
| `agent/` | turn loop, prompts, checkpoints, compaction, budgets | 2 |
| `models/` | cloud and local provider profiles, capability probe | 2 |
| `permissions/` | rule engine, approval queue, audit log | 3 |
| `tools/` | filesystem, shell, web search/fetch, journal, undo | 4 |
| `memory/` | USER + NOTES stores, pending writes, session search | 7 |
| `connectors/` | Gmail, Google Calendar, Google Drive | 8 |
| `mcp/` | guarded MCP host and pinned tool manifests | 9 |
| `scheduler/` | awake-only agent schedules and briefings | 10 |
| `skills/` | skill loading, learning review, curator, ledger | 11 |
| `remote/` | OpenTunnel lifecycle and PROXY ingress | 6 |
| `tui/` | OpenTUI + Solid client | 12 |
| `client/` | generated typed API client | 1 |
| `shared/` | shared API and event types | 1 |
| `test/` | test helpers and fixtures | 1 |

The daemon is the only process with side effects. Clients never hold authoritative state.
