# Contributing to Agent-1

Thanks for helping improve Agent-1.

## Requirements

- Windows 10 or 11, x64.
- Bun 1.4.4 or newer.
- Git for Windows on `PATH`.

## Setup

```powershell
bun install
bun install --cwd web
bun run web:build
bun run check
```

## Development workflow

1. Create a focused branch.
2. Keep changes small and reviewable.
3. Add or update tests for behavior changes.
4. Run the relevant tests while developing.
5. Run the full gate before opening a pull request:

```powershell
bun run check
bun run test:e2e
```

## Engineering standards

- TypeScript is strict.
- Dependencies are pinned exactly; commit lockfile changes.
- The daemon owns state and side effects. Clients stay thin.
- File mutations must remain checkpoint-first.
- Permission and approval behavior must fail closed.
- Never log passwords, cookies, tokens, prompts, or private file contents.
- Preserve third-party licenses and notices.
- Do not add telemetry, external branding, or undisclosed network calls.

## Commit messages

Use short, descriptive subjects that explain the change. Avoid phase numbers, tool names, or internal task labels.

Examples:

```text
Persist service identity across restarts
Add attachment support to queued prompts
Harden checkpoint restore failure handling
Improve provider retry diagnostics
```

## Pull requests

Include:

- what changed
- why it changed
- tests run
- known limitations or follow-up work

Do not include secrets, local data directories, database files, logs, or private prompts in a pull request.

## Security

Do not report vulnerabilities in a public issue. Follow [SECURITY.md](SECURITY.md).

## License

By contributing, you agree that your contribution is licensed under the repository's MIT License.
