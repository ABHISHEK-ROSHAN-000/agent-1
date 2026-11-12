# Agent-1

**Status:** Phases 5–7 are complete, and Phase 8 is complete — shadow-Git filesystem checkpoints now replace the per-operation journal. The Solid web client/PWA is available locally and over an OpenTunnel HTTPS route, with provider-first model selection, OpenCode-compatible pairing, approvals, review surfaces, and PWA lifecycle banners. The physical phone/mobile-data check passed. Phase 7 delivered the bounded memory system, security scanner, memory tool, frozen prompt snapshots, background review, FTS5 session search, REST/CLI surfaces, and the **What Agent-1 knows** web screen.

Agent-1 is a local, single-user personal assistant daemon for Windows. It will run in the background at sign-in, own sessions, tools, permissions, memory, and the remote tunnel, and serve thin clients: a web app/PWA, a desktop window and tray, and a TUI.

This repository is a clean rebuild. The original Folder Ops prototype has been removed. Folder Ops now exists only as a reference workflow and integration test for the file tools, approval gate, checkpoints, crash recovery, and rollback.

The daemon, agent runtime, approval gate, and core tools are usable from the CLI/API: detached lifecycle, SQLite, durable events/SSE, auth/pairing, provider and model catalogs, streaming turns, turn-state checkpoints, resume, budgets, compaction, permission rules, exact-argument approvals, Agent-1 path policy and approval modes, shadow-Git filesystem checkpoints, shell, web fetch/search, and audit logging. The web client/PWA adds OpenCode-style login, home, new-session, tabs, streaming chat, approvals, review/context, rules, approval policy settings, checkpoint rollback, provider connection, searchable model switching, settings, and system light/dark theme. Phase 6 adds OpenTunnel remote access, exact OpenCode-style `pair`, Secure remote cookies, host/origin checks, PROXY v2 visitor handling, and per-visitor limits. Phase 6.1 replaces the flat model profile system with a provider-first catalog modeled on OpenCode. Phase 7 replaces the development migration chain with a fresh v1 schema that includes memory and FTS5 tables, then adds the bounded memory store, exact matching, atomic mutations, history/undo, pending destructive changes, the memory threat scanner, the memory tool, frozen prompt snapshots, the background memory reviewer, FTS5 session search, REST/CLI surfaces, and the **What Agent-1 knows** web screen. Phase 8C adds active-turn hydration, transactional approval events, typed SSE contracts, the interim turn guard, session rename/delete, unified settings, and real numbered migrations. Phase 8D adds the OpenTUI keyboard-first terminal client with streaming, permission takeover, session tabs, checkpoint review, and reconnect/replay. Phase 8E adds durable steer/queue admission, step-boundary promotion, exact inbox events, and TUI queue controls. Phase 8E.5 adds content-addressed attachment storage, image/PDF prompt media, model modality filtering, image-aware `fs_read`, web/TUI attachments, and an authenticated media route. Phase 8F completes checkpoint/restore fault hardening, real store pruning, command/path attack coverage, attachment abuse tests, reconnect soak, ConPTY paste/Unicode, and the final Phase 8 gate. The desktop wrapper is still ahead.

## What it will do

- Open-ended personal tasks through installed tools, not fixed workflow templates.
- One agent mode: reads and searches run freely; file mutations are checkpoint-first; dangerous shell actions follow Agent-1 approvals; external actions follow trust/spend policy. Memory follows the owner-approved memory default in Phase 7: foreground changes and background additions apply directly; unattended background destructive edits are staged.
- Editable allow/ask/deny rules and Agent-1 approval modes in Settings.
- Provider-first cloud and local models, selected per session.
- Gmail, Google Calendar, and Google Drive connectors under the shared approval policy.
- Guarded MCP support.
- Agent-1 memory and self-learning. Memory uses the owner-approved memory write policy; skill writes remain staged for approval.
- Shadow-Git checkpoints with safe rollback.
- Remote access from the phone PWA through OpenTunnel.

## Requirements

- Windows 10/11 x64, native (no WSL).
- Git for Windows on `PATH` for filesystem checkpoints.
- Bun 1.4.4 or newer for development.
- Node 26.4+ only when evaluating the shipping runtime.

## Commands

```powershell
bun install
bun install --cwd web
bun run check
bun run web:build
bun run test:e2e

bun src/cli/main.ts service start
bun src/cli/main.ts service status
bun src/cli/main.ts auth show
bun src/cli/main.ts session create --title "First session"
bun src/cli/main.ts session list
bun src/cli/main.ts auth login openrouter
bun src/cli/main.ts auth list
bun src/cli/main.ts models
bun src/cli/main.ts run --session <session-id> --model openrouter/thinkingmachines/inkling-2-small:free "Hello"
bun src/cli/main.ts approvals config --mode smart
bun src/cli/main.ts approvals grants
bun src/cli/main.ts tools list
bun src/cli/main.ts rules list
bun src/cli/main.ts approvals list --status pending
bun src/cli/main.ts approvals approve <approval-id>
bun src/cli/main.ts checkpoints list
bun src/cli/main.ts checkpoints diff <checkpoint-id>
bun src/cli/main.ts checkpoints restore <checkpoint-id>
bun src/cli/main.ts audit
bun src/cli/main.ts pair                          # local links; no loopback QR
bun src/cli/main.ts pair --remote                 # enable OpenTunnel and pair remotely
bun src/cli/main.ts pair --remote --yes           # non-interactive remote consent
bun src/cli/main.ts pair --url https://example.test
bun src/cli/main.ts remote on --yes
bun src/cli/main.ts remote status
bun src/cli/main.ts remote off
bun src/cli/main.ts service stop
```

For OpenRouter, connect it once in **Settings → Providers** or run `bun src/cli/main.ts auth login openrouter`. Then use `agent-1 models` and `agent-1 run --model openrouter/thinkingmachines/inkling-2-small:free "Hello"`, or pick a model in the web composer.

Autostart uses a per-user Startup folder launcher (`Agent-1.vbs`); no admin rights are required. Use `service autostart on|off|status`.

## Layout

```text
bin/          CLI launcher
src/cli/      command-line client and service lifecycle commands
src/core/     config, logging, IDs, time, version
src/daemon/   detached lifecycle, state, lock, autostart
src/db/       Effect SQLite, migrations, backups
src/auth/     DPAPI, scrypt, sessions, pairing, rate limits
src/events/   durable event service and SSE feed
src/server/   /v1 API, auth middleware, SSE, OpenAPI
src/client/   typed API client
src/test/     integration helpers
src/agent/    turn loop, streaming, turn-state checkpoints, recovery
src/checkpoints/ shadow-Git filesystem checkpoints, safe restore, pruning
src/models/   provider catalog, models.dev metadata, credentials, catalog capabilities
src/permissions/ rules, approvals, audit
src/tools/    Agent-1 path policy, filesystem, shell, web
src/remote/   OpenTunnel lifecycle, PROXY v2 bridge, visitor limits
src/memory/   USER + NOTES stores and session search (Phase 7)
src/skills/   skills, learning review, curator (Phase 13)
src/connectors/ Gmail, Calendar, Drive (Phase 10)
src/mcp/      guarded MCP host (Phase 11)
src/tui/      OpenTUI client (Phase 8D)
web/          SolidJS web client/PWA (Phase 5)
desktop/      Electron window and tray (Phase 9)
docs/         architecture notes and carry-over lessons
e2e/          Browser and ConPTY tests (Phase 14)
```

## Plan

The full plan is at `C:\Users\ABHISHEK\.opencode\plan\PLAN.md` (v0.5). Evidence: [`P1_RESULTS.md`](P1_RESULTS.md), [`P2_RESULTS.md`](P2_RESULTS.md), [`P3_RESULTS.md`](P3_RESULTS.md), [`P4_RESULTS.md`](P4_RESULTS.md), [`P5_RESULTS.md`](P5_RESULTS.md), [`P5_1_RESULTS.md`](P5_1_RESULTS.md), [`P6_RESULTS.md`](P6_RESULTS.md), [`P6_1_RESULTS.md`](P6_1_RESULTS.md), [`P7_RESULTS.md`](P7_RESULTS.md), [`P8A_RESULTS.md`](P8A_RESULTS.md), [`P8B_RESULTS.md`](P8B_RESULTS.md), [`P8C_RESULTS.md`](P8C_RESULTS.md), [`P8D_RESULTS.md`](P8D_RESULTS.md), [`P8E_RESULTS.md`](P8E_RESULTS.md), [`P8E5_RESULTS.md`](P8E5_RESULTS.md), and [`P8F_RESULTS.md`](P8F_RESULTS.md). The plan covers the product decisions, architecture, permission model, memory and learning design, connectors, MCP guardrails, phases, testing gate, and the installer-last sequence.

## Tests

```text
bun run check
157 pass, 0 fail, 763 expect() calls, 41 files

bun run test:e2e
7 pass, 0 fail, 82 expect() calls, 2 browser suites
```

## Development database reset

The development database migrates forward through numbered migrations with a pre-migration backup. To start over instead, stop the daemon and run:

```text
bun run db:reset -- --yes
```

This deletes the development database, WAL/SHM files, and backups, then initializes the current schema. Sessions, settings, provider/model rows, approvals, approval grants, rules, checkpoint metadata, and the shadow-Git checkpoint store are cleared. Reconnect providers and recreate sessions afterward. Normal daemon startup never wipes an existing database.

Coverage includes Phase 1–4, OpenCode-style web surfaces, static serving/CSP, login and pairing, home/new-session/session flows, streaming chat, checkpoint-first real file moves and checkpoint rollback, context panels, Pierre tree/diff review, mobile layout, system light/dark theme, offline/reconnecting/update banners, PWA manifest/service-worker checks, visual pixel baselines, OpenTunnel remote pairing, PROXY v2 visitor forwarding, per-visitor limits, remote cookie/host checks, provider credentials, models.dev catalog parsing, environment-key detection, default selection, output-limit fitting, provider retry/error diagnostics, anchored model selection, reasoning-effort selection, streaming Markdown, follow-scrolling with jump-to-latest, context-usage ring, default-closed separate wide side panel, expandable tool groups, per-session model switching, bounded memory stores, exact/folded matching, atomic memory batches, memory history/undo, pinned pending destructive changes, hostile-content scanning, the memory tool, approval-free foreground writes, frozen prompt snapshots, the background memory reviewer, FTS5 session search, memory API/CLI flows, and the memory web screen. The 500-file injected crash/resume/checkpoint restore test remains at the tool/checkpoint layer.

## Limits

- The web client/PWA is a visual/interaction port using vendored OpenCode presentation material. It is not a fork of the OpenCode server or client protocol; Agent-1's `/v1` API and approval rules remain authoritative.
- Phase 6.1 supports OpenRouter and OpenAI-compatible custom/local providers. Native Anthropic, Google, Bedrock, Copilot, OAuth provider login, and provider plugin adapters are not included yet. Model IDs and metadata come from a pinned models.dev snapshot; refresh is available from Providers.
- OpenRouter free endpoints have their own rate limits and availability. Connect OpenRouter in Settings → Providers or with `agent-1 auth login openrouter`, then choose a model in the composer or with `agent-1 run --model provider/model`.
- OpenCode-only surfaces such as plugins, terminal, voice, multi-server, worktrees, LSP, sharing, and provider-account management are not included.
- The OpenTUI terminal client is available through `agent-1 tui`. The Electron desktop wrapper remains Phase 9.
- The 500-file crash test is at the tool/checkpoint layer with an injected failure; the browser suite covers a real approval-gated file move and checkpoint restore, but not a browser-driven 500-file batch.
- Filesystem checkpoints require Git for Windows. A project `.git` is never touched; checkpoints live under `%LOCALAPPDATA%\Agent-1\checkpoints`.
- QR camera scanning requires a secure context (`localhost` or HTTPS). The remote QR contains an OpenCode-compatible JSON payload, so it is for the Agent-1 in-app scanner, not a normal phone camera. A physical camera scan remains a manual check.
- Web search requires `AGENT1_SEARCH_URL`; there is no default search provider.
- Shell is non-interactive; SSRF protection uses DNS/redirect checks but Windows per-process egress is a later hardening item.
- The API binds to loopback only. Remote access uses OpenTunnel's hosted service with its default identity/profile and storage, matching OpenCode (owner decision); a dedicated Agent-1 profile/DPAPI identity is intentionally not used. Self-hosted OpenTunnel is required before public launch.
- Remote access is HTTPS-only and the public URL is not authentication. The tunnel terminates at a loopback PROXY v2 bridge; the daemon still requires the shared password or a one-time pairing session, and approvals remain daemon-owned. Per-visitor limits are enforced at the bridge.
- The physical phone approval over mobile data passed, completing the Phase 6 exit check. Automated checks also exercised a real hosted route, remote pairing, Secure cookies, SSE, and a mobile-viewport approval.
- The OpenAPI document is a hand-written contract for the current routes; generated clients/codegen are later.
- Autostart uses the per-user Startup folder because Task Scheduler registration was denied in the non-elevated development environment. The installer can add a Task Scheduler backend.
- Phase 7 is complete: memory core, hostile-content scanner, memory tool, approval-free foreground writes, frozen prompt snapshots, background reviewer, FTS5 session search, REST API, CLI, and the **What Agent-1 knows** screen. Phase 8 is complete: shadow-Git checkpoints, safe rollback, agent-write ledger, the approval policy, API/recovery foundations, the OpenTUI client, durable inbox/queue, attachment/vision support, and 8F hardening. Connectors, MCP, scheduler, the desktop wrapper, and later phases are still ahead. The PWA shell, primary script, fonts, and icons are cached; language/theme chunks are runtime-cached on demand. Offline, reconnecting, asleep, and update-available banners are implemented.
- Model variants, recent-model lists, provider OAuth, and multi-account UI switching are follow-up provider work; CLI credential switching is available.

## License

Agent-1's own license is TBD. Do not distribute this code until a license and dependency-license review are complete. Vendored OpenCode presentation material is MIT-licensed and preserved under `web/src/opencode/LICENSE`; see [`THIRD_PARTY_NOTICES.md`](THIRD_PARTY_NOTICES.md).
