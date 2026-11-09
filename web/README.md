# Agent-1 Web Client / PWA

The web client is a thin SolidJS app served by the local daemon. It owns no
sessions, permissions, tools, or execution state; all state comes from the
daemon API and all approvals go back through the daemon.

## Stack

- SolidJS + Vite + `vite-plugin-solid`
- Tailwind CSS 4 via `@tailwindcss/vite`
- `@solidjs/router`
- TanStack Solid Query
- Kobalte (available for accessible primitives; the current shell uses native
  controls where that is simpler)
- `qr-scanner` for camera pairing
- `vite-plugin-pwa` for the manifest and service worker
- `solid-sonner` for transient notifications
- `marked` + DOMPurify for sanitized assistant Markdown

All dependencies are exact-pinned in `web/package.json` and `web/bun.lock`.
The UI uses original Agent-1 branding and icons; no OpenCode assets, source, or
wordmark are copied.

## Run

From the repository root:

```powershell
bun install
bun install --cwd web
bun run web:build
bun src/cli/main.ts service start
```

Open the URL printed by `service start`, or run `bun src/cli/main.ts pair` for a
one-time pairing link and terminal QR code.

For development:

```powershell
# Start the daemon on the port the Vite proxy expects.
$env:AGENT1_PORT = "49499"
bun src/cli/main.ts service start

# In another shell.
bun run web:dev
```

The Vite dev server proxies `/v1` and `/pair` to
`AGENT1_DEV_SERVER_URL` (default `http://127.0.0.1:49499`). QR camera scanning
requires a secure context (`localhost` or HTTPS).

## Surfaces

- Login by pairing link, QR scan, or shared password.
- Session list, new session, streaming chat, stop, model selection.
- Approval inbox and inline approval cards with exact arguments.
- Review panel: pending approvals, journal batches, and undo.
- Context panel: model, token, turn, cost, and context-window stats.
- Files panel: read-only workspace tree and text preview.
- Rules, workspaces, journal, model profiles, and settings.
- System light/dark theme with a manual override.
- Installable PWA with a network-only API policy.

## Checks

```powershell
bun run web:typecheck
bun run web:build
bun run test:e2e     # builds web/dist and runs Playwright against a real daemon
```

The browser suite uses the installed Edge or Chrome executable. It covers
password login, a one-time pairing link, streaming chat, an approval-gated real
file move, journal undo, files/context panels, the mobile shell, system light
theme, and PWA manifest/service-worker availability.
