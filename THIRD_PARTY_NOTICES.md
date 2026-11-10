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
`packages/app`. Agent-1 adds its own data layer, routes, authentication,
permission behavior, wordmark, and product names. OpenCode branding, logos, and
telemetry are not used.

## Fonts

The web client bundles or references fonts under the SIL Open Font License 1.1:

- Inter
- IBM Plex Mono
- JetBrains Mono Nerd Font Mono

The OFL text is preserved at `web/src/opencode/OFL-1.1.txt`.

The OpenCode MIT license and these notices must remain with redistributed copies
of the combined work.
