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
- `@pierre/trees`, `@pierre/diffs`, and `@pierre/highlights` for the OpenCode-style
  file tree and code/diff review surfaces
- Vendored OpenCode presentation tokens, CSS, and icon renderer at pinned commit
  `30e7a4d573cb8f83d186cef682569cb5758ad8f3`

All dependencies are exact-pinned in `web/package.json` and `web/bun.lock`.
OpenCode material is MIT-licensed and retained under `src/opencode/LICENSE`;
see `../THIRD_PARTY_NOTICES.md`. The Agent-1 wordmark, product name, data layer,
auth, and approval behavior are original Agent-1 work. OpenCode branding,
telemetry, and server/client protocol are not used.

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

To verify pairing manually:

1. Run `bun src/cli/main.ts pair` and leave the terminal QR visible.
2. Open `/login` from `localhost` or an HTTPS remote URL.
3. Choose **Scan QR code** and point the camera at the terminal QR.
4. If no camera is available, use **Upload a QR image instead** with a screenshot
   of the terminal QR. Both paths redeem the same one-time pairing link.

## Surfaces

- OpenCode-style connect screen: pairing link, QR scan, password fallback.
- Titlebar tabs, home workspace/session list, and new-session wordmark/composer.
- Streaming chat with stop, models, approvals, and auto-scroll.
- Approval inbox and inline approval cards with exact arguments.
- Review panel: pending approvals, journal batches, and undo.
- Context panel: model, token, turn, cost, and context-window stats.
- Files panel: `@pierre/trees` workspace tree and `@pierre/diffs` file viewer.
- Review panel: `@pierre/diffs` file/diff previews for journaled changes.
- Rules, workspaces, journal, model profiles, and settings.
- System light/dark theme with a manual override.
- Offline, reconnecting, asleep, and update-available status banners.
- Installable PWA with a network-only API policy and prompt-based updates.
- Visual regression screenshots for login, home, new session, session, files,
  review diff, settings, offline state, and mobile/light layouts.

The visual port deliberately does not include OpenCode's multi-server UI,
plugins, terminal, voice, worktrees, LSP, sharing, provider accounts, or its
client/server protocol. Those features have no Agent-1 backend yet.

## Checks

```powershell
bun run web:typecheck
bun run web:build
bun run test:e2e     # builds web/dist and runs Playwright against a real daemon
bun test e2e/visual.test.ts
```

The visual suite compares against `e2e/visual-baseline/`. Regenerate baselines
only after an intentional visual change:

```powershell
$env:UPDATE_VISUAL_BASELINES = "1"
bun test e2e/visual.test.ts
Remove-Item Env:UPDATE_VISUAL_BASELINES
```

The browser suite uses the installed Edge or Chrome executable. It covers
password login, a one-time pairing link, home/new-session/session flows,
streaming chat, an approval-gated real file move, journal undo, files/context
panels, the mobile shell, system light/dark theme, and PWA manifest/service-worker
availability.
