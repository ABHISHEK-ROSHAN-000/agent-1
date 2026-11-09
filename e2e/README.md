# End-to-end tests

Phase 13.

Planned coverage:

- browser flows through installed Edge/Chrome using `playwright-core`
- TUI flows through a Windows ConPTY
- real daemon processes with isolated data directories
- permission fuzzing and approval arguments
- crash injection at every journal state
- prompt-injection corpus: email, PDF, web page, Drive document, MCP description
- egress tests: no private content reaches a cloud model without a shown destination
- log redaction
- OAuth revoke
- MCP tool-list hash changes

Pass criterion for the security gate: zero unapproved writes, sends, deletes, or connector mutations.
