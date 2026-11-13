# Engineering notes

These notes capture implementation lessons that shaped Agent-1.

## 1. OpenTUI preload

Bun resolves Solid to its server build unless the TUI launcher injects the OpenTUI preload:

```text
bun --preload @opentui/solid/preload src/tui/main.tsx
```

Without it, components render statically and lifecycle effects do not run as expected. The launcher handles this; users should not need to remember the flag.

## 2. Electron pin

Electron `40.10.2` is pinned until newer binary downloads are reliable in the build environment. The tray APIs used here are stable.

## 3. DPAPI

Windows DPAPI protects the shared password, model API keys, and connector secrets. Encrypted blobs live under the per-user data directory.

## 4. Tunnel behavior

The remote tunnel route is persisted so the public URL survives service restarts. A public URL is never authentication.

The hosted tunnel service does not expose a clean release call through its SDK. Deleting the local identity can leave the route reserved. A dedicated self-hosted tunnel is required before public launch.

## 5. PROXY v2

Tunnelled requests arrive from loopback. The visitor address is available through the PROXY protocol. A loopback PROXY v2 bridge strips spoofed visitor headers and enforces per-visitor limits.

The daemon still authorizes every request independently.

## 6. Crash-test design

The checkpoint acceptance test creates 500 files, interrupts a batch halfway through, restarts against the same database, resumes, and verifies that every file is restored without duplicate work.

## 7. SSE replay

A durable event log with a monotonic sequence and `Last-Event-ID` replay is retained. Events are a UI feed and replay log; approvals and checkpoint metadata remain in their own tables.

## 8. Filesystem checkpoints

One tree snapshot is taken per checkpoint root per turn. An agent-write SHA-256 ledger preserves user edits during safe restore. A pre-rollback snapshot makes rollback itself reversible.

Checkpoint commits are the source of file state for recovery; audit events are not.

## 9. Authentication

- scrypt shared password
- one-time pairing links with a five-minute lifetime
- 30-day sessions
- password rotation revokes sessions
- Basic authentication with a fixed local username
- DPAPI at rest

## 10. Testing

- Browser integration tests through installed Edge or Chrome with `playwright-core`.
- Terminal integration tests through a Windows ConPTY.
- Real daemon processes with isolated data directories.
- Fixture cleanup in `finally` and `afterAll`.
