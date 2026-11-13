# Vendored presentation assets

This directory preserves the MIT-licensed presentation foundation used by the Agent-1 web client.

- Upstream: `https://github.com/anomalyco/opencode`
- Commit: `30e7a4d573cb8f83d186cef682569cb5758ad8f3`
- License: MIT, see `LICENSE`
- Fonts: SIL OFL 1.1, see `OFL-1.1.txt`

## Included material

- `styles/` — design tokens, theme values, base reset, scrollbars, utilities, and animations.
- `icons/` — the icon catalog and SVG sprite renderer.
- `app-css/` — selected application surface styles.
- `session-css/` — selected message, Markdown, tool, file, and review styles.

Agent-1 imports the token, base, and icon material. App and session styles remain presentation references while Agent-1 components are wired to the daemon API.

The Agent-1 wordmark, data layer, authentication, permissions, and application behavior are original Agent-1 work. Third-party branding, telemetry, server code, plugins, terminal implementation, voice, and multi-server UI are not included.
