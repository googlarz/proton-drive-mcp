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
- To limit what a model can do, use the opt-in guard layer (`PROTON_DRIVE_MODE=readonly`, `PROTON_DRIVE_REMOTE_ROOTS`, `PROTON_DRIVE_AUDIT_LOG`, `PROTON_DRIVE_SNAPSHOT_BEFORE_OVERWRITE`); see the README. It restricts the MCP server only, not the companion CLI.

## Secure deployment profile

For sensitive files (legal, medical, journalism, client data), start from the narrowest setup and widen only when needed:

```
PROTON_DRIVE_MODE=readonly
PROTON_DRIVE_REMOTE_ROOTS=/my-files/Folder-the-assistant-needs
PROTON_DRIVE_AUDIT_LOG=/absolute/path/outside-your-sync-folder/audit.jsonl
```

Add `PROTON_DRIVE_SNAPSHOT_BEFORE_OVERWRITE=1` if you allow writes. Leave `PROTON_DRIVE_INDEX` and `PROTON_DRIVE_CONTENT_INDEX` off unless you need them: the file-name index is plaintext on disk.

The server's own source has no network code and no telemetry; network traffic comes from the official CLI, your MCP client and your model provider. What reaches the model provider is described in [THREAT_MODEL.md](THREAT_MODEL.md), together with what the controls do not cover.
