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

This is the model for journal correctness.

## 7. SSE replay

A durable event log with a monotonic `seq` and `Last-Event-ID` replay worked. It is worth keeping. Events are a UI feed and replay log; approvals and journal state remain in their own tables.

## 8. Journal shape

`planned → applying → done | failed | unknown`, with source hashes, before/after data, and undo data. Reconcile against disk on restart. This is the core safety mechanism.

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
