# Third-Party Notices

## OpenCode

Portions of the Agent-1 web client are vendored from the OpenCode repository:

- Source: https://github.com/anomalyco/opencode
- Commit: `30e7a4d573cb8f83d186cef682569cb5758ad8f3`
- License: MIT
- Copyright: Copyright (c) 2025 opencode

The full MIT license is preserved at `web/src/ui-foundation/LICENSE`.

Vendored areas include design tokens, base styles, app surface CSS, icon catalog
data, and presentation patterns from `packages/ui`, `packages/session-ui`, and
`packages/app`, plus the terminal QR encoder in `src/cli/qr.ts` from
`packages/util/src/qr.ts`. Agent-1 adds its own data layer, routes,
authentication, permission behavior, wordmark, and product names. OpenCode
branding, logos, and telemetry are not used.

Attachment materialization, blob/reference handling, image limits, model media
projection, and media read behavior in Phase 8E.5 are ported from the same
OpenCode repository at commit `611cee9d4b667b459f19ca0cbf6e76d8647535fb`
(`packages/schema`, `packages/core/src/session`, `packages/core/src/image`,
and `packages/core/src/tool`). The MIT license above applies.

The QR encoder follows Project Nayuki's MIT-licensed QR Code generator.

## Photon

Image normalization uses `@silvia-odwyer/photon-node` `0.3.4`, licensed
Apache-2.0 (https://github.com/silvia-odwyer/photon). Its license is included in
the installed package at `node_modules/@silvia-odwyer/photon-node/LICENSE.md`.

## Clack

Interactive CLI prompts use `@clack/prompts` and `@clack/core` `1.0.0-alpha.1`,
licensed MIT (https://github.com/bombshell-dev/clack). These are pinned to the
same versions used by the upstream implementation.

## models.dev

`src/models/catalog/models-dev.json` is a pinned snapshot of provider and model
metadata from https://models.dev, licensed MIT. See
`src/models/catalog/README.md`.

## OpenTunnel

Remote access uses `@opentunnel/client` `0.6.2` from
https://github.com/anomalyco/opentunnel, licensed MIT. Agent-1 uses
OpenTunnel's standard/default profile and storage.

## Pierre

The file tree and code/diff viewer use these Apache-2.0 packages:

- `@pierre/trees` `1.0.0-beta.6`
- `@pierre/diffs` `1.6.1`
- `@pierre/highlights` `0.2.0`

Their license texts are preserved at `web/src/ui-foundation/PIERRE-*-LICENSE.md`.
`@pierre/trees` also includes MIT-licensed ideas/code derived from
`@headless-tree/core`; see the upstream NOTICE for attribution.

## Fonts

The web client bundles or references fonts under the SIL Open Font License 1.1:

- Inter
- IBM Plex Mono
- JetBrains Mono Nerd Font Mono

The OFL text is preserved at `web/src/ui-foundation/OFL-1.1.txt`.

The upstream MIT license and these notices must remain with redistributed copies
of the combined work.
