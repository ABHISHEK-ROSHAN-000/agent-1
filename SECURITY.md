# Security policy

## Supported versions

Agent-1 is pre-release software. Security fixes are applied to the current `main` branch and the latest published release.

## Reporting a vulnerability

Please use GitHub's private vulnerability reporting for this repository:

1. Open the repository's **Security** tab.
2. Choose **Report a vulnerability**.
3. Include the affected version, Windows version, installation method, reproduction steps, and impact.

Do not open a public issue containing a vulnerability, secret, token, cookie, password, prompt, private file, or log with private data.

If private reporting is unavailable, contact the repository owner through GitHub and request a private channel.

## Scope

Relevant areas include:

- daemon API authentication and authorization
- pairing links and session cookies
- permission rules and approvals
- path policy and checkpoint rollback
- shell command execution
- attachment processing and media routes
- remote tunnel handling and host/origin checks
- prompt injection in memory, email, web, file, or MCP content
- dependency and release supply chain

## What to expect

There is no guaranteed response time for this pre-release project. Confirmed issues will be fixed on `main`, and a release will be published when appropriate. Please allow time for a fix before public disclosure.

## Safe research

- Test only against your own local installation.
- Do not access other people's systems, accounts, tunnels, or data.
- Do not include real secrets or private file contents in a report.
- Redact logs and screenshots before sharing them.
