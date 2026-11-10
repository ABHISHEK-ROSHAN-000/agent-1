# Third-Party Notices

## OpenCode

Portions of the Agent-1 web client are vendored from the OpenCode repository:

- Source: https://github.com/anomalyco/opencode
- Commit: `30e7a4d573cb8f83d186cef682569cb5758ad8f3`
- License: MIT
- Copyright: Copyright (c) 2025 opencode

The full MIT license is preserved at `web/src/opencode/LICENSE`.

Vendored areas include design tokens, base styles, app surface CSS, icon catalog
data, and presentation patterns from `packages/ui`, `packages/session-ui`, and
`packages/app`, plus the terminal QR encoder in `src/cli/qr.ts` from
`packages/util/src/qr.ts`. Agent-1 adds its own data layer, routes,
authentication, permission behavior, wordmark, and product names. OpenCode
branding, logos, and telemetry are not used.

The QR encoder follows Project Nayuki's MIT-licensed QR Code generator.

## models.dev

`src/models/catalog/models-dev.json` is a pinned snapshot of provider and model
metadata from https://models.dev, licensed MIT. See
`src/models/catalog/README.md`.

## OpenTunnel

Remote access uses `@opentunnel/client` `0.6.2` from
https://github.com/anomalyco/opentunnel, licensed MIT. Agent-1 uses
OpenTunnel's standard/default profile and storage exactly as OpenCode does.

## Pierre

The file tree and code/diff viewer use these Apache-2.0 packages:

- `@pierre/trees` `1.0.0-beta.6`
- `@pierre/diffs` `1.6.1`
- `@pierre/highlights` `0.2.0`

Their license texts are preserved at `web/src/opencode/PIERRE-*-LICENSE.md`.
`@pierre/trees` also includes MIT-licensed ideas/code derived from
`@headless-tree/core`; see the upstream NOTICE for attribution.

## Fonts

The web client bundles or references fonts under the SIL Open Font License 1.1:

- Inter
- IBM Plex Mono
- JetBrains Mono Nerd Font Mono

The OFL text is preserved at `web/src/opencode/OFL-1.1.txt`.

The OpenCode MIT license and these notices must remain with redistributed copies
of the combined work.
