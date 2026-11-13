# Source map

Agent-1 is a local client-server application. The daemon owns durable state and execution; the terminal, browser, and desktop clients are thin.

| Directory | Responsibility |
|---|---|
| `core/` | Configuration, paths, IDs, time, version, logging |
| `cli/` | Command-line client and service lifecycle |
| `daemon/` | Detached lifecycle, lock, state file, graceful shutdown, autostart |
| `db/` | SQLite WAL, migrations, backups, development reset |
| `server/` | `/v1` API, authentication, pairing, SSE, static client, OpenAPI |
| `events/` | Durable event log and replay |
| `agent/` | Turn loop, prompts, turn-state checkpoints, compaction, budgets |
| `sessions/inbox/` | Pending steer and queue delivery |
| `attachments/` | Content-addressed blobs, MIME handling, image normalization, model media |
| `checkpoints/` | Shadow-Git filesystem checkpoints, safe restore, pruning |
| `models/` | Provider catalog, models.dev metadata, credentials |
| `permissions/` | Rules, approval queue, audit log |
| `tools/` | Filesystem, shell, web search, and web fetch |
| `memory/` | Persistent memory, threat scanning, review, history, session search |
| `remote/` | HTTPS tunnel lifecycle and visitor proxy |
| `tui/` | Terminal client, launcher, recovery, screens, attachments |
| `hardening/` | Security attack corpus and regression coverage |
| `client/` | Typed API client |
| `shared/` | Shared API and event contracts |
| `test/` | Test helpers and fixtures |

The daemon is the only process with side effects. Clients never hold authoritative state.
