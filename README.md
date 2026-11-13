# Agent-1

Agent-1 is a local, single-user personal assistant for Windows. It runs as a background service and owns sessions, tools, permissions, checkpoints, memory, and remote access. A terminal UI, browser client, and PWA connect to the same daemon.

Agent-1 is intentionally local-first. Reads and searches run freely, file changes are checkpointed before mutation, and dangerous shell or external actions follow explicit approval rules.

## Status

The core platform is available as a Windows alpha package: daemon lifecycle, SQLite storage, event streaming, authentication and pairing, model providers, permissions and approvals, shadow-Git checkpoints, filesystem and shell tools, memory, session search, a terminal UI, and a browser client/PWA.

The alpha build is not code-signed yet. Windows SmartScreen may warn on first install.

## Features

- Detached background daemon with a single local service identity.
- Session-based agent runtime with streaming output and resumable turns.
- Provider-first model selection for cloud and local OpenAI-compatible APIs.
- Explicit allow, ask, and deny rules with approval modes.
- Exact-argument approvals that expire closed.
- Shadow-Git filesystem checkpoints and safe rollback.
- Filesystem, shell, web fetch, and web search tools.
- Persistent user and agent memory with prompt-injection scanning.
- Full-text session search.
- Terminal UI built for keyboard use.
- Responsive browser client and installable PWA.
- One-time pairing links and remote access through an HTTPS tunnel.
- Content-addressed attachment storage with image and PDF support.

## Install on Windows

```powershell
irm https://github.com/ABHISHEK-ROSHAN-000/agent-1/releases/latest/download/install.ps1 | iex
agent-1 onboard
```

Then:

```powershell
agent-1
agent-1 pair
agent-1 service autostart on
agent-1 update --check
```

The installer is per-user and does not require administrator rights. It installs under `%LOCALAPPDATA%\Programs\Agent-1`.

## Requirements

- Windows 10 or 11, x64.
- [Bun](https://bun.sh/) 1.4.4 or newer for development.
- Git for Windows on `PATH` for filesystem checkpoints.

## Run from source

```powershell
bun install
bun install --cwd web
bun run web:build

bun src/cli/main.ts
```

Running `agent-1` without a command opens the terminal UI in an interactive terminal.

Start the daemon explicitly:

```powershell
bun src/cli/main.ts service start
bun src/cli/main.ts service status
```

Open the browser client:

```text
http://127.0.0.1:28895
```

Create a one-time pairing link:

```powershell
bun src/cli/main.ts pair
```

Connect a model provider:

```powershell
bun src/cli/main.ts auth login openrouter
```

Show the shared local password:

```powershell
bun src/cli/main.ts auth show
```

Enable the daemon at user sign-in:

```powershell
bun src/cli/main.ts service autostart on
```

Stop the daemon:

```powershell
bun src/cli/main.ts service stop
```

## Tests

```text
bun run check
268 pass, 0 fail, 1373 expect() calls, 58 files

bun run test:e2e
7 pass, 0 fail, 77 expect() calls, 2 suites
```

## Development

```powershell
bun run typecheck
bun run web:typecheck
bun run tui:typecheck
bun run check
bun run test:e2e
```

Dependencies are pinned exactly and both lockfiles are committed.

Reset the development database only when you intend to discard local state:

```powershell
bun run db:reset -- --yes
```

Normal daemon startup never wipes an existing database.

## Architecture

```text
src/cli/          Command-line client and service lifecycle
src/daemon/       Detached service, state, lock, autostart
src/core/         Configuration, paths, logging, IDs, versioning
src/db/           SQLite, migrations, backups
src/auth/         DPAPI secrets, password hashing, sessions, pairing
src/events/       Durable event log and SSE replay
src/server/       HTTP API, authentication, static client, OpenAPI
src/agent/        Turn loop, streaming, recovery, budgets
src/sessions/     Inbox, steering, and queueing
src/attachments/  Content-addressed attachment storage
src/checkpoints/  Shadow-Git checkpoints and restore
src/permissions/  Rules, approvals, audit
src/tools/        Filesystem, shell, web
src/memory/       Memory stores and session search
src/remote/       HTTPS tunnel and visitor proxy
src/tui/          Terminal client
src/client/       Typed API client
web/              Browser client and PWA
desktop/          Desktop shell
docs/             Architecture and engineering notes
e2e/              Browser and terminal integration tests
```

The daemon is the only process with side effects. Clients render state and send commands; they do not own execution state.

## Security

- The API binds to loopback by default.
- Authentication uses a local password, DPAPI-encrypted secrets, and one-time pairing links.
- Remote access is HTTPS-only and never treats the public URL as authentication.
- Approval timeouts fail closed.
- Logs redact passwords, cookies, tokens, prompts, and private file content.

Report vulnerabilities through GitHub Security Advisories. Do not open a public issue containing secrets or private data.

## Limitations

- Windows x64 only for now.
- The packaged installer, updater, and desktop shell are still in progress.
- Native Anthropic, Google, Bedrock, Copilot, and OAuth provider adapters are not included.
- Web search requires `AGENT1_SEARCH_URL`.
- Filesystem checkpoints require Git for Windows.
- Remote access currently depends on a hosted tunnel service and must be self-hosted before a public launch.
- The OpenAPI document is maintained by hand.

## License

Agent-1 is released under the MIT License. See [LICENSE](LICENSE).

Third-party components and required notices are listed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md). The vendored UI foundation retains its upstream MIT license and notices under `web/src/ui-foundation/`.
