# Agent-1

**Status:** Phase 0 complete — fresh skeleton. Phase 1 (daemon foundations) is next.

Agent-1 is a local, single-user personal assistant daemon for Windows. It will run in the background at sign-in, own sessions, tools, permissions, memory, and the remote tunnel, and serve thin clients: a web app/PWA, a desktop window and tray, and a TUI.

This repository is a clean rebuild. The original Folder Ops prototype has been removed. Folder Ops now exists only as a reference workflow and integration test for the file tools, approval gate, journal, crash recovery, and undo.

**Not usable yet.** Phase 0 is the skeleton; the daemon and UI are not implemented.

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
bun run typecheck
bun test
bun src/cli/main.ts --help
bun src/cli/main.ts --version
```

## Layout

```text
bin/          CLI launcher
src/cli/      command-line client
src/core/     shared primitives, version, paths, config
src/daemon/   daemon lifecycle (Phase 1)
src/agent/    agent runtime and tool loop (Phase 2)
src/permissions/ rules and approvals (Phase 3)
src/tools/    filesystem, shell, web (Phase 4)
src/memory/   USER + NOTES stores and session search (Phase 7)
src/skills/   skills, learning review, curator (Phase 11)
src/connectors/ Gmail, Calendar, Drive (Phase 8)
src/mcp/      guarded MCP host (Phase 9)
src/server/   /v1 API and SSE (Phase 1)
src/tui/      OpenTUI client (Phase 12)
web/          SolidJS PWA (Phase 5)
desktop/      Electron window and tray (Phase 12)
docs/         architecture notes and carry-over lessons
e2e/          Playwright and ConPTY tests (Phase 13)
```

## Plan

The full plan is at `C:\Users\ABHISHEK\.opencode\plan\PLAN.md` (v0.4). It covers the product decisions, architecture, permission model, memory and learning design, connectors, MCP guardrails, phases, testing gate, and the installer-last sequence.

## License

TBD. Do not distribute this code until a license and dependency-license review are complete.
