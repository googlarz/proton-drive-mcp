# Changelog

## 1.0.1 — 2026-06-10

### Added
- `drive_mkdir` — create empty folders on Proton Drive
- `drive_list_trash` — list trash contents before emptying or restoring
- `drive_delete` and `drive_empty_trash` now require `confirmed: true` to prevent accidental data loss
- CLI `--json` flag for pipe-friendly single-line output
- CLI `trash list` subcommand
- CLI `mkdir` command
- `smithery.yaml` for MCP registry submission
- Path validation: empty strings are rejected before reaching the CLI
- Email validation on `drive_share_invite`
- Friendly CLI error when `proton-drive` binary is not in PATH
- Upload/download timeout extended to 30 minutes (was 60 seconds)
- `DriveCliError.stderr` shown in CLI error output

## 1.0.0 — 2026-06-10

Initial release.

### MCP Tools
- `drive_auth_status`, `drive_auth_logout`, `drive_version`
- `drive_list`, `drive_upload`, `drive_download`, `drive_move`, `drive_delete`
- `drive_share_status`, `drive_share_invite`, `drive_share_revoke`
- `drive_trash`, `drive_restore`, `drive_empty_trash`

### CLI
- `proton-drive-cli` companion CLI exposing all 14 tools
