# Vendored OpenCode presentation assets

This directory preserves presentation-layer material from OpenCode for the
owner-approved Agent-1 UI port.

- Upstream: `https://github.com/anomalyco/opencode`
- Commit: `30e7a4d573cb8f83d186cef682569cb5758ad8f3`
- License: MIT, see `LICENSE`
- Fonts: SIL OFL 1.1, see `OFL-1.1.txt`

## Copied material

- `styles/` — design tokens, theme/color values, base reset, scrollbars,
  utilities, and animations from `packages/ui/src/styles`.
- `icons/` — the OpenCode icon catalog and SVG sprite renderer from
  `packages/ui/src/icons`.
- `app-css/` — selected application surface CSS from `packages/app/src`
  (titlebar, navigation, project/session rows, wordmark, session header,
  composer lane).
- `session-css/` — selected message, Markdown, tool, file, and review CSS from
  `packages/session-ui/src/components`.

Agent-1 imports the token/base/icon material. The app and session CSS files are
kept as presentation references while the Agent-1 components are wired to the
daemon API. OpenCode branding, telemetry, server client, plugins, terminal,
voice, and multi-server UI are intentionally not included.

The Agent-1 wordmark in `../../wordmark.tsx` is original Agent-1 branding. It
uses the connect/new-session presentation geometry but not OpenCode letterforms
or logos.
