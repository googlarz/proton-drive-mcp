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
- Destructive and outward-facing operations (delete, share, public links, accepting invitations, replacing files) need a human yes asked by the server, not by the assistant (`PROTON_DRIVE_APPROVAL`, default `human`). Read what you approve. If your client gives the assistant a shell, it can still run the official `proton-drive` CLI directly; see [THREAT_MODEL.md](THREAT_MODEL.md).
- File contents and names returned by tools are untrusted input to the model (prompt-injection risk).
- Never share your CLI session data or `PROTON_DRIVE_*` environment with others.
- To limit what a model can do, use the opt-in guard layer (`PROTON_DRIVE_MODE=readonly`, `PROTON_DRIVE_REMOTE_ROOTS`, `PROTON_DRIVE_AUDIT_LOG`, `PROTON_DRIVE_SNAPSHOT_BEFORE_OVERWRITE`) and the approval setting `PROTON_DRIVE_APPROVAL`; see the README. It restricts the MCP server only, not the companion CLI.

## Secure deployment profile

For sensitive files (legal, medical, journalism, client data), start from the narrowest setup and widen only when needed:

```
PROTON_DRIVE_MODE=readonly
PROTON_DRIVE_REMOTE_ROOTS=/my-files/Folder-the-assistant-needs
PROTON_DRIVE_AUDIT_LOG=/absolute/path/outside-your-sync-folder/audit.jsonl
PROTON_DRIVE_APPROVAL=strict
```

`PROTON_DRIVE_APPROVAL=strict` makes every change need your approval once writes are allowed (it does nothing while readonly is on). Never set `PROTON_DRIVE_APPROVAL=model` for sensitive data: it lets the assistant approve its own operations. Add `PROTON_DRIVE_SNAPSHOT_BEFORE_OVERWRITE=1` if you allow writes. Leave `PROTON_DRIVE_INDEX` and `PROTON_DRIVE_CONTENT_INDEX` off unless you need them: the file-name index is plaintext on disk. The undo record (`drive_undo`, on by default once writes are allowed) is plaintext too: it holds the names of the items you changed for 30 days. Set `PROTON_DRIVE_UNDO=0` if that is not acceptable for your data; the cost is that there is no undo. `drive_cleanup` and `drive_undo` are hidden while `PROTON_DRIVE_MODE=readonly` is on, and `drive_undo` always asks you to approve before it changes anything.

The server's own source has no network code and no telemetry; network traffic comes from the official CLI, your MCP client and your model provider. What reaches the model provider is described in [THREAT_MODEL.md](THREAT_MODEL.md), together with what the controls do not cover.
