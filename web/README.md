# Web app / PWA

Phase 5.

Planned stack: SolidJS, Vite, `@solidjs/router`, Kobalte, Tailwind 4, TanStack Solid Query, `vite-plugin-pwa`.

The web app is the primary client and the desktop window's content. It renders state from the daemon and sends commands; it never owns sessions, permissions, memory, or execution.

Planned surfaces:

- login and pairing
- chat with streaming
- approvals inbox
- rule editor
- memory screen and pending writes
- skills and pending diffs
- Gmail, Calendar, and Drive account status
- MCP servers and tool lists
- schedules and briefings
- settings, models, remote access, password rotation, export
- live / reconnecting / asleep / offline / update-required banners
