# Security Policy

## Supported versions

Only the latest published release of `proton-drive-mcp` receives security fixes.

## Reporting a vulnerability

Report privately via GitHub security advisories:
https://github.com/googlarz/proton-drive-mcp/security/advisories/new

Do not open public issues for vulnerabilities. Expect an initial response within a few days.

## Security model

This MCP server wraps the official `proton-drive` CLI, which holds a live, authenticated Proton session on the machine where it runs. Anyone able to call the server's tools can act as the logged-in user: read, upload, share, trash, and delete files. Consequences:

- Run the server only for MCP clients you trust, and only on machines you trust.
- Treat tool calls that delete, share, or create public links as sensitive; review them in your client.
- File contents and names returned by tools are untrusted input to the model (prompt-injection risk).
- Never share your CLI session data or `PROTON_DRIVE_*` environment with others.
