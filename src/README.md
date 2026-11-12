# Source map

Phase 1 through Phase 8F modules are implemented. Phase 7 adds the fresh v1 schema, memory tables/FTS5, bounded memory store, exact matching, atomic mutations, history/undo, pending destructive changes, the hostile-content scanner, the memory tool, frozen prompt snapshots, the background memory reviewer, FTS5 session search, API/CLI surfaces, and the memory web screen. Phase 8A replaces the filesystem journal with shadow-Git checkpoints, safe rollback, and an agent-write ledger. Phase 8B adds path policy and approval modes. Phase 8C adds active-turn hydration, approval events, typed SSE/recovery contracts, session mutation, unified settings, and numbered migrations. Phase 8D adds the OpenTUI client, launcher, data/recovery layer, keyboard-first screens, permission takeover, checkpoint review, and frame/ConPTY tests. Phase 8E adds the pending-only inbox, steer/queue promotion, durable inbox events, and TUI queue controls. Phase 8E.5 adds blob-backed attachments, image/PDF vision, model modality filtering, media-read tools, and web/TUI attachment input. Phase 8F adds checkpoint/restore fault hardening, real store pruning, command/path attack coverage, attachment abuse tests, reconnect soak, and ConPTY paste/Unicode coverage.

| Directory | Responsibility | Phase |
|---|---|---|
| `core/` | version, paths, config, IDs, JSON, logging | 0–1 |
| `cli/` | command-line client | 0 |
| `daemon/` | detached lifecycle, lock, state file, graceful shutdown | 1 |
| `db/` | SQLite WAL, migrations, checkpoints metadata, backups, development reset | 1, 7, 8A, 8C |
| `server/` | `/v1` API, auth middleware, pairing, SSE, static PWA, OpenAPI | 1-8C |
| `events/` | durable event log and replay | 1 |
| `agent/` | turn loop, prompts, turn-state checkpoints, compaction, budgets | 2 |
| `sessions/inbox/` | pending-only steer/queue inbox, ordering, promotion | 8E |
| `attachments/` | content-addressed blobs, MIME/image normalization, model media | 8E.5 |
| `checkpoints/` | shadow-Git filesystem checkpoints, safe restore, prune | 8A-8C |
| `models/` | provider catalog, models.dev metadata, credentials, catalog capabilities | 2, 6.1 |
| `permissions/` | rule engine, approval queue, audit log | 3 |
| `tools/` | filesystem, shell, web search/fetch | 4 |
| `memory/` | USER + NOTES stores, matching, threat scanning, memory tool, frozen snapshots, background review, history/undo, pending writes, FTS5 session search | 7 |
| `connectors/` | Gmail, Google Calendar, Google Drive | 10 |
| `mcp/` | guarded MCP host and pinned tool manifests | 11 |
| `scheduler/` | awake-only agent schedules and briefings | 12 |
| `skills/` | skill loading, learning review, curator, ledger | 13 |
| `remote/` | OpenTunnel lifecycle, PROXY v2 bridge, visitor limits | 6 |
| `tui/` | OpenTUI client, launcher, recovery, screens, queue, attachments | 8C-8E.5 |
| `hardening/` | attack corpus and Phase 8F gates | 8F |
| `client/` | generated typed API client | 1 |
| `shared/` | shared API and event types | 1 |
| `test/` | test helpers and fixtures | 1 |

The daemon is the only process with side effects. Clients never hold authoritative state.
