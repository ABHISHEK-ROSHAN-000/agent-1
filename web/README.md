# Agent-1 Web Client

The web client is a thin SolidJS application served by the local daemon. It owns no sessions, permissions, tools, or execution state. Data comes from the daemon API, and approvals go back through the daemon.

## Stack

- SolidJS and Vite
- Tailwind CSS 4
- Solid Router
- TanStack Solid Query
- Kobalte primitives
- `qr-scanner` for camera pairing
- `vite-plugin-pwa` for the manifest and service worker
- `solid-sonner` for notifications
- `marked` and DOMPurify for sanitized assistant Markdown
- `@pierre/trees`, `@pierre/diffs`, and `@pierre/highlights` for file and diff review
- A vendored UI foundation retained under `src/ui-foundation/`

Dependencies are pinned exactly in `package.json` and `bun.lock`.

Third-party licensing is documented in `../THIRD_PARTY_NOTICES.md`. The vendored UI foundation retains its upstream MIT license and notices under `src/ui-foundation/`.

## Run

From the repository root:

```powershell
bun install
bun install --cwd web
bun run web:build
bun src/cli/main.ts service start
```

Open the URL printed by `service start`, or run `bun src/cli/main.ts pair` for a one-time pairing link. Use `bun src/cli/main.ts pair --remote` to expose the HTTPS tunnel URL and print the remote QR payload.

Connect a model provider in **Settings → Providers**. OpenRouter stores the key through the provider form. Choose an enabled model from the composer model picker; model changes apply to the current session.

## Development

Start the daemon on the port expected by the Vite proxy:

```powershell
$env:AGENT1_PORT = "49499"
bun src/cli/main.ts service start
```

Start Vite in another shell:

```powershell
bun run web:dev
```

The Vite server proxies `/v1`, `/pair`, and `/auth/connect` to `AGENT1_DEV_SERVER_URL`, which defaults to `http://127.0.0.1:49499`.

QR camera scanning requires a secure context (`localhost` or HTTPS).

## Pairing flow

1. Run `agent-1 pair` locally, or `agent-1 pair --remote` for remote access.
2. Open the printed pairing link on the target device.
3. The browser receives a 30-day session cookie and redirects to the app.
4. Existing sessions survive daemon restarts while the local service port and browser cookie remain unchanged.

For remote access, open the public HTTPS URL first. The terminal QR payload is intended for the in-app scanner, not a normal camera app.

## Surfaces

- Pairing link, QR scan, and password login.
- Providers and model catalog.
- Home session list and new-session composer.
- Session tabs and streaming chat.
- Approval inbox and inline approval cards.
- Context and token usage panels.
- Checkpoint diff and restore screens.
- Rules, approval policy, providers, models, and settings.
- System light and dark themes.
- Installable PWA with network-only API access.
- Offline, reconnecting, asleep, and update-available states.

The daemon remains authoritative for all state and side effects.
