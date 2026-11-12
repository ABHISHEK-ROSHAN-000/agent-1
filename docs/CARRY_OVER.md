# Carry-over lessons from the retired prototype

The old Agent-1 prototype was removed on 2026-11-09. No code was retained. These tested lessons inform the rebuild.

## 1. OpenTUI needs a preload

Bun resolves `solid-js` to its server build for OpenTUI unless the launcher injects:

```text
bun --preload @opentui/solid/preload src/tui/main.tsx
```

Without it, components render statically and `onMount`/effects do not run as expected. The TUI launcher must handle this; users should not have to remember it.

## 2. Electron pin

Electron 40.10.2 was the only version whose binary downloaded reliably in this environment. Electron 44.9.1 failed with a TLS termination error during download. The tray APIs used are stable. Revisit in the installer phase.

## 3. DPAPI

Windows DPAPI works for the shared password, model API keys, and connector secrets. Store encrypted blobs under the per-user data directory. OpenTunnel's own default identity storage is used instead of wrapping it in DPAPI, because Phase 6 explicitly matches OpenCode's default profile behavior.

## 4. OpenTunnel route behavior

A real route and pairing link were confirmed, then disabled. The hosted service did not expose a clean release call through the SDK; deleting the local identity leaves the route reserved on the server. Self-host before public launch. A public URL is not authentication.

## 5. PROXY v2

Tunnelled requests arrive from loopback. The visitor address is available only through the PROXY protocol. Phase 6 runs a loopback PROXY v2 HTTP bridge, strips spoofed visitor headers, and enforces per-visitor limits at that bridge. The daemon still authorizes every request independently; public host/URL is never authentication.

## 6. Crash test design

The file-tool acceptance test:

1. Create 500 files.
2. Kill the daemon after the 250th rename.
3. Restart against the same database.
4. Resume through the UI.
5. Undo.
6. Verify all 500 files are restored and no duplicate moves exist.

This is the model for checkpoint crash/resume correctness.

## 7. SSE replay

A durable event log with a monotonic `seq` and `Last-Event-ID` replay worked. It is worth keeping. Events are a UI feed and replay log; approvals and checkpoint metadata remain in their own tables.

## 8. Filesystem checkpoint shape

Phase 8A replaces the operation journal with shadow-Git checkpoints: one tree snapshot per checkpoint root per turn, an agent-write SHA-256 ledger, safe restore, pre-rollback snapshots, and pruning. The checkpoint commit is the file-state source for recovery; the audit event is not. Phase 8B removes workspace grants in favor of Agent-1 path policy, marker-based checkpoint roots, checkpoint-first writes, and smart/manual/off shell approvals. Phase 8C adds active-turn hydration, transactional approval events, typed SSE/recovery contracts, session rename/delete, unified settings, and numbered migrations. Phase 8D adds the OpenTUI client with preload launcher, prompt-centric Home, session tabs, permission takeover, checkpoint review, and ConPTY coverage. Phase 8E adds the pending-only inbox, durable steer/queue admission, step-boundary promotion, exact inbox events, and TUI queue controls. Phase 8E.5 adds content-addressed blobs, image/PDF prompt media, model modality filtering, media-aware fs_read, TUI/web attachments, and a referenced media route. Phase 8F adds checkpoint/restore fault hardening, real store pruning, command/path attack coverage, attachment abuse coverage, reconnect soak, and ConPTY Unicode/paste coverage.

The checkpoint commit is the source of file state; the agent-write ledger preserves user edits during safe restore.

## 9. Auth model

- scrypt shared password
- one-time pairing link, 5-minute TTL
- 30-day session cookie
- rotation signs out every session
- Basic auth with fixed username
- DPAPI at rest

## 10. Testing pattern

- Browser e2e through installed Edge/Chrome with `playwright-core`.
- TUI e2e through a Windows ConPTY with `@lydell/node-pty`.
- Real daemon processes with isolated data directories.
- Fixture cleanup in `finally`/`afterAll`.

## Removed artifacts

The old code, web app, Electron shell, spikes, docs, tests, database, backups, DPAPI secrets, and logs were deleted. The hosted OpenTunnel route remains reserved on the provider until it expires or is released by their side.
