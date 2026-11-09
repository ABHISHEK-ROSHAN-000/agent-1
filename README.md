# Agent-1

**Status:** Phase 5 complete — the Solid web client/PWA is available from the local daemon.

Agent-1 is a local, single-user personal assistant daemon for Windows. It will run in the background at sign-in, own sessions, tools, permissions, memory, and the remote tunnel, and serve thin clients: a web app/PWA, a desktop window and tray, and a TUI.

This repository is a clean rebuild. The original Folder Ops prototype has been removed. Folder Ops now exists only as a reference workflow and integration test for the file tools, approval gate, journal, crash recovery, and undo.

The daemon, agent runtime, approval gate, and core tools are usable from the CLI/API: detached lifecycle, SQLite, durable events/SSE, auth/pairing, cloud/local model profiles, streaming turns, checkpoints, resume, budgets, compaction, permission rules, exact-argument approvals, workspace grants, filesystem tools with journal/undo, shell, web fetch/search, and audit logging. The web client/PWA adds login, QR pairing, streaming chat, approvals, rules, workspaces, journal/undo, files, models, settings, and system light/dark theme. The TUI and desktop wrapper are still ahead.

## What it will do

- Open-ended personal tasks through installed tools, not fixed workflow templates.
- One mode: reads and searches run freely; writes, shell commands, external actions, memory writes, skill writes, connector calls, and MCP tool calls ask first.
- Editable allow/ask/deny rules in Settings.
- Cloud and local model profiles, selected per session.
- Gmail, Google Calendar, and Google Drive connectors with per-action approval.
- Guarded MCP support.
- Hermes-style memory and self-learning, with every write staged for approval.
- Journaled side effects with undo.
- Remote access from the phone PWA through OpenTunnel.

## Requirements

- Windows 10/11 x64, native (no WSL).
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
bun src/cli/main.ts model add --name local --kind local --base-url http://127.0.0.1:11434/v1 --model llama3.2
bun src/cli/main.ts model test <profile-id>
bun src/cli/main.ts chat --session <session-id> --message "Hello"
bun src/cli/main.ts workspace add C:\Users\me\Documents --access write
bun src/cli/main.ts tools list
bun src/cli/main.ts rules list
bun src/cli/main.ts approvals list --status pending
bun src/cli/main.ts approvals approve <approval-id>
bun src/cli/main.ts journal list
bun src/cli/main.ts journal undo <batch-id>
bun src/cli/main.ts audit
bun src/cli/main.ts pair         # prints a link and QR code
bun src/cli/main.ts service stop
```

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
src/agent/    turn loop, streaming, checkpoints, recovery
src/models/   cloud/local model profiles, capability probe, DPAPI keys
src/permissions/ rules, approvals, audit
src/tools/    workspaces, filesystem, journal/undo, shell, web
src/memory/   USER + NOTES stores and session search (Phase 7)
src/skills/   skills, learning review, curator (Phase 11)
src/connectors/ Gmail, Calendar, Drive (Phase 8)
src/mcp/      guarded MCP host (Phase 9)
src/tui/      OpenTUI client (Phase 12)
web/          SolidJS web client/PWA (Phase 5)
desktop/      Electron window and tray (Phase 12)
docs/         architecture notes and carry-over lessons
e2e/          Browser and ConPTY tests (Phase 13)
```

## Plan

The full plan is at `C:\Users\ABHISHEK\.opencode\plan\PLAN.md` (v0.4). Evidence: [`P1_RESULTS.md`](P1_RESULTS.md), [`P2_RESULTS.md`](P2_RESULTS.md), [`P3_RESULTS.md`](P3_RESULTS.md), [`P4_RESULTS.md`](P4_RESULTS.md), and [`P5_RESULTS.md`](P5_RESULTS.md). The plan covers the product decisions, architecture, permission model, memory and learning design, connectors, MCP guardrails, phases, testing gate, and the installer-last sequence.

## Tests

```text
bun run check
66 pass, 0 fail, 370 expect() calls, 27 files

bun run test:e2e
4 pass, 0 fail, 7 expect() calls, 1 browser suite
```

Coverage includes Phase 1–4 plus web static serving/CSP, login and pairing, streaming chat, approval-gated real file moves and journal undo, files/context panels, mobile layout, system light/dark theme, PWA manifest/service-worker checks, and CLI QR pairing. The 500-file injected crash/resume/undo test remains at the tool/journal layer.

## Limits

- The web client/PWA is Phase 5. The TUI and Electron desktop wrapper are later.
- The 500-file crash test is at the tool/journal layer with an injected failure; the browser suite covers a real approval-gated file move and undo, but not a browser-driven 500-file batch.
- QR camera scanning requires a secure context (`localhost` or HTTPS). The browser suite checks the QR entry point and CLI QR output but cannot emulate a real camera QR scan.
- Web search requires `AGENT1_SEARCH_URL`; there is no default search provider.
- Shell is non-interactive; SSRF protection uses DNS/redirect checks but Windows per-process egress is a later hardening item.
- The API binds to loopback only. Remote access is Phase 6.
- The OpenAPI document is a hand-written contract for the current routes; generated clients/codegen are later.
- Autostart uses the per-user Startup folder because Task Scheduler registration was denied in the non-elevated development environment. The installer can add a Task Scheduler backend.
- No memory, connectors, MCP, scheduler, TUI, or desktop wrapper yet. The PWA shell is cached; full offline mode and update-required/asleep banners are later.

## License

TBD. Do not distribute this code until a license and dependency-license review are complete.
