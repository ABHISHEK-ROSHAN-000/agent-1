# Agent-1

**Status:** Phase 2 complete — agent runtime. Phase 3 (permissions and approvals) is next.

Agent-1 is a local, single-user personal assistant daemon for Windows. It will run in the background at sign-in, own sessions, tools, permissions, memory, and the remote tunnel, and serve thin clients: a web app/PWA, a desktop window and tray, and a TUI.

This repository is a clean rebuild. The original Folder Ops prototype has been removed. Folder Ops now exists only as a reference workflow and integration test for the file tools, approval gate, journal, crash recovery, and undo.

The daemon and agent runtime are usable from the CLI: detached lifecycle, SQLite, durable events/SSE, auth/pairing, cloud/local model profiles, streaming chat turns, read-only test tools, checkpoints, resume, budgets, and compaction. There are no write tools, approvals, or web/TUI UI yet.

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
bun run check

bun src/cli/main.ts service start
bun src/cli/main.ts service status
bun src/cli/main.ts auth show
bun src/cli/main.ts session create --title "First session"
bun src/cli/main.ts session list
bun src/cli/main.ts model add --name local --kind local --base-url http://127.0.0.1:11434/v1 --model llama3.2
bun src/cli/main.ts model test <profile-id>
bun src/cli/main.ts chat --session <session-id> --message "Hello"
bun src/cli/main.ts pair
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
src/agent/    turn loop, streaming, checkpoints, recovery, test tools
src/models/   cloud/local model profiles, capability probe, DPAPI keys
src/permissions/ rules and approvals (Phase 3)
src/tools/    filesystem, shell, web (Phase 4)
src/memory/   USER + NOTES stores and session search (Phase 7)
src/skills/   skills, learning review, curator (Phase 11)
src/connectors/ Gmail, Calendar, Drive (Phase 8)
src/mcp/      guarded MCP host (Phase 9)
src/tui/      OpenTUI client (Phase 12)
web/          SolidJS PWA (Phase 5)
desktop/      Electron window and tray (Phase 12)
docs/         architecture notes and carry-over lessons
e2e/          Playwright and ConPTY tests (Phase 13)
```

## Plan

The full plan is at `C:\Users\ABHISHEK\.opencode\plan\PLAN.md` (v0.4). Evidence: [`P1_RESULTS.md`](P1_RESULTS.md) and [`P2_RESULTS.md`](P2_RESULTS.md). The plan covers the product decisions, architecture, permission model, memory and learning design, connectors, MCP guardrails, phases, testing gate, and the installer-last sequence.

## Tests

```text
bun run check
43 pass, 0 fail, 230 expect() calls, 19 files
```

Coverage includes Phase 1 foundations plus model profiles and DPAPI keys, fake OpenAI-compatible cloud/local probing, streaming turns, tool loops, cancellation, budgets, checkpoints, forced-kill resume, compaction, CLI model/chat, and API-key/log redaction.

## Limits

- Phase 2 tools are read-only test tools only. No write tools or approvals yet.
- The API binds to loopback only. Remote access is Phase 6.
- The OpenAPI document is a hand-written contract for the current routes; generated clients/codegen are later.
- Autostart uses the per-user Startup folder because Task Scheduler registration was denied in the non-elevated development environment. The installer can add a Task Scheduler backend.
- No approvals, real tools, memory, connectors, MCP, scheduler, or web/TUI UI yet.

## License

TBD. Do not distribute this code until a license and dependency-license review are complete.
